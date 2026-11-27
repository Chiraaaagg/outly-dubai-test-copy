-- Group C: what the fiscal step and the refund reconciliation leave for staff
-- (doc 93 §1.5 last row, §9 "Refund without a refund row").
--
-- Forward-only and additive.
--   1. New table `fiscal_attention`: one open row per (entity, reason) the
--      fiscal step could not document automatically, or the reconciliation
--      found: a payment whose refunded total is above its settled `refunds`
--      rows (a refund made in the Stripe dashboard; seen once in
--      production), an unclassified product, an amount mismatch, a missing
--      production series or seller details. Detection only: nothing is ever
--      issued from here automatically. `detail` holds codes and counts, never
--      a customer detail; amounts stay out of alert emails.
--   2. `ops_alerts.entity_kind` also allows `payment` and `ledger_entry`, so
--      these reach the existing ops alert email (codes and ids only).
--
-- RLS on, no grants to the API roles, lock timeout (repository pattern).

SET LOCAL lock_timeout = '5s';

CREATE TABLE "fiscal_attention" (
  "id"           UUID           NOT NULL,
  "entity_kind"  TEXT           NOT NULL,
  "entity_id"    UUID           NOT NULL,
  "order_id"     UUID,
  "reason"       TEXT           NOT NULL,
  "detail"       JSONB          NOT NULL DEFAULT '{}'::jsonb,
  "raised_at"    TIMESTAMPTZ(6) NOT NULL,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
  "resolved_at"  TIMESTAMPTZ(6),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fiscal_attention_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fiscal_attention_kind_check" CHECK ("entity_kind" IN ('payment', 'ledger_entry')),
  CONSTRAINT "fiscal_attention_reason_check" CHECK ("reason" ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT "fiscal_attention_detail_check" CHECK (jsonb_typeof("detail") = 'object' AND pg_column_size("detail") <= 4096),
  CONSTRAINT "fiscal_attention_times_check" CHECK ("last_seen_at" >= "raised_at" AND ("resolved_at" IS NULL OR "resolved_at" >= "raised_at"))
);

CREATE UNIQUE INDEX "fiscal_attention_open_key" ON "fiscal_attention" ("entity_kind", "entity_id", "reason") WHERE "resolved_at" IS NULL;
CREATE INDEX "fiscal_attention_raised_idx" ON "fiscal_attention" ("raised_at") WHERE "resolved_at" IS NULL;

ALTER TABLE "fiscal_attention" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "fiscal_attention" FROM %I', r);
    END IF;
  END LOOP;
END $$;

ALTER TABLE "ops_alerts" DROP CONSTRAINT "ops_alerts_entity_kind_check";
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_entity_kind_check" CHECK ("entity_kind" IN
  ('supplier_account', 'payment_saga', 'order_item', 'supplier_booking', 'supplier_document', 'crm_subject', 'privileged_approval', 'bulk_operation_item', 'payment', 'ledger_entry', 'digest')) NOT VALID;
ALTER TABLE "ops_alerts" VALIDATE CONSTRAINT "ops_alerts_entity_kind_check";
