import type { Reporter, TestModule } from "vitest/node";
import { isSupabaseLocalTarget, PG17_ONLY_SUITES } from "./vitest.suites.mjs";

/**
 * With OUTLY_REQUIRE_DB=1, a skipped test in the `db` or `render` project is a
 * failure: those suites skip only when their database or server is missing,
 * and a missing gate must not read as green. The one exception is explicit:
 * a suite listed in PG17_ONLY_SUITES (vitest.suites.mjs) is reported as
 * deliberately excluded, with its reason, when the target is the local
 * Supabase stack (OUTLY_TEST_SUPABASE_LOCAL=1), and only then.
 */
export default class NoSkipReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    if (process.env.OUTLY_REQUIRE_DB !== "1") return;
    const skipped: string[] = [];
    // Only on the local Supabase stack, and only the named PG17-only suites (vitest.suites.mjs), with their reason.
    const excludable: Record<string, string> = isSupabaseLocalTarget() ? PG17_ONLY_SUITES : {};
    const excluded = new Map<string, number>();
    for (const mod of testModules) {
      if (mod.project.name === "unit") continue;
      const file = mod.moduleId.replace(`${process.cwd()}/`, "");
      for (const t of mod.children.allTests()) {
        if (t.result().state !== "skipped") continue;
        if (file in excludable) excluded.set(file, (excluded.get(file) ?? 0) + 1);
        else skipped.push(`${file} > ${t.fullName}`);
      }
    }
    for (const [file, n] of excluded) console.log(`\nOUTLY_REQUIRE_DB=1: ${file} (${n} tests) deliberately excluded on the local Supabase stack: ${excludable[file]}`);
    if (!skipped.length) return;
    console.error(`\nOUTLY_REQUIRE_DB=1: ${skipped.length} skipped test(s) count as failures:\n  ${skipped.slice(0, 20).join("\n  ")}${skipped.length > 20 ? "\n  ..." : ""}\n`);
    process.exitCode = 1;
  }
}
