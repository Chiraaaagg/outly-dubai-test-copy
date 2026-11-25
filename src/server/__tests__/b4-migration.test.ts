import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { uuidv7 } from "../lib/ids";
import { dbEnabled, runId } from "./helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "./helpers/target-guard";

/**
 * Migration 20261102110000_b4_tickets_documents_delivery on the disposable
 * database: RLS and no API-role grants on the new tables; the
 * supplier_documents checks (kind, status, source, version, sha256, storage
 * key shape, codes have no object, a valid PDF is complete), one valid
 * version per booking and kind, a document's order and item are its
 * booking's; the ticket-code checks (v2 ciphertext of the ticket_codes ring
 * under the key id it names, hash shape, unit), codes belong to a
 * ticket_codes document of the same booking, and code rows change only by a
 * key re-wrap.
 *
 * Every row is synthetic and written inside a transaction that is always
 * rolled back. Codes are random strings encrypted with the test key ring.
 */

type Prisma = typeof import("../lib/db").prisma;
type Tx = Parameters<Parameters<Prisma["$transaction"]>[0]>[0];

const NEW_TABLES = ["supplier_documents", "supplier_ticket_codes", "guest_capability_grants", "suppressed_contacts"];
const API_ROLES = ["anon", "authenticated"];
const ROLLBACK = new Error("ROLLBACK");
const CHECK_VIOLATION = /23514|violates check constraint|check_violation|supplier_documents: |supplier_ticket_codes: /;
const UNIQUE_VIOLATION = /23505|Unique constraint|duplicate key/;
const TX = { maxWait: 20_000, timeout: 30_000 } as const;
const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const key = () => `test/${randomBytes(16).toString("hex")}`;

async function rolledBack(prisma: Prisma, fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    }, TX);
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

/** A savepoint, so an expected constraint error does not abort the outer transaction. */
async function refused(tx: Tx, sql: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await tx.$executeRawUnsafe("SAVEPOINT b4_probe");
  let error: unknown = null;
  try {
    await sql();
  } catch (e) {
    error = e;
  }
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT b4_probe");
  expect(String(error)).toMatch(pattern);
}

async function accepted(tx: Tx, sql: () => Promise<unknown>): Promise<void> {
  await tx.$executeRawUnsafe("SAVEPOINT b4_probe");
  await sql();
  await tx.$executeRawUnsafe("RELEASE SAVEPOINT b4_probe");
}

