import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Where the CRM outbox is fed from outside the inquiry, saga and refund
 * paths (review C2A-03, C2A-02), read from the source: each hook is the
 * last write of its own transaction. What the enqueue writes is covered by
 * crm.outbox.unit.test.ts and the DB suite; this pins that the hooks exist.
 */

const file = (p: string) => path.join(process.cwd(), p);
const DOCS = file("src/server/services/document.service.ts");

describe.skipIf(!existsSync(DOCS))("CRM hooks", () => {
  it("document validity changes queue a deal push: codes persisted, PDF valid, PDF quarantined (C2A-03)", () => {
    const src = readFileSync(DOCS, "utf8");
    expect(src).toMatch(/import \{ enqueueCrmSyncForOrders \} from "\.\.\/crm\/crm\.outbox"/);
    expect(src.match(/await enqueueCrmSyncForOrders\(tx, \[(?:booking|doc)\.orderId\]\)/g)).toHaveLength(3);
  });

  it("a marketing consent row queues a push for the contact's linked deals (C2A-02)", () => {
    const src = readFileSync(file("src/server/repositories/consent.repo.ts"), "utf8");
    expect(src).toContain("enqueueCrmSyncForContact(t,");
    expect(src).toMatch(/input\.purpose === "marketing"/);
  });
});
