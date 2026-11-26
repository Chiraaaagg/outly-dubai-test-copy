-- Doc 29 Batch 1a: capability tables and the parity-tested gate (§3.1, §3.3, §3.4).
--
-- Forward-only and additive. New tables:
--   supplier_offer_capabilities  derived capability per supplier offer and
--                                environment, with the raw values it came
--                                from, the composed class key and the
--                                derivation version (written by the sync);
--   supplier_capability_flags    one switch per adapter, environment and
--                                exact composed class key; default off;
--   supplier_offer_enablement    per-offer evidence (kind, reference, who,
--                                when), revoked rather than deleted.
-- One existing constraint widens: privileged_approvals.operation may be
-- 'supplier.capability.enable' (turning a class flag on, or recording
-- evidence, through approval.service). No existing row is rewritten and every
-- existing value stays valid.
--
-- Seed (the exception named in doc 29 §3.3, approved with Batch 1a on
-- 22 November 2026): the two fixed-start, self-arrival, internal, per-person
-- TravelDesk keys are switched on in both environments, without per-offer
-- evidence, so the offers the single live_book gate allows today stay as
-- they are. ON CONFLICT DO NOTHING: re-running never turns a flag back on.
-- Every other key has no row, which reads as off.
--
-- Old code ignores the new tables. Rollback: redeploy the previous build; the
-- tables stay (the database is never rolled back, doc 22 §32.46).
--
-- The widened CHECK replaces a constraint on an existing table, so the
-- migration starts with a lock timeout (prisma/migrations/README.md "Locks").

SET LOCAL lock_timeout = '5s';

