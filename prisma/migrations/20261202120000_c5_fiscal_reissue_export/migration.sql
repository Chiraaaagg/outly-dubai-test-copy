-- Group C pre-launch round 2 (owner decisions C-P2, C-P4, 28 Nov 2026; review 109c).
--
-- Forward-only. Old code keeps working: every column it writes keeps its
-- meaning, the new column has a default that describes every existing row, a
-- relaxed NOT NULL accepts every old write, and the re-created checks and
-- unique index accept every row old code writes.
--
--   1. Full tax invoice on request (C-P2). Staff reissue a simplified invoice
--      as a full tax invoice for a VAT-registered buyer: a credit note
--      cancelling the simplified invoice and a new invoice under the next
--      number. Neither documents a money movement, so:
--        - `fiscal_documents.issue_reason`: 'money' (every existing row: a
--          capture or a refund), 'reissue_cancel' (the cancelling credit
--          note), 'reissue_full' (the full tax invoice);
--        - `fiscal_documents.replaces_id`: the full invoice names the
--          simplified invoice it replaces;
--        - `ledger_entry_id` becomes nullable, NULL only for the two reissue
--          reasons (the unique index on it stays);
--        - `fiscal_documents_kind_refs_check` re-created with the reissue cases;
--        - `fiscal_documents_one_invoice_per_payment` re-created on money
--          invoices only, plus one reissue and one cancellation per invoice.
--   2. Monthly CSV export to the accountant (C-P4): `fiscal_exports`, one row
--      per export period (YYYY-MM), so the email goes once per month.
--      `generation` names the send in the provider idempotency key (one key
--      per period; a staff "send again" moves to the next generation). Added
--      in place before this migration was applied anywhere (review 109d R2).
--   3. Staff alerts for a failed export: `fiscal_attention` and `ops_alerts`
--      accept the entity kind 'fiscal_export'. The ops list is the full union
--      of the previous definition (20261130160000) plus the new kind; it never
--      narrows (src/server/__tests__/group-c/ops-alert-entity-kinds.test.ts).
--
-- RLS on, no grants to the API roles, lock timeout (repository pattern).

SET LOCAL lock_timeout = '5s';

-- 1. Reissue ----------------------------------------------------------------

ALTER TABLE "fiscal_documents" ADD COLUMN "issue_reason" TEXT NOT NULL DEFAULT 'money';
ALTER TABLE "fiscal_documents" ADD COLUMN "replaces_id" UUID;
ALTER TABLE "fiscal_documents" ALTER COLUMN "ledger_entry_id" DROP NOT NULL;

ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_issue_reason_check"
  CHECK ("issue_reason" IN ('money', 'reissue_cancel', 'reissue_full')) NOT VALID;
ALTER TABLE "fiscal_documents" VALIDATE CONSTRAINT "fiscal_documents_issue_reason_check";

ALTER TABLE "fiscal_documents" DROP CONSTRAINT "fiscal_documents_kind_refs_check";
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_kind_refs_check" CHECK (
  ("doc_type" = 'tax_invoice' AND "refund_id" IS NULL AND "refers_to_id" IS NULL AND (
     ("issue_reason" = 'money' AND "replaces_id" IS NULL AND "ledger_entry_id" IS NOT NULL)
     OR ("issue_reason" = 'reissue_full' AND "replaces_id" IS NOT NULL AND "ledger_entry_id" IS NULL)))
  OR ("doc_type" = 'tax_credit_note' AND "refers_to_id" IS NOT NULL AND "replaces_id" IS NULL AND (
     ("issue_reason" = 'money' AND "refund_id" IS NOT NULL AND "ledger_entry_id" IS NOT NULL)
     OR ("issue_reason" = 'reissue_cancel' AND "refund_id" IS NULL AND "ledger_entry_id" IS NULL)))
) NOT VALID;
ALTER TABLE "fiscal_documents" VALIDATE CONSTRAINT "fiscal_documents_kind_refs_check";

ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_replaces_id_fkey"
  FOREIGN KEY ("replaces_id") REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "fiscal_documents_one_invoice_per_payment";
CREATE UNIQUE INDEX "fiscal_documents_one_invoice_per_payment" ON "fiscal_documents" ("payment_id")
  WHERE "doc_type" = 'tax_invoice' AND "issue_reason" = 'money';
CREATE UNIQUE INDEX "fiscal_documents_one_reissue_per_invoice" ON "fiscal_documents" ("replaces_id")
  WHERE "replaces_id" IS NOT NULL;
CREATE UNIQUE INDEX "fiscal_documents_one_cancel_per_invoice" ON "fiscal_documents" ("refers_to_id")
  WHERE "issue_reason" = 'reissue_cancel';

-- 2. Monthly export -----------------------------------------------------------

CREATE TABLE "fiscal_exports" (
  "id"              UUID           NOT NULL,
  "period"          TEXT           NOT NULL,
  "environment"     TEXT           NOT NULL,
  "status"          TEXT           NOT NULL DEFAULT 'pending',
  "attempts"        INTEGER        NOT NULL DEFAULT 0,
  "generation"      INTEGER        NOT NULL DEFAULT 1,
  "document_count"  INTEGER,
  "line_count"      INTEGER,
  "provider_id"     TEXT,
  "error_code"      TEXT,
  "locked_until"    TIMESTAMPTZ(6),
  "next_attempt_at" TIMESTAMPTZ(6),
  "sent_at"         TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fiscal_exports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fiscal_exports_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "fiscal_exports_environment_check" CHECK ("environment" IN ('production', 'test')),
  CONSTRAINT "fiscal_exports_status_check" CHECK ("status" IN ('pending', 'sent', 'failed', 'unknown')),
  CONSTRAINT "fiscal_exports_attempts_check" CHECK ("attempts" >= 0 AND "generation" >= 1),
  CONSTRAINT "fiscal_exports_error_check" CHECK ("error_code" IS NULL OR "error_code" ~ '^[a-z0-9_:]{1,64}$'),
  CONSTRAINT "fiscal_exports_sent_check" CHECK ("status" <> 'sent' OR "sent_at" IS NOT NULL)
);
CREATE UNIQUE INDEX "fiscal_exports_period_key" ON "fiscal_exports" ("environment", "period");

ALTER TABLE "fiscal_exports" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "fiscal_exports" FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- 3. Alert entity kinds ---------------------------------------------------------

ALTER TABLE "fiscal_attention" DROP CONSTRAINT "fiscal_attention_kind_check";
ALTER TABLE "fiscal_attention" ADD CONSTRAINT "fiscal_attention_kind_check" CHECK ("entity_kind" IN ('payment', 'ledger_entry', 'fiscal_export')) NOT VALID;
ALTER TABLE "fiscal_attention" VALIDATE CONSTRAINT "fiscal_attention_kind_check";

ALTER TABLE "ops_alerts" DROP CONSTRAINT "ops_alerts_entity_kind_check";
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_entity_kind_check" CHECK ("entity_kind" IN
  ('supplier_account', 'payment_saga', 'order_item', 'supplier_booking', 'supplier_document', 'crm_subject', 'privileged_approval', 'bulk_operation_item',
   'order_account_link', 'customer', 'email_volume', 'payment', 'ledger_entry', 'digest', 'fiscal_export')) NOT VALID;
ALTER TABLE "ops_alerts" VALIDATE CONSTRAINT "ops_alerts_entity_kind_check";
