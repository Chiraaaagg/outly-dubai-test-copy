-- Doc 30 build N2, migration M5: one proof row per offer type with a scope
-- (owner decisions D14, D20, D21, D24; doc 30 §3.12), and the bulk
-- operations that arm listings, send them back to inquiry, or record
-- "free cancellation confirmed" (D6).
--
-- Forward-only and additive: three new tables. Old code never reads them;
-- with no proof row the capability gate decides exactly as before (parity
-- test in traveldesk.capability.test.ts), so applying this changes no
-- listing's mode.
--
--   supplier_class_proofs   one row per proof: supplier, environment, the
--                           class key it covers, the key the supervised
--                           booking was made on (the same key, or a neighbour
--                           differing in time shape alone, decision 22 / D20),
--                           the scope ('all' offers of the key, one external
--                           'provider' (D21), or named 'tours' (D24)), the
--                           reference of the booking, the approval used.
--                           Fixed once recorded (trigger): revoked, never
--                           edited; a wider scope is a new row with its own
--                           approval.
--   bulk_operations         one row per bulk run: the action, the frozen item
--                           list's hash and size (at most 50), the person who
--                           started it, its 30-minute window, and the approval
--                           it burned (unique: one approval, one run).
--   bulk_operation_items    one row per listing of a run: pending, applied,
--                           skipped or failed, with a reason code. Each item
--                           commits alone; a finished item is never re-run.
--
-- Nothing here holds a price, a net, a name, an email or a phone number.
-- References name a booking, test or drill.
--
-- Rollback: redeploy the previous build; the tables stay unused.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "supplier_class_proofs" (
  "id"               UUID                   NOT NULL,
  "supplier_id"      UUID                   NOT NULL,
  "environment"      "supplier_environment" NOT NULL,
  "class_key"        TEXT                   NOT NULL,
  "basis_class_key"  TEXT                   NOT NULL,
  "scope_kind"       TEXT                   NOT NULL,
  "scope_provider"   TEXT,
  "scope_tour_ids"   TEXT[]                 NOT NULL DEFAULT ARRAY[]::TEXT[],
  "evidence_kind"    TEXT                   NOT NULL,
  "reference"        TEXT                   NOT NULL,
  "widens_proof_id"  UUID,
  "approval_id"      UUID,
  "recorded_by"      UUID,
  "recorded_at"      TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at"       TIMESTAMPTZ(6),
  "revoked_by"       UUID,
  "revoke_reason"    TEXT,
  CONSTRAINT "supplier_class_proofs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scp_class_key_check" CHECK ("class_key" ~ '^[a-z_]+(\.[a-z_]+){4}$'),
  CONSTRAINT "scp_basis_class_key_check" CHECK ("basis_class_key" ~ '^[a-z_]+(\.[a-z_]+){4}$'),
  -- Decision 22 / D20: the booked key is the key itself or differs from it in time shape (the second part) alone.
  CONSTRAINT "scp_basis_neighbour_check" CHECK (
    split_part("class_key", '.', 1) = split_part("basis_class_key", '.', 1)
    AND split_part("class_key", '.', 3) = split_part("basis_class_key", '.', 3)
    AND split_part("class_key", '.', 4) = split_part("basis_class_key", '.', 4)
    AND split_part("class_key", '.', 5) = split_part("basis_class_key", '.', 5)
  ),
  -- Owner decision 7: private units stay inquiry, so no proof ever covers a per-unit key.
  CONSTRAINT "scp_per_unit_never_check" CHECK (NOT ("class_key" ~ '\.(per_unit|mixed_person_plus_unit)$')),
  CONSTRAINT "scp_scope_kind_check" CHECK ("scope_kind" IN ('all', 'provider', 'tours')),
  CONSTRAINT "scp_scope_shape_check" CHECK (
    ("scope_kind" = 'all' AND "scope_provider" IS NULL AND cardinality("scope_tour_ids") = 0)
    OR ("scope_kind" = 'provider' AND "scope_provider" IS NOT NULL AND cardinality("scope_tour_ids") = 0)
    OR ("scope_kind" = 'tours' AND "scope_provider" IS NULL AND cardinality("scope_tour_ids") BETWEEN 1 AND 200
        AND array_to_string("scope_tour_ids", ',') ~ '^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9})*$')
  ),
  CONSTRAINT "scp_scope_provider_check" CHECK ("scope_provider" IS NULL OR char_length("scope_provider") BETWEEN 1 AND 120),
  CONSTRAINT "scp_evidence_kind_check" CHECK ("evidence_kind" IN ('production_booking', 'sandbox_drill')),
  CONSTRAINT "scp_reference_check" CHECK (char_length("reference") BETWEEN 3 AND 200),
  CONSTRAINT "scp_revoke_check" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL))
);

CREATE INDEX "scp_key_idx" ON "supplier_class_proofs" ("supplier_id", "environment", "class_key");