CREATE TABLE "supplier_offer_capabilities" (
  "id"                  UUID                   NOT NULL,
  "supplier_id"         UUID                   NOT NULL,
  "environment"         "supplier_environment" NOT NULL,
  "offer_external_id"   TEXT                   NOT NULL,
  "catalogue_item_id"   UUID                   NOT NULL,
  "fulfilment"          TEXT                   NOT NULL,
  "time_shape"          TEXT                   NOT NULL,
  "arrival"             TEXT                   NOT NULL,
  "route"               TEXT                   NOT NULL,
  "pricing_unit"        TEXT                   NOT NULL,
  "class_key"           TEXT                   NOT NULL,
  "review_reasons"      TEXT[]                 NOT NULL DEFAULT ARRAY[]::TEXT[],
  "raw_values"          JSONB                  NOT NULL DEFAULT '{}',
  "derivation_version"  INTEGER                NOT NULL,
  "offer_terms_hash"    TEXT,
  "derived_at"          TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_offer_capabilities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "soc_fulfilment_check" CHECK ("fulfilment" IN ('live', 'ticket', 'on_request', 'unknown')),
  CONSTRAINT "soc_time_shape_check" CHECK ("time_shape" IN
    ('fixed_slot_single', 'fixed_slot_choice', 'listed_start_single', 'listed_starts_customer_selected', 'date_only_no_slot_metadata', 'open_dated', 'unknown')),
  CONSTRAINT "soc_arrival_check" CHECK ("arrival" IN ('self', 'pickup_required', 'unknown')),
  CONSTRAINT "soc_route_check" CHECK ("route" IN ('internal', 'external', 'unknown')),
  CONSTRAINT "soc_pricing_unit_check" CHECK ("pricing_unit" IN ('per_person', 'per_unit', 'mixed_person_plus_unit', 'unknown')),
  CONSTRAINT "soc_class_key_check" CHECK ("class_key" ~ '^([a-z_]+(\.[a-z_]+){4}|unknown|inquiry_only)$'),
  CONSTRAINT "soc_raw_values_object_check" CHECK (jsonb_typeof("raw_values") = 'object'),
  CONSTRAINT "soc_derivation_version_check" CHECK ("derivation_version" >= 1),
  CONSTRAINT "soc_offer_terms_hash_check" CHECK ("offer_terms_hash" IS NULL OR "offer_terms_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "supplier_offer_capabilities_catalogue_item_id_key" ON "supplier_offer_capabilities" ("catalogue_item_id");
CREATE UNIQUE INDEX "soc_identity_key" ON "supplier_offer_capabilities" ("supplier_id", "environment", "offer_external_id");
CREATE INDEX "soc_class_idx" ON "supplier_offer_capabilities" ("environment", "class_key");

ALTER TABLE "supplier_offer_capabilities" ADD CONSTRAINT "supplier_offer_capabilities_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_offer_capabilities" ADD CONSTRAINT "supplier_offer_capabilities_catalogue_item_id_fkey"
  FOREIGN KEY ("catalogue_item_id") REFERENCES "supplier_catalogue_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "supplier_capability_flags" (
  "id"                       UUID                   NOT NULL,
  "adapter"                  TEXT                   NOT NULL,
  "environment"              "supplier_environment" NOT NULL,
  "class_key"                TEXT                   NOT NULL,
  "enabled"                  BOOLEAN                NOT NULL DEFAULT false,
  "requires_offer_evidence"  BOOLEAN                NOT NULL DEFAULT true,
  "reason"                   TEXT                   NOT NULL,
  "approval_id"              UUID,
  "changed_by"               UUID,
  "changed_at"               TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"               TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_capability_flags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scf_adapter_check" CHECK ("adapter" ~ '^[a-z0-9_-]{1,40}$'),
  -- Only composed keys have switches; `unknown` and `inquiry_only` never do.
  CONSTRAINT "scf_class_key_check" CHECK ("class_key" ~ '^[a-z_]+(\.[a-z_]+){4}$'),
  CONSTRAINT "scf_reason_check" CHECK (char_length("reason") BETWEEN 8 AND 500),
  -- Owner decision 7 (22 Nov 2026): private units stay inquiry, so a per-unit key is never on.
  CONSTRAINT "scf_per_unit_never_enabled_check" CHECK (NOT ("enabled" AND "class_key" ~ '\.(per_unit|mixed_person_plus_unit)$'))
);

CREATE UNIQUE INDEX "scf_identity_key" ON "supplier_capability_flags" ("adapter", "environment", "class_key");

CREATE TABLE "supplier_offer_enablement" (
  "id"                 UUID                   NOT NULL,
  "supplier_id"        UUID                   NOT NULL,
  "environment"        "supplier_environment" NOT NULL,
  "offer_external_id"  TEXT                   NOT NULL,
  "class_key"          TEXT                   NOT NULL,
  "evidence_kind"      TEXT                   NOT NULL,
  "reference"          TEXT                   NOT NULL,
  "offer_terms_hash"   TEXT                   NOT NULL,
  "approval_id"        UUID,
  "recorded_by"        UUID,
  "recorded_at"        TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at"         TIMESTAMPTZ(6),
  "revoked_by"         UUID,
  "revoke_reason"      TEXT,
  CONSTRAINT "supplier_offer_enablement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "soe_class_key_check" CHECK ("class_key" ~ '^[a-z_]+(\.[a-z_]+){4}$'),
  CONSTRAINT "soe_evidence_kind_check" CHECK ("evidence_kind" IN ('contract_test', 'sandbox_drill', 'production_booking', 'neighbour_proof')),
  CONSTRAINT "soe_reference_check" CHECK (char_length("reference") BETWEEN 3 AND 200),
  CONSTRAINT "soe_offer_terms_hash_check" CHECK ("offer_terms_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "soe_revoke_check" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL))
);

CREATE INDEX "soe_offer_idx" ON "supplier_offer_enablement" ("supplier_id", "environment", "offer_external_id", "class_key");

ALTER TABLE "supplier_offer_enablement" ADD CONSTRAINT "supplier_offer_enablement_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Evidence is withdrawn, never rewritten: a revoked row stays revoked and its facts never change.
CREATE OR REPLACE FUNCTION outly_offer_enablement_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."supplier_id" <> OLD."supplier_id" OR NEW."environment" <> OLD."environment" OR NEW."offer_external_id" <> OLD."offer_external_id"
     OR NEW."class_key" <> OLD."class_key" OR NEW."evidence_kind" <> OLD."evidence_kind" OR NEW."reference" <> OLD."reference"
     OR NEW."offer_terms_hash" <> OLD."offer_terms_hash" OR NEW."recorded_at" <> OLD."recorded_at"
     OR NEW."recorded_by" IS DISTINCT FROM OLD."recorded_by" OR NEW."approval_id" IS DISTINCT FROM OLD."approval_id" THEN
    RAISE EXCEPTION 'supplier_offer_enablement: evidence is fixed once recorded; revoke it and record new evidence' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND (NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR NEW."revoke_reason" IS DISTINCT FROM OLD."revoke_reason" OR NEW."revoked_by" IS DISTINCT FROM OLD."revoked_by") THEN
    RAISE EXCEPTION 'supplier_offer_enablement: revoked evidence stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "supplier_offer_enablement_guard" BEFORE UPDATE ON "supplier_offer_enablement"
  FOR EACH ROW EXECUTE FUNCTION outly_offer_enablement_guard();

ALTER TABLE "privileged_approvals" DROP CONSTRAINT "pa_operation_check";
ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_operation_check"
  CHECK ("operation" IN ('instant.activate', 'supplier.resume', 'supplier.limits.raise', 'booking.privileged_resolution', 'supplier.capability.enable'));

-- The named exception (doc 29 §3.3): the two proven keys on, both environments, no per-offer evidence.
INSERT INTO "supplier_capability_flags" ("id", "adapter", "environment", "class_key", "enabled", "requires_offer_evidence", "reason")
SELECT gen_random_uuid(), 'traveldesk', e.env::"supplier_environment", k.key, true, false,
       'Seeded by migration 20261122120000: proven class allowed by the previous live_book gate (doc 29 §3.3 exception)'
FROM (VALUES ('test'), ('production')) AS e(env)
CROSS JOIN (VALUES ('live.fixed_slot_single.self.internal.per_person'), ('live.fixed_slot_choice.self.internal.per_person')) AS k(key)
ON CONFLICT ("adapter", "environment", "class_key") DO NOTHING;

ALTER TABLE "supplier_offer_capabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_capability_flags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_offer_enablement" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "supplier_offer_capabilities" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "supplier_capability_flags" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "supplier_offer_enablement" FROM %I', r);
    END IF;
  END LOOP;
END $$;
