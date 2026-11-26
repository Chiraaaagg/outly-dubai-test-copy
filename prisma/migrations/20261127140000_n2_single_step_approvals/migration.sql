-- Doc 30 build N2, migration M4: one person with a fresh authenticator code
-- for instant activation and class switch-on (owner decisions D15, D16, D25
-- of 25 November 2026; review RR-02, P30-33).
--
-- Forward-only and additive. Old code runs on the new schema: it never names
-- the new columns (their defaults are the old behaviour), and every existing
-- row still passes every check.
--
--   privileged_approvals.approval_mode  'dual' (default; every existing row)
--                                       or 'single_step_up': applied in
--                                       production by the requester alone,
--                                       after a fresh code, with the owner
--                                       alert queued in the same transaction
--                                       (approval.service.ts).
--   privileged_approvals.item_count     listings the approval covers (1 for a
--                                       single activation, up to 50 for a bulk
--                                       run); the hourly cap of 100 listings
--                                       per person counts it.
--   pa_operation_check                  widened: + 'instant.activate.bulk'.
--   pa_production_dual_check            replaced: an applied production row
--                                       has a second approver, OR its mode is
--                                       single_step_up and its operation is one
--                                       of exactly three: instant.activate,
--                                       instant.activate.bulk,
--                                       supplier.capability.enable.
--                                       supplier.resume, supplier.limits.raise
--                                       and booking.privileged_resolution keep
--                                       two people.
--   pa_single_step_check                new: a single_step_up row is one of the
--                                       three operations and never names a
--                                       second approver.
--
-- Unchanged: pa_distinct_approver_check and pa_approved_pair_check. A
-- single-step row has no approver (approved_by and approved_at NULL), which
-- both accept as they always did.
--
--   ops_alerts_entity_kind_check        widened: + 'privileged_approval', for
--                                       the ops alert raised when the owner
--                                       alert email of an approval fails
--                                       (ops-alert.service.ts). Ids only.
--
-- Constraint swaps follow prisma/migrations/README.md "Locks": a lock
-- timeout, then each new check added NOT VALID and validated separately.
-- Rollback: redeploy the previous build. It writes dual rows only, which the
-- new check accepts; the columns and checks can stay.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "privileged_approvals" ADD COLUMN "approval_mode" TEXT NOT NULL DEFAULT 'dual';
ALTER TABLE "privileged_approvals" ADD COLUMN "item_count" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_approval_mode_check"
  CHECK ("approval_mode" IN ('dual', 'single_step_up')) NOT VALID;
ALTER TABLE "privileged_approvals" VALIDATE CONSTRAINT "pa_approval_mode_check";

ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_item_count_check"
  CHECK ("item_count" BETWEEN 1 AND 50) NOT VALID;
ALTER TABLE "privileged_approvals" VALIDATE CONSTRAINT "pa_item_count_check";

ALTER TABLE "privileged_approvals" DROP CONSTRAINT "pa_operation_check";
ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_operation_check"
  CHECK ("operation" IN ('instant.activate', 'instant.activate.bulk', 'supplier.resume', 'supplier.limits.raise', 'booking.privileged_resolution', 'supplier.capability.enable')) NOT VALID;
ALTER TABLE "privileged_approvals" VALIDATE CONSTRAINT "pa_operation_check";

ALTER TABLE "privileged_approvals" DROP CONSTRAINT "pa_production_dual_check";
ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_production_dual_check"
  CHECK (
    "environment" <> 'production'
    OR "status" <> 'applied'
    OR "approved_by" IS NOT NULL
    OR ("approval_mode" = 'single_step_up' AND "operation" IN ('instant.activate', 'instant.activate.bulk', 'supplier.capability.enable'))
  ) NOT VALID;
ALTER TABLE "privileged_approvals" VALIDATE CONSTRAINT "pa_production_dual_check";

ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_single_step_check"
  CHECK (
    "approval_mode" <> 'single_step_up'
    OR ("operation" IN ('instant.activate', 'instant.activate.bulk', 'supplier.capability.enable') AND "approved_by" IS NULL)
  ) NOT VALID;
ALTER TABLE "privileged_approvals" VALIDATE CONSTRAINT "pa_single_step_check";

-- The hourly item cap reads a person's recent single-step rows.
CREATE INDEX "pa_single_step_recent_idx" ON "privileged_approvals" ("requested_by", "requested_at")
  WHERE "approval_mode" = 'single_step_up';

ALTER TABLE "ops_alerts" DROP CONSTRAINT "ops_alerts_entity_kind_check";
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_entity_kind_check" CHECK ("entity_kind" IN
  ('supplier_account', 'payment_saga', 'order_item', 'supplier_booking', 'supplier_document', 'crm_subject', 'privileged_approval', 'digest')) NOT VALID;
ALTER TABLE "ops_alerts" VALIDATE CONSTRAINT "ops_alerts_entity_kind_check";
