import "server-only";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { log } from "@/server/lib/logger";
import { READINESS_RULES_VERSION } from "@/server/services/readiness.service";
import type { Activity, FulfilmentMode } from "@/lib/types";

/**
 * Effective eligibility for the storefront (PRD-11; doc 22 §23 B1).
 *
 * `products.fulfilment_mode` is the mode an operator asked for. Whether a
 * product may actually sell instantly is the readiness evaluation's verdict,
 * stored in `product_eligibility` (written from B2). A product without a row
 * has never been evaluated and is inquiry-only: absence is the safe default.
 *
 * B1 stub: nothing on the storefront calls this yet, and every product is
 * inquiry today. B2 projects the storefront from it instead of the requested
 * mode.
 */

/**
 * What a stored verdict is checked against when it is read (CR-B2-8). The
 * release switch is read live, so turning it off makes every page inquiry at
 * once, without waiting for a re-evaluation; a verdict written under older
 * readiness rules counts as inquiry until it is re-run.
 */
export interface EligibilityGate {
  releaseEnabled: boolean;
  rulesVersion: number;
}

/** The live gate. An unreadable environment counts as the switch off. */
export function storefrontGate(): EligibilityGate {
  let releaseEnabled = false;
  try {
    releaseEnabled = env().INSTANT_RELEASE_ENABLED === true;
  } catch {
    releaseEnabled = false;
  }
  return { releaseEnabled, rulesVersion: READINESS_RULES_VERSION };
}

/** The mode an eligibility row allows under `gate`; no row, an old rules version, the switch off, or anything but `instant`, is inquiry. */
export function effectiveModeFrom(row: { effectiveMode: FulfilmentMode | string; readinessVersion?: number | null } | null | undefined, gate: EligibilityGate): FulfilmentMode {
  if (row?.effectiveMode !== "instant") return "inquiry";
  if (!gate.releaseEnabled || row.readinessVersion !== gate.rulesVersion) return "inquiry";
  return "instant";
}

/** The mode the storefront may offer for one product. Fails closed to inquiry when the read fails. */
export async function effectiveModeFor(productId: string): Promise<FulfilmentMode> {
  try {
    const row = await prisma.productEligibility.findUnique({ where: { productId }, select: { effectiveMode: true, readinessVersion: true } });
    return effectiveModeFrom(row, storefrontGate());
  } catch (error) {
    log.warn("catalog.eligibility_read_failed", { productId, error });
    return "inquiry";
  }
}

/**
 * The mode a product page renders, read at render time (N6). The catalogue
 * snapshot is cached for up to a minute, so a product demoted since then
 * (a quote that found the supplier's refund terms tighter, for example)
 * would keep its instant badge and "Book now". Instant needs both the
 * snapshot and the live row to say so; anything else, including a product
 * without a database row (fixtures) or a failed read, renders as inquiry.
 */
export async function renderedModeFor(activity: Pick<Activity, "fulfilmentMode" | "productId">): Promise<FulfilmentMode> {
  if (activity.fulfilmentMode !== "instant" || !activity.productId) return "inquiry";
  return effectiveModeFor(activity.productId);
}
