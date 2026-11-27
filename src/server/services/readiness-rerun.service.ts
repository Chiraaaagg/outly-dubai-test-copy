import "server-only";
import type { Actor } from "../lib/actor";
import { requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { prisma } from "../lib/db";
import { Errors } from "../lib/errors";
import { emitEvent } from "../lib/structured-events";
import { verifyStepUp } from "./approval.service";
import { listInstantCandidates, READINESS_RULES_VERSION, readinessService } from "./readiness.service";

/**
 * Admin action "Re-run readiness" (doc 29 §9.4): re-evaluate every product
 * that is or asks to be instant from the facts already stored (content,
 * approved mappings, offer terms, capability flags, margins), with no
 * TravelDesk call. The post-deploy step after a rules-version change, as an
 * alternative to the catalogue sync when the catalogue itself does not need
 * reading again (`readinessService.reevaluateMany` over
 * `listInstantCandidates`, the same set the sync and the pricing settings
 * re-run).
 *
 * Who: `suppliers.manage`, the same as the sync button, plus a fresh
 * authenticator code; staff only (the system actor has no authenticator).
 * Each product whose mode changes is audited by readiness itself
 * (`product.eligibility`, reason `readiness: admin_rerun`); the run as a
 * whole is audited once (`readiness.rerun`) with counts only, and logged.
 *
 * It can only move a product the way the stored facts say: never more
 * permissive than the rules, which fail closed (an evaluation error demotes
 * that product to inquiry).
 */

export interface ReadinessRerunResult {
  /** Products re-evaluated. */
  candidates: number;
  /** Of those, how many are now instant, and how many inquiry. */
  instant: number;
  inquiry: number;
  rulesVersion: number;
  durationMs: number;
}

export interface ReadinessRerunDeps {
  stepUp?: (actor: Actor, code: string) => Promise<string | null>;
  listCandidates?: () => Promise<string[]>;
  reevaluateMany?: (ids: string[]) => Promise<void>;
  /** Stored verdicts of these products after the run. */
  verdicts?: (ids: string[]) => Promise<{ effectiveMode: string }[]>;
  audit?: typeof audit;
  now?: () => number;
}

const STEP_UP_MESSAGE: Record<string, string> = { not_enrolled: "Set up your authenticator app first" };

export async function rerunReadiness(actor: Actor, totpCode: string | undefined, deps: ReadinessRerunDeps = {}): Promise<ReadinessRerunResult> {
  requirePermission(actor, "suppliers.manage");
  if (actor.type !== "admin" && actor.type !== "agent") throw Errors.forbidden("suppliers.manage");
  if (!totpCode) throw Errors.validation({ totpCode: "Enter the 6-digit code from your authenticator app" });
  const failed = await (deps.stepUp ?? verifyStepUp)(actor, totpCode);
  if (failed) throw Errors.validation({ totpCode: STEP_UP_MESSAGE[failed] ?? "The code was not accepted; wait for a new one" });

  const now = deps.now ?? Date.now;
  const started = now();
  const ids = await (deps.listCandidates ?? listInstantCandidates)();
  await (deps.reevaluateMany ?? ((list) => readinessService.reevaluateMany(list, "admin_rerun")))(ids);
  const rows = ids.length
    ? await (deps.verdicts ?? ((list) => prisma.productEligibility.findMany({ where: { productId: { in: list } }, select: { effectiveMode: true } })))(ids)
    : [];
  const instant = rows.filter((r) => r.effectiveMode === "instant").length;
  const result: ReadinessRerunResult = { candidates: ids.length, instant, inquiry: ids.length - instant, rulesVersion: READINESS_RULES_VERSION, durationMs: Math.max(0, now() - started) };
  await (deps.audit ?? audit)(actor, "readiness.rerun", { type: "readiness", id: "instant_candidates" }, { after: result, reason: "admin re-run, no supplier calls" });
  emitEvent("readiness.rerun", { candidates: result.candidates, instant: result.instant, inquiry: result.inquiry, durationMs: result.durationMs });
  return result;
}
