import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";
import { uuidv7 } from "../lib/ids";
import { log } from "../lib/logger";
import { InboxRetry, paymentSaga, TICK_BUDGET_MS, type PaymentSagaService } from "./saga";
import { paymentGateways, type GatewayRegistry } from "./registry";

/**
 * Payment webhook inbox (PAY-13, F1, F2, F30).
 *
 * `receive` runs in the webhook route, on the raw bytes it read (capped
 * there):
 *  1. the provider must be one the registry serves (else `not_found`);
 *  2. the gateway verifies the signature over those exact bytes before
 *     anything is parsed or stored; a forged, tampered or (where the provider
 *     signs a timestamp) stale body is `rejected` and never stored;
 *  3. one `payment_events` row per (provider, event id) holds the event id,
 *     type, provider payment id and the sha256 of the body, never the body.
 *     A repeat of the event id is a `duplicate`: acknowledged, not stored or
 *     processed again.
 *
 * `processDue` runs in the job, never in the request. Each row is claimed
 * conditionally (state and `next_attempt_at`), so two workers never process
 * it at once, then handed to the saga, which acts on the provider's
 * authenticated read and not on the event. A failure is `processing_failed`
 * with a short code and an exponential backoff (30 s doubling, at most an
 * hour); after `MAX_ATTEMPTS` the row stays `processing_failed` with no next
 * attempt (dead letter) and an error is logged. A processing error never
 * marks an event processed, so a transient fault cannot drop a capture (the
 * WhatsApp pattern PAY-13 warns about).
 */

export const MAX_ATTEMPTS = 12;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 3600_000;
/** A claimed row is invisible to other workers for this long. */
const CLAIM_MS = 2 * 60_000;

export type ReceiveResult = { result: "not_found" } | { result: "rejected" } | { result: "duplicate"; providerEventId: string } | { result: "stored"; id: string; providerEventId: string };

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

function errorCode(e: unknown): string {
  if (e instanceof InboxRetry) return e.code.slice(0, 64);
  if (e instanceof Prisma.PrismaClientKnownRequestError) return `db_${e.code}`.slice(0, 64);
  return "processing_error";
}

export function createPaymentInbox(deps: { gateways: GatewayRegistry; saga: PaymentSagaService; now: () => Date }) {
  const db = prisma;

  async function receive(provider: string, rawBody: Uint8Array, headers: Headers): Promise<ReceiveResult> {
    const gw = deps.gateways.forProvider(provider);
    if (!gw) return { result: "not_found" };
    const event = gw.verifyWebhook(rawBody, headers);
    if (!event) return { result: "rejected" };
    const digest = createHash("sha256").update(rawBody).digest("hex");
    const id = uuidv7();
    try {
      await db.paymentEvent.create({
        data: {
          id,
          provider,
          providerEventId: event.providerEventId,
          state: "verified",
          type: event.type,
          providerPaymentId: event.providerPaymentId,
          payloadDigest: digest,
          receivedAt: deps.now(),
          nextAttemptAt: deps.now(),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { result: "duplicate", providerEventId: event.providerEventId };
      throw e;
    }
    return { result: "stored", id, providerEventId: event.providerEventId };
  }

  /** Process one row if it is due and nobody else holds it. Returns its state afterwards, or null when not claimed. */
  async function processOne(id: string): Promise<string | null> {
    const now = deps.now();
    const claimed = await db.paymentEvent.updateMany({
      where: { id, state: { in: ["verified", "processing_failed"] }, nextAttemptAt: { lte: now } },
      data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + CLAIM_MS) },
    });
    if (claimed.count !== 1) return null;
    const row = await db.paymentEvent.findUniqueOrThrow({ where: { id } });
    const gw = deps.gateways.forProvider(row.provider);
    try {
      if (!gw) throw new InboxRetry("provider_not_configured");
      await deps.saga.handleEvent(gw, { type: row.type, providerPaymentId: row.providerPaymentId });
      await db.paymentEvent.update({ where: { id }, data: { state: "processed", processedAt: deps.now(), nextAttemptAt: null, lastErrorCode: null } });
      return "processed";
    } catch (e) {
      const code = errorCode(e);
      const dead = row.attempts >= MAX_ATTEMPTS;
      await db.paymentEvent.update({
        where: { id },
        data: { state: "processing_failed", lastErrorCode: code, nextAttemptAt: dead ? null : new Date(deps.now().getTime() + backoffMs(row.attempts)) },
      });
      (dead ? log.error : log.warn)(dead ? "payments.inbox_dead_letter" : "payments.inbox_retry", { eventId: id, provider: row.provider, code, attempts: row.attempts });
      return "processing_failed";
    }
  }

  /** `stop` (a time cap, CO-38 review fix 1) is asked before each row: no new row is started once it says so; a row in hand always finishes. */
  async function processDue(limit = 25, opts: { stop?: () => boolean } = {}): Promise<{ processed: number; failed: number }> {
    const due = await db.paymentEvent.findMany({
      where: { state: { in: ["verified", "processing_failed"] }, nextAttemptAt: { lte: deps.now() } },
      orderBy: { receivedAt: "asc" },
      take: limit,
      select: { id: true },
    });
    let processed = 0;
    let failed = 0;
    for (const r of due) {
      if (opts.stop?.()) break;
      const s = await processOne(r.id);
      if (s === "processed") processed++;
      else if (s === "processing_failed") failed++;
    }
    return { processed, failed };
  }

  return { receive, processOne, processDue };
}

export type PaymentInbox = ReturnType<typeof createPaymentInbox>;

export const paymentInbox: PaymentInbox = createPaymentInbox({ gateways: paymentGateways, saga: paymentSaga, now: () => new Date() });

/**
 * One payments job run (F1, F30): the inbox first, then the sagas
 * (capture-unknown reads, deadlines, releases, refunds): urgent and other live
 * sagas, then the late-money watch, each within its budget and the run's time
 * budget (`advanceOpen`, CR-B3-14). A route that
 * runs it on a schedule is not part of B3's files (cross-owner request).
 */
export async function runPaymentsTick(inbox: PaymentInbox = paymentInbox, saga: PaymentSagaService = paymentSaga, opts: { deadline?: number; clock?: () => number } = {}) {
  // Without a deadline: unchanged (the payments-tick route). With one (the booking tick, review fix 1): no inbox row
  // and no saga is started after it; the sagas get what is left, never more than their own budget.
  const clock = opts.clock ?? (() => performance.now());
  const deadline = opts.deadline;
  const events = await inbox.processDue(25, deadline === undefined ? {} : { stop: () => clock() >= deadline });
  const sagas = await saga.advanceOpen(deadline === undefined ? {} : { budgetMs: Math.max(0, Math.min(TICK_BUDGET_MS, deadline - clock())), stop: () => clock() >= deadline });
  return { ...events, sagas };
}
