import "server-only";
import { dubaiToday } from "@/lib/utils";
import { TtlCache } from "../suppliers/cache";
import type { ListedStart } from "../suppliers/traveldesk/traveldesk.quote";
import { activeVariants, mappingForVariant, readinessService, type ReadinessServiceImpl } from "./readiness.service";
import { supplierQuoteService, type SupplierStartTimesReader } from "./supplier-quote.service";

/**
 * Public start times for a product variant on a date (doc 29 Batch 2, §3.2
 * "Listed starts", §6.3, §6.5). Read by `GET /api/catalog/start-times`.
 *
 * Only for a product that readiness sells instantly and whose mapped offer
 * sells as listed starts (`listedStartsSellable`: its exact listed-start
 * class key is switched on, evidence where asked). Everything else answers
 * `stored`, and the page keeps the start times it already shows, so with the
 * Batch 2 flags off this read makes no supplier call at all. A date-only
 * offer (doc 29 Batch 7, `dateOnlySellable`) is read the same way; it answers
 * `supplier` only when the date has several starts, else `stored`
 * (`not_listed`) and the guest picks only the date.
 *
 * The answer carries times and availability marks only: no price, no seat
 * count, no supplier id. It is indicative ("as of" `checkedAt`); the quote
 * re-checks the chosen start against fresh rows and stays the one promise.
 * Supplier reads come from the browse share of the read budget, so a flood
 * here never delays or refuses a quote and never touches the engine reserve.
 *
 * `createStartTimesService` is pure apart from its dependencies; `startTimesService` wires the real ones.
 */

export type PublicStartTimes =
  | { source: "supplier"; checkedAt: string; stale: boolean; times: ListedStart[] }
  /** `not_listed`: the stored times are the answer; `busy`: browse budget spent; `unavailable`: anything else. */
  | { source: "stored"; reason: "not_listed" | "busy" | "unavailable" };

export interface StartTimesDeps {
  readiness: Pick<ReadinessServiceImpl, "assess">;
  /** null when the supplier seam is not wired: every answer is then `stored`. */
  reader: SupplierStartTimesReader | null;
  now(): Date;
  /** Clock for the verdict cache, in ms; defaults to `now()`. */
  nowMs?(): number;
}

/** How long a product's readiness verdict serves this read. Readiness changes reach it within this time; the quote never relies on it. */
export const START_TIMES_VERDICT_TTL_MS = 30_000;

export function createStartTimesService(deps: StartTimesDeps) {
  // Per product: which variant's mapping sells as listed starts. Absent variant = not listed.
  const verdicts = new TtlCache<Record<string, string | null>>({
    ttlMs: START_TIMES_VERDICT_TTL_MS,
    staleIfErrorMs: 0,
    maxEntries: 500,
    now: () => (deps.nowMs ? deps.nowMs() : deps.now().getTime()),
  });

  async function listedMappings(productId: string): Promise<Record<string, string | null>> {
    const { value } = await verdicts.get(productId, async () => {
      const a = await deps.readiness.assess(productId);
      if (a.effective !== "instant" || !a.activity) return {};
      const variants = activeVariants(a.activity);
      const out: Record<string, string | null> = {};
      for (const v of variants) {
        const m = mappingForVariant(a.mappings, v.id, variants.length);
        // Doc 29 Batch 7: a date-only offer reads its starts from availability too (chips only when there are several).
        out[v.id] = m && (m.listedStartsSellable === true || m.dateOnlySellable === true) ? m.mappingId : null;
      }
      return out;
    });
    return value;
  }

  return {
    async startTimes(input: { productId: string; variantId: string; serviceDate: string }): Promise<PublicStartTimes> {
      if (input.serviceDate < dubaiToday(deps.now())) return { source: "stored", reason: "unavailable" };
      let mappingId: string | null;
      try {
        mappingId = (await listedMappings(input.productId))[input.variantId] ?? null;
      } catch {
        return { source: "stored", reason: "unavailable" };
      }
      if (!mappingId) return { source: "stored", reason: "not_listed" };
      if (!deps.reader) return { source: "stored", reason: "unavailable" };
      const r = await deps.reader.startTimes({ mappingId, serviceDate: input.serviceDate });
      if (r.ok) return { source: "supplier", checkedAt: r.checkedAt, stale: r.stale, times: r.times };
      return { source: "stored", reason: r.reason === "busy" ? "busy" : r.reason === "not_listed" ? "not_listed" : "unavailable" };
    },
  };
}

export type StartTimesService = ReturnType<typeof createStartTimesService>;

export const startTimesService: StartTimesService = createStartTimesService({
  readiness: readinessService,
  reader: supplierQuoteService,
  now: () => new Date(),
});