describe.skipIf(!dbEnabled)("migration 20261102110000: B4 tickets, documents and delivery", () => {
  let prisma: Prisma;
  let crypto: typeof import("../lib/crypto");
  const run = runId();

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../lib/db"));
    await assertDisposableDbLive(prisma);
    crypto = await import("../lib/crypto");
  });

  afterAll(async () => {
    crypto?.setKeyRingsForTests(null);
    await prisma?.$disconnect();
  });

  /** Supplier, order, item and a booking for that item; a second order and booking for mismatch checks. */
  async function fixture(tx: Tx) {
    const supplierId = uuidv7();
    await tx.supplier.create({ data: { id: supplierId, code: `zz-b4-${run}-${uuidv7().slice(-6)}`, name: "test-b4", source: "api", adapter: "traveldesk" } });
    const order = async () => {
      const guest = await tx.guest.create({ data: { id: uuidv7(), phoneE164: "+910000000000", fullName: "test-b4" } });
      const combo = await tx.combo.create({ data: { id: uuidv7(), slug: `zz-b4-${run}-${uuidv7().slice(-8)}`, name: "test-b4", confirmation: "manual" } });
      const o = await tx.order.create({
        data: { id: uuidv7(), reference: `OUT-TEST${Math.floor(Math.random() * 1e9)}`, rail: "assisted", guestId: guest.id, currency: "AED", subtotalInr: 0n, subtotalAed: 1000n, totalInr: 0n, totalAed: 1000n, leadName: "test-b4", leadPhone: "+910000000000" },
      });
      const item = await tx.orderItem.create({
        data: {
          id: uuidv7(), orderId: o.id, comboId: combo.id, titleSnapshot: "test-b4", tierSnapshot: "C", slugSnapshot: combo.slug, kindSnapshot: "combo", confirmationSnapshot: "manual",
          fulfilmentModeSnapshot: "inquiry", freeCancellationHoursSnapshot: 24, durationMinutesSnapshot: 60, serviceDate: new Date("2030-01-15"), pax: { adult: 1 }, unitInr: 0n, unitAed: 1000n, totalInr: 0n, totalAed: 1000n,
        },
      });
      const b = await tx.supplierBooking.create({
        data: {
          id: uuidv7(), orderId: o.id, orderItemId: item.id, supplierId, environment: "test", idempotencyKey: `b4-${run}-${uuidv7()}`, clientRef: `OUTTD-B4${uuidv7().slice(-12)}`,
          bookingKind: "live_book", afterReserve: "await_payment", state: "confirmed", tourExternalId: "1", offerExternalId: "1", serviceDate: new Date("2030-01-15"),
          adults: 1, guestName: "test-b4", expectedNetMinor: 1000n, expectedNetUsdMinor: 270n,
        },
      });
      return { orderId: o.id, itemId: item.id, bookingId: b.id };
    };
    return { a: await order(), b: await order() };
  }

  function doc(tx: Tx, f: { orderId: string | null; itemId: string | null; bookingId: string }, d: Record<string, unknown> = {}) {
    const id = (d.id as string) ?? uuidv7();
    return tx.$executeRaw`
      INSERT INTO supplier_documents (id, supplier_booking_id, order_id, order_item_id, kind, version, status, source, storage_key, sha256, byte_size, content_type)
      VALUES (${id}::uuid, ${f.bookingId}::uuid, ${f.orderId}::uuid, ${f.itemId}::uuid, ${(d.kind as string) ?? "ticket_codes"}, ${(d.version as number) ?? 1},
              ${(d.status as string) ?? "pending"}, ${(d.source as string) ?? "document_read"}, ${(d.storageKey as string | null) ?? null}, ${(d.sha256 as string | null) ?? null},
              ${(d.byteSize as number | null) ?? null}, ${(d.contentType as string | null) ?? null})`;
  }

  function code(tx: Tx, c: { documentId: string; bookingId: string; unit?: number; ticketFor?: string; ciphertext: string; keyId: string; hash?: string; id?: string }) {
    return tx.$executeRaw`
      INSERT INTO supplier_ticket_codes (id, document_id, supplier_booking_id, unit_index, ticket_for, code_ciphertext, code_key_id, code_hash)
      VALUES (${c.id ?? uuidv7()}::uuid, ${c.documentId}::uuid, ${c.bookingId}::uuid, ${c.unit ?? 0}, ${c.ticketFor ?? "adult"}, ${c.ciphertext}, ${c.keyId}, ${c.hash ?? hex(c.ciphertext)})`;
  }

  it("the new tables have row level security on and no Supabase API-role privilege", async () => {
    const rows = await prisma.$queryRaw<Array<{ name: string; rls: boolean }>>`
      SELECT c.relname::text AS name, c.relrowsecurity AS rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY(${NEW_TABLES}::text[]) ORDER BY 1`;
    expect(rows).toEqual([...NEW_TABLES].sort().map((name) => ({ name, rls: true })));
    const roles = await prisma.$queryRaw<Array<{ rolname: string }>>`SELECT rolname::text AS rolname FROM pg_roles WHERE rolname = ANY(${API_ROLES}::text[]) ORDER BY 1`;
    expect(roles.map((r) => r.rolname)).toEqual(API_ROLES);
    for (const role of API_ROLES) {
      const granted = await prisma.$queryRaw<Array<{ name: string }>>`
        SELECT t AS name FROM unnest(${NEW_TABLES}::text[]) AS t
        WHERE has_table_privilege(${role}, ('public.' || t)::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`;
      expect(granted, role).toEqual([]);
    }
  });

  it("supplier_documents checks: vocabularies, version, checksum and the storage key shape", async () => {
    await rolledBack(prisma, async (tx) => {
      const { a } = await fixture(tx);
      await refused(tx, () => doc(tx, a, { kind: "invoice" }), CHECK_VIOLATION);
      await refused(tx, () => doc(tx, a, { status: "served" }), CHECK_VIOLATION);
      await refused(tx, () => doc(tx, a, { source: "email" }), CHECK_VIOLATION);
      await refused(tx, () => doc(tx, a, { version: 0 }), CHECK_VIOLATION);
      await refused(tx, () => doc(tx, a, { kind: "tickets_pdf", source: "pdf_download", sha256: "ABC" }), CHECK_VIOLATION);
      await refused(tx, () => doc(tx, a, { kind: "tickets_pdf", source: "pdf_download", byteSize: -1 }), CHECK_VIOLATION);
      // Object keys are `<env>/<32 hex>` and nothing else (TKT-3).
      for (const bad of ["test/abc", "staging/" + "a".repeat(32), "test/" + "A".repeat(32), `test/${"a".repeat(32)}/x`, `test/OUT-1234-${"a".repeat(20)}`, "a".repeat(32)]) {
        await refused(tx, () => doc(tx, a, { kind: "tickets_pdf", source: "pdf_download", storageKey: bad }), CHECK_VIOLATION);
      }
      for (const [i, env] of ["test", "production", "development"].entries()) {
        await accepted(tx, () => doc(tx, a, { kind: "tickets_pdf", source: "pdf_download", version: i + 1, storageKey: `${env}/${randomBytes(16).toString("hex")}` }));
      }
      // The code set has no object; a valid PDF has its object, size and checksum.
      await refused(tx, () => doc(tx, a, { kind: "ticket_codes", storageKey: key(), version: 9 }), CHECK_VIOLATION);
      await refused(tx, () => doc(tx, a, { kind: "tickets_pdf", source: "pdf_download", status: "valid", version: 9 }), CHECK_VIOLATION);
      await refused(tx, () => doc(tx, a, { kind: "tickets_pdf", source: "pdf_download", status: "valid", version: 9, storageKey: key(), byteSize: 10 }), CHECK_VIOLATION);
      await accepted(tx, () => doc(tx, a, { kind: "tickets_pdf", source: "pdf_download", status: "valid", version: 9, storageKey: key(), byteSize: 10, sha256: hex("x"), contentType: "application/pdf" }));
      // Keys are unique; versions are unique per booking and kind.
      const k = key();
      await accepted(tx, () => doc(tx, a, { kind: "voucher_pdf", source: "pdf_download", storageKey: k }));
      await refused(tx, () => doc(tx, a, { kind: "voucher_pdf", source: "pdf_download", version: 2, storageKey: k }), UNIQUE_VIOLATION);
      await refused(tx, () => doc(tx, a, { kind: "voucher_pdf", source: "pdf_download" }), UNIQUE_VIOLATION);
    });
  });

  it("at most one valid version per booking and kind; a reissue supersedes first", async () => {
    await rolledBack(prisma, async (tx) => {
      const { a, b } = await fixture(tx);
      const v1 = uuidv7();
      await accepted(tx, () => doc(tx, a, { id: v1, status: "valid" }));
      await refused(tx, () => doc(tx, a, { version: 2, status: "valid" }), UNIQUE_VIOLATION);
      // Another kind, and another booking, are independent.
      await accepted(tx, () => doc(tx, a, { kind: "tickets_pdf", source: "pdf_download", status: "valid", storageKey: key(), byteSize: 1, sha256: hex("p") }));
      await accepted(tx, () => doc(tx, b, { status: "valid" }));
      await tx.$executeRaw`UPDATE supplier_documents SET status = 'superseded', invalidated_at = now() WHERE id = ${v1}::uuid`;
      await accepted(tx, () => doc(tx, a, { version: 2, status: "valid" }));
      await accepted(tx, () => doc(tx, a, { version: 3, status: "quarantined" }));
      await accepted(tx, () => doc(tx, a, { version: 4, status: "quarantined" }));
    });
  });

  it("a document's order and item are its booking's, never another order's", async () => {
    await rolledBack(prisma, async (tx) => {
      const { a, b } = await fixture(tx);
      await refused(tx, () => doc(tx, { ...a, orderId: b.orderId }), CHECK_VIOLATION);
      await refused(tx, () => doc(tx, { ...a, itemId: b.itemId }), CHECK_VIOLATION);
      await refused(tx, () => doc(tx, { ...a, orderId: null, itemId: null }), CHECK_VIOLATION);
      const id = uuidv7();
      await accepted(tx, () => doc(tx, a, { id }));
      await refused(tx, () => tx.$executeRaw`UPDATE supplier_documents SET order_id = ${b.orderId}::uuid WHERE id = ${id}::uuid`, CHECK_VIOLATION);
      await refused(tx, () => tx.$executeRaw`UPDATE supplier_documents SET supplier_booking_id = ${b.bookingId}::uuid WHERE id = ${id}::uuid`, CHECK_VIOLATION);
    });
  });

  it("codes are only v2 ciphertext of the ticket_codes ring under the key id they name, on a codes document of the same booking", async () => {
    await rolledBack(prisma, async (tx) => {
      const { a, b } = await fixture(tx);
      const codesDoc = uuidv7();
      const pdfDoc = uuidv7();
      const otherDoc = uuidv7();
      await doc(tx, a, { id: codesDoc });
      await doc(tx, a, { id: pdfDoc, kind: "tickets_pdf", source: "pdf_download" });
      await doc(tx, b, { id: otherDoc });
      const plain = `ZZ-${run}-CODE`;
      const ct = crypto.encryptFor("ticket_codes", plain);
      const keyId = crypto.ciphertextKeyId(ct);
      const hash = crypto.hmacFor("ticket_code_hash", plain);

      await refused(tx, () => code(tx, { documentId: codesDoc, bookingId: a.bookingId, ciphertext: plain, keyId: "dev", hash }), CHECK_VIOLATION);
      await refused(tx, () => code(tx, { documentId: codesDoc, bookingId: a.bookingId, ciphertext: crypto.encryptFor("capability_tokens", plain), keyId: "dev", hash }), CHECK_VIOLATION);
      await refused(tx, () => code(tx, { documentId: codesDoc, bookingId: a.bookingId, ciphertext: crypto.encryptSecret(plain), keyId: "dev", hash }), CHECK_VIOLATION);
      await refused(tx, () => code(tx, { documentId: codesDoc, bookingId: a.bookingId, ciphertext: ct, keyId: `${keyId}x`, hash }), CHECK_VIOLATION);
      await refused(tx, () => code(tx, { documentId: codesDoc, bookingId: a.bookingId, ciphertext: ct, keyId, hash: "not-a-hash" }), CHECK_VIOLATION);
      await refused(tx, () => code(tx, { documentId: codesDoc, bookingId: a.bookingId, ciphertext: ct, keyId, hash, unit: -1 }), CHECK_VIOLATION);
      await refused(tx, () => code(tx, { documentId: codesDoc, bookingId: a.bookingId, ciphertext: ct, keyId, hash, ticketFor: "senior" }), CHECK_VIOLATION);
      // Only a ticket_codes document, and only of the same booking.
      await refused(tx, () => code(tx, { documentId: pdfDoc, bookingId: a.bookingId, ciphertext: ct, keyId, hash }), CHECK_VIOLATION);
      await refused(tx, () => code(tx, { documentId: otherDoc, bookingId: a.bookingId, ciphertext: ct, keyId, hash }), CHECK_VIOLATION);
      await refused(tx, () => code(tx, { documentId: codesDoc, bookingId: b.bookingId, ciphertext: ct, keyId, hash }), CHECK_VIOLATION);
      await accepted(tx, () => code(tx, { documentId: codesDoc, bookingId: a.bookingId, ciphertext: ct, keyId, hash }));
      await refused(tx, () => code(tx, { documentId: codesDoc, bookingId: a.bookingId, ciphertext: crypto.encryptFor("ticket_codes", "other"), keyId, hash }), UNIQUE_VIOLATION);
    });
  });

  it("a code row changes only by a key re-wrap; deleting is allowed", async () => {
    await rolledBack(prisma, async (tx) => {
      const { a } = await fixture(tx);
      const codesDoc = uuidv7();
      await doc(tx, a, { id: codesDoc });
      const plain = `ZZ-${run}-WRAP`;
      const k1 = `k1:${randomBytes(32).toString("base64")}`;
      const k2 = `k2:${randomBytes(32).toString("base64")}`;
      const id = uuidv7();
      try {
        crypto.setKeyRingsForTests({ ticket_codes: k1 });
        const ct = crypto.encryptFor("ticket_codes", plain);
        expect(crypto.ciphertextKeyId(ct)).toBe("k1");
        await code(tx, { id, documentId: codesDoc, bookingId: a.bookingId, ciphertext: ct, keyId: "k1", hash: crypto.hmacFor("ticket_code_hash", plain) });

        await refused(tx, () => tx.$executeRaw`UPDATE supplier_ticket_codes SET ticket_for = 'child' WHERE id = ${id}::uuid`, CHECK_VIOLATION);
        await refused(tx, () => tx.$executeRaw`UPDATE supplier_ticket_codes SET code_hash = ${hex("other")} WHERE id = ${id}::uuid`, CHECK_VIOLATION);
        await refused(tx, () => tx.$executeRaw`UPDATE supplier_ticket_codes SET unit_index = 3 WHERE id = ${id}::uuid`, CHECK_VIOLATION);

        // Rotation: k2 in front, k1 still decrypts. The re-wrap changes ciphertext and key id together.
        crypto.setKeyRingsForTests({ ticket_codes: `${k2},${k1}` });
        const wrapped = crypto.rewrapFor("ticket_codes", ct);
        expect(crypto.ciphertextKeyId(wrapped)).toBe("k2");
        await accepted(tx, () => tx.$executeRaw`UPDATE supplier_ticket_codes SET code_ciphertext = ${wrapped}, code_key_id = 'k2' WHERE id = ${id}::uuid`);
        const [row] = await tx.$queryRaw<{ c: string }[]>`SELECT code_ciphertext AS c FROM supplier_ticket_codes WHERE id = ${id}::uuid`;
        expect(crypto.decryptFor("ticket_codes", row.c)).toBe(plain);
        // Still checked: a re-wrap cannot relabel the key.
        await refused(tx, () => tx.$executeRaw`UPDATE supplier_ticket_codes SET code_key_id = 'k1' WHERE id = ${id}::uuid`, CHECK_VIOLATION);
      } finally {
        crypto.setKeyRingsForTests(null);
      }
      await accepted(tx, () => tx.$executeRaw`DELETE FROM supplier_ticket_codes WHERE id = ${id}::uuid`);
    });
  });
});
