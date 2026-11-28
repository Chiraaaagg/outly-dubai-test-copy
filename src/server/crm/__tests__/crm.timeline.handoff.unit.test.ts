import { describe, expect, it } from "vitest";
import { HANDOFF_ERROR_CODES } from "@/server/crm/crm.timeline";
import { EXTERNAL_FAILED_AFTER_CONFIRM_CODE, EXTERNAL_HANDOFF_CODE, EXTERNAL_PAST_START_CODE } from "@/server/suppliers/external-confirmation";

/**
 * The "handed to the team" moment (C2b, R-01) reads the hand-off codes the external-confirmation flow sets
 * (Batch 6). crm.timeline.ts keeps its own copy so the CRM module imports no supplier code (doc 29e §3.7); this
 * test fails the build when the two lists drift apart.
 */
describe("hand-off codes", () => {
  it("are exactly the external-confirmation flow's own codes", () => {
    expect([...HANDOFF_ERROR_CODES].sort()).toEqual([EXTERNAL_HANDOFF_CODE, EXTERNAL_PAST_START_CODE, EXTERNAL_FAILED_AFTER_CONFIRM_CODE].sort());
  });
});
