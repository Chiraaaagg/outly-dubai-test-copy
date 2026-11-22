import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Customer copy while verification codes may go by email (doc 29 §7.3 Batch
 * 0; owner decisions §8.4 rows 9 and 10). The checkout page is a large client
 * component with no render harness, so its copy is pinned on the source.
 * Wording that promises a text message is untrue when the code goes by
 * email; the pickup hint must not invite an empty hotel, which the supplier
 * quote refuses.
 */
const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const FILES = [
  "src/app/checkout/page.tsx",
  "src/components/commerce/order-status/order-status-view.tsx",
  "src/components/commerce/order-status/recovery-form.tsx",
  "src/components/checkout/otp-verification-card.tsx",
];

describe("checkout verification copy is channel-neutral", () => {
  it.each(FILES)("%s promises no text message", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/We text|we text|Text me a code|sent by SMS|Verify number/);
  });

  it("the pay button reads Confirm and pay (conflict C1, approved)", () => {
    const src = read("src/app/checkout/page.tsx");
    expect(src).toContain("`Confirm and pay ${charge}`");
    expect(src).toContain("`Confirm and pay ${charge} deposit`");
  });

  it("the pickup hint no longer suggests leaving the hotel empty", () => {
    const src = read("src/app/checkout/page.tsx");
    expect(src).not.toContain("Leave it and tell us later");
    expect(src).toContain('label="Hotel for pickup"');
  });
});
