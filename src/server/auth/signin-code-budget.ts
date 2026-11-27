/**
 * The sign-in code budget (Group B, review 103 finding 3, re-review 103b N1).
 * Pure: shared by the email start route's limits (customer-identity.service.ts)
 * and the staff alert that reads the same counter (account-alerts.ts), without
 * either importing the other.
 *
 * The Resend plan's daily cap (EMAIL_DAILY_SEND_CAP) is shared with booking
 * confirmations, ticket emails and the attach notices, so sign-in codes may
 * use at most SIGNIN_CODE_DAILY_SHARE_PERCENT of it per UTC day. The count is
 * the Postgres limiter bucket SIGNIN_CODE_BUDGET_BUCKET (one row per UTC day,
 * windows aligned to the epoch). Staff are alerted when it reaches
 * SIGNIN_CODE_BUDGET_ALERT_PERCENT of the budget and again when it is spent.
 */

export const SIGNIN_CODE_DAILY_SHARE_PERCENT = 40;
export const SIGNIN_CODE_BUDGET_ALERT_PERCENT = 80;
/** Limiter bucket of the site-wide daily code budget. */
export const SIGNIN_CODE_BUDGET_BUCKET = "auth_email_start:global_day";
/** Limiter bucket of the site-wide hourly code limit. */
export const SIGNIN_CODE_HOURLY_BUCKET = "auth_email_start:global";
export const SIGNIN_CODE_BUDGET_WINDOW_SECONDS = 86_400;

/** Sign-in codes allowed per UTC day for a plan cap: 40 % of it, at least one. */
export function signInCodeDailyBudget(dailyCap: number): number {
  const cap = Number.isFinite(dailyCap) ? Math.max(0, Math.floor(dailyCap)) : 0;
  return Math.max(1, Math.floor((cap * SIGNIN_CODE_DAILY_SHARE_PERCENT) / 100));
}

/** Start of the limiter's day window that holds `now` (UTC midnight). */
export function budgetWindowStart(now: Date): Date {
  const ms = SIGNIN_CODE_BUDGET_WINDOW_SECONDS * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export type SignInBudgetReason = "signin_code_budget_80pct" | "signin_code_budget_spent";

/**
 * Which budget alerts today's count raises (pure). Both are raised at the
 * start of the UTC day, like `email_volume_high`, so the ops sweep sends
 * each at most once per day. The count includes requests refused once the
 * budget was spent; a request whose Supabase `/otp` failed was released.
 */
export function signInBudgetCrossings(count: number, budget: number, now: Date): { reason: SignInBudgetReason; raisedAt: Date; count: number; budget: number }[] {
  if (!(budget > 0) || !(count > 0)) return [];
  const raisedAt = budgetWindowStart(now);
  const out: { reason: SignInBudgetReason; raisedAt: Date; count: number; budget: number }[] = [];
  if (count >= Math.ceil((budget * SIGNIN_CODE_BUDGET_ALERT_PERCENT) / 100)) out.push({ reason: "signin_code_budget_80pct", raisedAt, count, budget });
  if (count >= budget) out.push({ reason: "signin_code_budget_spent", raisedAt, count, budget });
  return out;
}