ALTER TABLE "supplier_class_proofs" ADD CONSTRAINT "supplier_class_proofs_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A proof is withdrawn, never rewritten: a revoked row stays revoked and its facts never change.
CREATE OR REPLACE FUNCTION outly_class_proof_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."supplier_id" <> OLD."supplier_id" OR NEW."environment" <> OLD."environment" OR NEW."class_key" <> OLD."class_key"
     OR NEW."basis_class_key" <> OLD."basis_class_key" OR NEW."scope_kind" <> OLD."scope_kind"
     OR NEW."scope_provider" IS DISTINCT FROM OLD."scope_provider" OR NEW."scope_tour_ids" IS DISTINCT FROM OLD."scope_tour_ids"
     OR NEW."evidence_kind" <> OLD."evidence_kind" OR NEW."reference" <> OLD."reference"
     OR NEW."widens_proof_id" IS DISTINCT FROM OLD."widens_proof_id" OR NEW."recorded_at" <> OLD."recorded_at"
     OR NEW."recorded_by" IS DISTINCT FROM OLD."recorded_by" OR NEW."approval_id" IS DISTINCT FROM OLD."approval_id" THEN
    RAISE EXCEPTION 'supplier_class_proofs: a proof is fixed once recorded; revoke it and record a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND (NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR NEW."revoke_reason" IS DISTINCT FROM OLD."revoke_reason" OR NEW."revoked_by" IS DISTINCT FROM OLD."revoked_by") THEN
    RAISE EXCEPTION 'supplier_class_proofs: a revoked proof stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "supplier_class_proofs_guard" BEFORE UPDATE ON "supplier_class_proofs"
  FOR EACH ROW EXECUTE FUNCTION outly_class_proof_guard();

CREATE TABLE "bulk_operations" (
  "id"            UUID                   NOT NULL,
  "action"        TEXT                   NOT NULL,
  "environment"   "supplier_environment" NOT NULL,
  "approval_id"   UUID,
  "approval_mode" TEXT,
  "requested_by"  UUID                   NOT NULL,
  "items_hash"    TEXT                   NOT NULL,
  "item_count"    INTEGER                NOT NULL,
  "reason"        TEXT                   NOT NULL,
  "created_at"    TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"    TIMESTAMPTZ(6)         NOT NULL,
  "finished_at"   TIMESTAMPTZ(6),
  CONSTRAINT "bulk_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bo_action_check" CHECK ("action" IN ('arm', 'inquiry', 'free_cancellation')),
  -- Loosening runs burn an approval; back to inquiry needs none.
  CONSTRAINT "bo_approval_check" CHECK (("action" = 'inquiry') = ("approval_id" IS NULL)),
  CONSTRAINT "bo_approval_mode_check" CHECK ("approval_mode" IS NULL OR "approval_mode" IN ('dual', 'single_step_up')),
  CONSTRAINT "bo_items_hash_check" CHECK ("items_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "bo_item_count_check" CHECK ("item_count" BETWEEN 1 AND 50),
  CONSTRAINT "bo_reason_check" CHECK (char_length("reason") BETWEEN 8 AND 500),
  CONSTRAINT "bo_window_check" CHECK ("expires_at" > "created_at")
);

-- Burned once: one approval starts at most one run.
CREATE UNIQUE INDEX "bo_approval_key" ON "bulk_operations" ("approval_id") WHERE "approval_id" IS NOT NULL;
CREATE INDEX "bo_requested_by_idx" ON "bulk_operations" ("requested_by", "created_at" DESC);

ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_requested_by_fkey"
  FOREIGN KEY ("requested_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "bulk_operation_items" (
  "id"           UUID           NOT NULL,
  "bulk_id"      UUID           NOT NULL,
  "product_id"   UUID           NOT NULL,
  "position"     INTEGER        NOT NULL,
  "state"        TEXT           NOT NULL DEFAULT 'pending',
  "outcome"      TEXT,
  "finished_at"  TIMESTAMPTZ(6),
  CONSTRAINT "bulk_operation_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "boi_state_check" CHECK ("state" IN ('pending', 'applied', 'skipped', 'failed')),
  CONSTRAINT "boi_finished_check" CHECK (("state" = 'pending') = ("finished_at" IS NULL)),
  CONSTRAINT "boi_outcome_check" CHECK ("outcome" IS NULL OR "outcome" ~ '^[a-z0-9_.:-]{1,80}$'),
  CONSTRAINT "boi_position_check" CHECK ("position" BETWEEN 0 AND 49)
);

CREATE UNIQUE INDEX "boi_bulk_product_key" ON "bulk_operation_items" ("bulk_id", "product_id");
CREATE INDEX "boi_product_idx" ON "bulk_operation_items" ("product_id");

ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "bulk_operation_items_bulk_id_fkey"
  FOREIGN KEY ("bulk_id") REFERENCES "bulk_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bulk_operation_items" ADD CONSTRAINT "bulk_operation_items_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_class_proofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bulk_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bulk_operation_items" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "supplier_class_proofs" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "bulk_operations" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "bulk_operation_items" FROM %I', r);
    END IF;
  END LOOP;
END $$;
