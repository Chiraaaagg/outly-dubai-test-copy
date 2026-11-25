import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { assertDisposableDb, dbEnabled, runId } from "@/server/__tests__/helpers/fixtures";
import { assertDisposableDbLive } from "@/server/__tests__/helpers/target-guard";
import { IssuedTicketSet } from "@/server/documents/contracts";
import { carryConfirmedBooking, carrySupplier, carryTicket } from "./carry-fixtures";

/**
 * Re-wrap of stored ciphertexts after a ring rotation (doc 22 §32.9
 * R-B4-10), against the disposable database: ticket codes (through the
 * table's re-wrap-only trigger) and kept capability tokens move to the
 * active key; the step is bounded, idempotent, and never resurrects a
 * cleared token. Key ids are scoped to this run, so rows of other suites
 * (under other keys) are never selected.
 */

const run = runId();
const OLD = `o${run}`;
const NEW = `n${run}`;
const key = () => randomBytes(32).toString("base64");
const OLD_RING = `${OLD}:${key()}`;
const ROTATED_RING = `${NEW}:${key()},${OLD_RING}`;

let prisma: typeof import("@/server/lib/db").prisma;
let crypto: typeof import("@/server/lib/crypto");
let documents: typeof import("@/server/services/document.service").documentService;
let capability: typeof import("@/server/services/capability.service").capabilityService;
let rewrap: typeof import("@/server/services/key-rewrap.service");
let supplierId: string;
const orderIds: string[] = [];

async function bookingWithCodes(codes: string[]) {
  const b = await carryConfirmedBooking(prisma, run, supplierId, { adults: codes.length });
  orderIds.push(b.orderId!);
  const set = new IssuedTicketSet(codes.map((c, i) => carryTicket(i, c)), "confirm_response");
  await prisma.$transaction((tx) => documents.persistIssuedTickets(tx, b, set, new Date()));
  return b;
}

