-- Doc 30 build N2, review 105 fixes on top of M4 and M5 (20261127140000,
-- 20261127150000). Forward-only and additive; old code never names the new
-- columns, and every widened check accepts every row it accepted before.
--
--   supplier_class_proofs
--     narrows_proof_id    the proof a narrower row replaced, revoked in the same
--                         transaction (N2-01: narrowing is an atomic replace).
--     booked_tour_id      the TravelDesk tour the supervised booking was made on
--                         (N2-03). A named-tours scope must contain it.
--     scp_external_never_all_check  D21 in the database (N2-08).
--     delete guard        a proof row is never deleted (N2-07): a delete would
--                         bring a seeded key's exception back. The only way past
--                         it is a transaction-local `outly.purge_class_proofs`
--                         setting, used by the disposable-database test
--                         cleanup. The supplier foreign key no longer cascades.
--     update guard        also covers the two new columns.
--   bulk_operation_items
--     state 'running' and claimed_until: an item is claimed before it runs, so two
--     runs never execute one item (N2-04).
--     was_instant: the listing's requested mode when the item was first claimed,
--     so a resumed free-cancellation item still re-arms (N2-04).
--   bulk_operations.approval_id  foreign key to privileged_approvals (N2-09).
--   ops_alerts entity kind + 'bulk_operation_item': a free-cancellation item that
--     failed after disarming and could not re-arm raises an ops alert (N2-04).
--
-- Lock timeout; new checks on existing tables NOT VALID then VALIDATE.
-- Rollback: redeploy the previous build; the columns and checks can stay.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "supplier_class_proofs" ADD COLUMN "narrows_proof_id" UUID;
ALTER TABLE "supplier_class_proofs" ADD COLUMN "booked_tour_id" TEXT;
ALTER TABLE "supplier_class_proofs" ADD CONSTRAINT "scp_booked_tour_check" CHECK (
  "booked_tour_id" IS NULL
  OR ("booked_tour_id" ~ '^[1-9][0-9]{0,9}$' AND ("scope_kind" <> 'tours' OR "booked_tour_id" = ANY ("scope_tour_ids")))
) NOT VALID;
ALTER TABLE "supplier_class_proofs" VALIDATE CONSTRAINT "scp_booked_tour_check";
ALTER TABLE "supplier_class_proofs" ADD CONSTRAINT "scp_external_never_all_check" CHECK (split_part("class_key", '.', 4) <> 'external' OR "scope_kind" <> 'all') NOT VALID;
ALTER TABLE "supplier_class_proofs" VALIDATE CONSTRAINT "scp_external_never_all_check";
ALTER TABLE "supplier_class_proofs" ADD CONSTRAINT "scp_narrow_widen_check" CHECK ("narrows_proof_id" IS NULL OR "widens_proof_id" IS NULL) NOT VALID;
ALTER TABLE "supplier_class_proofs" VALIDATE CONSTRAINT "scp_narrow_widen_check";

ALTER TABLE "supplier_class_proofs" DROP CONSTRAINT "supplier_class_proofs_supplier_id_fkey";
ALTER TABLE "supplier_class_proofs" ADD CONSTRAINT "supplier_class_proofs_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "supplier_class_proofs" VALIDATE CONSTRAINT "supplier_class_proofs_supplier_id_fkey";

CREATE OR REPLACE FUNCTION outly_class_proof_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."supplier_id" <> OLD."supplier_id" OR NEW."environment" <> OLD."environment" OR NEW."class_key" <> OLD."class_key"
     OR NEW."basis_class_key" <> OLD."basis_class_key" OR NEW."scope_kind" <> OLD."scope_kind"
     OR NEW."scope_provider" IS DISTINCT FROM OLD."scope_provider" OR NEW."scope_tour_ids" IS DISTINCT FROM OLD."scope_tour_ids"
     OR NEW."evidence_kind" <> OLD."evidence_kind" OR NEW."reference" <> OLD."reference"
     OR NEW."widens_proof_id" IS DISTINCT FROM OLD."widens_proof_id" OR NEW."narrows_proof_id" IS DISTINCT FROM OLD."narrows_proof_id"
     OR NEW."booked_tour_id" IS DISTINCT FROM OLD."booked_tour_id" OR NEW."recorded_at" <> OLD."recorded_at"
     OR NEW."recorded_by" IS DISTINCT FROM OLD."recorded_by" OR NEW."approval_id" IS DISTINCT FROM OLD."approval_id" THEN
    RAISE EXCEPTION 'supplier_class_proofs: a proof is fixed once recorded; revoke it and record a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND (NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR NEW."revoke_reason" IS DISTINCT FROM OLD."revoke_reason" OR NEW."revoked_by" IS DISTINCT FROM OLD."revoked_by") THEN
    RAISE EXCEPTION 'supplier_class_proofs: a revoked proof stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION outly_class_proof_no_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(current_setting('outly.purge_class_proofs', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'supplier_class_proofs: a proof is never deleted; revoke it' USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER "supplier_class_proofs_no_delete" BEFORE DELETE ON "supplier_class_proofs"
  FOR EACH ROW EXECUTE FUNCTION outly_class_proof_no_delete();

ALTER TABLE "bulk_operation_items" ADD COLUMN "claimed_until" TIMESTAMPTZ(6);
ALTER TABLE "bulk_operation_items" ADD COLUMN "was_instant" BOOLEAN;
ALTER TABLE "bulk_operation_items" DROP CONSTRAINT "boi_state_check";
ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "boi_state_check" CHECK ("state" IN ('pending', 'running', 'applied', 'skipped', 'failed')) NOT VALID;
ALTER TABLE "bulk_operation_items" VALIDATE CONSTRAINT "boi_state_check";
ALTER TABLE "bulk_operation_items" DROP CONSTRAINT "boi_finished_check";
ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "boi_finished_check" CHECK (("state" IN ('pending', 'running')) = ("finished_at" IS NULL)) NOT VALID;
ALTER TABLE "bulk_operation_items" VALIDATE CONSTRAINT "boi_finished_check";
ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "boi_claim_check" CHECK (("state" = 'running') = ("claimed_until" IS NOT NULL)) NOT VALID;
ALTER TABLE "bulk_operation_items" VALIDATE CONSTRAINT "boi_claim_check";
ALTER TABLE "bulk_operation_items" DROP CONSTRAINT "boi_outcome_check";
ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "boi_outcome_check" CHECK ("outcome" IS NULL OR "outcome" ~ '^[a-z0-9_.:-]{1,120}$') NOT VALID;
ALTER TABLE "bulk_operation_items" VALIDATE CONSTRAINT "boi_outcome_check";

ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_approval_id_fkey"
  FOREIGN KEY ("approval_id") REFERENCES "privileged_approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "bulk_operations" VALIDATE CONSTRAINT "bulk_operations_approval_id_fkey";

ALTER TABLE "ops_alerts" DROP CONSTRAINT "ops_alerts_entity_kind_check";
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_entity_kind_check" CHECK ("entity_kind" IN
  ('supplier_account', 'payment_saga', 'order_item', 'supplier_booking', 'supplier_document', 'crm_subject', 'privileged_approval', 'bulk_operation_item', 'digest')) NOT VALID;
ALTER TABLE "ops_alerts" VALIDATE CONSTRAINT "ops_alerts_entity_kind_check";
