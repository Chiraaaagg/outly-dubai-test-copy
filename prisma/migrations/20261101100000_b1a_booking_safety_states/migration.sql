-- B1a booking safety states (doc 22 §23 B1a; contract in
-- src/server/suppliers/booking-port.ts). Additive only: three enum values and
-- two nullable columns. No new table, view or sequence, so the RLS and
-- API-role revoke rules in prisma/migrations/README.md do not apply here.
--
-- ALTER TYPE ... ADD VALUE may run inside the migration transaction on
-- Postgres 12+, but a new value cannot be used before that transaction
-- commits. Nothing below refers to the new values.

-- 1. Blocking states (B1A_BLOCKING_STATES).
--   awaiting_payment      reserved, waiting for provider-verified capture before any confirm (PAY-1)
--   not_found_unresolved  request sent, nothing found by lookup yet; not proof that nothing was created
--   cancel_unverified     cancel answered or timed out; cancelled status not yet confirmed by a reread
ALTER TYPE "supplier_booking_state" ADD VALUE IF NOT EXISTS 'awaiting_payment';
ALTER TYPE "supplier_booking_state" ADD VALUE IF NOT EXISTS 'not_found_unresolved';
ALTER TYPE "supplier_booking_state" ADD VALUE IF NOT EXISTS 'cancel_unverified';

-- The partial unique index "sb_one_live_per_order_item" (20261031090000) is
-- deliberately left unchanged. Its predicate lists only the guard-releasing
-- states (GUARD_RELEASING_STATES: not_created, rejected, expired, cancelled)
-- in a NOT IN list, so every state not named there, including the three
-- above, keeps the order item locked against a second attempt.
-- src/server/__tests__/supplier-guard-states.test.ts proves it for each one.

-- 2. Attention flag: set when a booking needs a human (alerting, ops queue).
ALTER TABLE "supplier_bookings" ADD COLUMN "attention_required_at" TIMESTAMPTZ(6);

-- 3. Deadline gate: a job must not send its supplier request after this instant (SUP-2).
ALTER TABLE "supplier_jobs" ADD COLUMN "deadline_at" TIMESTAMPTZ(6);