describe.skipIf(!dbEnabled)("B5 carry-over: key re-wrap step (R-B4-10)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    prisma = (await import("@/server/lib/db")).prisma;
    await assertDisposableDbLive(prisma);
    crypto = await import("@/server/lib/crypto");
    documents = (await import("@/server/services/document.service")).documentService;
    capability = (await import("@/server/services/capability.service")).capabilityService;
    rewrap = await import("@/server/services/key-rewrap.service");
    supplierId = (await carrySupplier(prisma, run)).id;
  });

  // Each test starts a pass from the first id (the cursor is shared state in `settings`).
  const resetCursors = () => prisma.setting.deleteMany({ where: { key: { in: [rewrap.cursorKey("ticket_codes"), rewrap.cursorKey("capability_tokens")] } } });
  beforeEach(async () => {
    await resetCursors();
  });

  afterEach(() => crypto.setKeyRingsForTests(null));

  afterAll(async () => {
    crypto?.setKeyRingsForTests(null);
    if (!prisma) return;
    // Retire the PDF rows the valid code sets queued, so no documents job reads them.
    await prisma.supplierDocument.updateMany({ where: { supplierBooking: { supplierId }, status: { in: ["pending", "incomplete"] } }, data: { status: "failed", nextFetchAt: null, lockedUntil: null } });
    await prisma.guestCapabilityGrant.deleteMany({ where: { orderId: { in: orderIds } } });
    await resetCursors();
  });

  it("ticket codes and kept tokens under the old key move to the active key; a second run does nothing", async () => {
    crypto.setKeyRingsForTests({ ticket_codes: OLD_RING, capability_tokens: OLD_RING });
    const codes = [`R-${run}-1`, `R-${run}-2`];
    const b = await bookingWithCodes(codes);
    const before = await prisma.supplierTicketCode.findMany({ where: { supplierBookingId: b.id }, orderBy: { unitIndex: "asc" } });
    expect(before.map((c) => c.codeKeyId)).toEqual([OLD, OLD]);

    const kept = await capability.mint(prisma, { orderId: b.orderId!, purpose: "download_tickets", issuedFor: "ticket_notification", keepForRetry: true });
    const cleared = await capability.mint(prisma, { orderId: b.orderId!, purpose: "view_status", issuedFor: "status_notification", keepForRetry: true });
    await capability.clearCiphertext(cleared.grantId);

    crypto.setKeyRingsForTests({ ticket_codes: ROTATED_RING, capability_tokens: ROTATED_RING });
    const r = await rewrap.keyRewrapService.run(50);
    expect(r.ticketCodes).toEqual({ scanned: 2, rewrapped: 2, raced: 0, failed: 0 });
    expect(r.capabilityTokens).toEqual({ scanned: 1, rewrapped: 1, raced: 0, failed: 0 });

    const after = await prisma.supplierTicketCode.findMany({ where: { supplierBookingId: b.id }, orderBy: { unitIndex: "asc" } });
    expect(after.map((c) => c.codeKeyId)).toEqual([NEW, NEW]);
    expect(after.map((c) => crypto.decryptFor("ticket_codes", c.codeCiphertext))).toEqual(codes);
    // Only the ciphertext and its key id changed (the trigger enforces it; checked here too).
    expect(after.map((c) => ({ ...c, codeCiphertext: "", codeKeyId: "" }))).toEqual(before.map((c) => ({ ...c, codeCiphertext: "", codeKeyId: "" })));

    const grant = await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: kept.grantId } });
    expect(crypto.ciphertextKeyId(grant.tokenCiphertext!)).toBe(NEW);
    expect(await capability.tokenForRetry(kept.grantId)).toBe(kept.token);
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: cleared.grantId } })).tokenCiphertext).toBeNull();

    // Idempotent.
    expect(await rewrap.keyRewrapService.run(50)).toEqual({ ticketCodes: { scanned: 0, rewrapped: 0, raced: 0, failed: 0 }, capabilityTokens: { scanned: 0, rewrapped: 0, raced: 0, failed: 0 } });
    // The old key can now be dropped: everything still opens.
    crypto.setKeyRingsForTests({ ticket_codes: ROTATED_RING.split(",")[0], capability_tokens: ROTATED_RING.split(",")[0] });
    expect(await capability.tokenForRetry(kept.grantId)).toBe(kept.token);
  });

  it("is bounded: the budget caps rows per run across both columns, and the rest follow on the next run", async () => {
    crypto.setKeyRingsForTests({ ticket_codes: OLD_RING, capability_tokens: OLD_RING });
    await bookingWithCodes([`B-${run}-1`, `B-${run}-2`, `B-${run}-3`]);
    crypto.setKeyRingsForTests({ ticket_codes: ROTATED_RING, capability_tokens: ROTATED_RING });
    const first = await rewrap.keyRewrapService.run(2);
    expect(first.ticketCodes.scanned + first.capabilityTokens.scanned).toBe(2);
    const second = await rewrap.keyRewrapService.run(2);
    expect(second.ticketCodes).toMatchObject({ scanned: 1, rewrapped: 1 });
    expect((await rewrap.keyRewrapService.run(2)).ticketCodes.scanned).toBe(0);
  });

  it("a ring with nothing older does nothing, and a missing ring is reported, never thrown", async () => {
    crypto.setKeyRingsForTests({ ticket_codes: `${NEW}:${key()}`, capability_tokens: `${NEW}:${key()}` });
    expect((await rewrap.keyRewrapService.run(10)).ticketCodes.scanned).toBe(0);
    crypto.setKeyRingsForTests({ ticket_codes: null, capability_tokens: null });
    await expect(rewrap.keyRewrapService.run(10)).resolves.toEqual({
      ticketCodes: { scanned: 0, rewrapped: 0, raced: 0, failed: 0 },
      capabilityTokens: { scanned: 0, rewrapped: 0, raced: 0, failed: 0 },
    });
  });

  it("a row under an older ring key that does not open is counted as failed and left as it is", async () => {
    crypto.setKeyRingsForTests({ ticket_codes: OLD_RING });
    const b = await bookingWithCodes([`F-${run}-1`]);
    const row = await prisma.supplierTicketCode.findFirstOrThrow({ where: { supplierBookingId: b.id } });
    // Same key id, different key material: authenticates under neither.
    const otherOld = `${OLD}:${key()}`;
    crypto.setKeyRingsForTests({ ticket_codes: `${NEW}:${key()},${otherOld}` });
    const r = await rewrap.keyRewrapService.run(50);
    expect(r.ticketCodes.failed).toBeGreaterThanOrEqual(1);
    expect(await prisma.supplierTicketCode.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ codeCiphertext: row.codeCiphertext, codeKeyId: OLD });
  });
  it("rows that fail to open never starve the rest: 25 unopenable rows, then re-wrappable ones, budget 20 (R-B5-11)", async () => {
    // Earlier tests may have left re-wrappable rows under this run's old key: clear them first.
    crypto.setKeyRingsForTests({ ticket_codes: ROTATED_RING, capability_tokens: ROTATED_RING });
    await rewrap.keyRewrapService.run(1000);
    await resetCursors();
    // 25 codes under this run's old key id but other key material: they authenticate under nothing in the ring.
    crypto.setKeyRingsForTests({ ticket_codes: `${OLD}:${key()}` });
    const bad = await bookingWithCodes(Array.from({ length: 25 }, (_, i) => `S-${run}-bad-${i}`));
    crypto.setKeyRingsForTests({ ticket_codes: OLD_RING });
    const good = await bookingWithCodes([`S-${run}-ok-1`, `S-${run}-ok-2`, `S-${run}-ok-3`]);
    // Ids are time-ordered: every unopenable row comes before the good ones.
    crypto.setKeyRingsForTests({ ticket_codes: ROTATED_RING, capability_tokens: ROTATED_RING });

    const first = await rewrap.keyRewrapService.run(20);
    expect(first.ticketCodes).toMatchObject({ scanned: 20, rewrapped: 0 });
    expect(first.ticketCodes.failed).toBe(20);

    // The next run continues after the cursor: the 5 remaining bad rows and the 3 good ones.
    const second = await rewrap.keyRewrapService.run(20);
    expect(second.ticketCodes.rewrapped).toBe(3);
    const goodRows = await prisma.supplierTicketCode.findMany({ where: { supplierBookingId: good.id } });
    expect(goodRows.map((r) => r.codeKeyId)).toEqual([NEW, NEW, NEW]);

    // The end was reached: the next pass starts again from the first id and re-wraps nothing new.
    const third = await rewrap.keyRewrapService.run(20);
    expect(third.ticketCodes.rewrapped).toBe(0);
    expect(await prisma.supplierTicketCode.count({ where: { supplierBookingId: bad.id, codeKeyId: OLD } })).toBe(25);
    // The cursor holds a row id only.
    const cursor = await prisma.setting.findUnique({ where: { key: rewrap.cursorKey("ticket_codes") } });
    expect(Object.keys((cursor?.value ?? {}) as object)).toEqual(["afterId"]);
  });
});
