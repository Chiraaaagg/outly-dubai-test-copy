-- Group C fiscal backbone (doc 93 §1.4, §1.5, §1.8; owner answers O1, O15):
-- gap-free numbering and an immutable snapshot for the combined
-- "Tax invoice / Receipt" (O1) and the tax credit note.
--
-- Forward-only and additive. Old code ignores every new table. Nothing here
-- is used while FISCAL_DOCUMENTS_ENABLED is off (the default everywhere).
--
--   1. `fiscal_series`: one counter row per (legal entity, environment,
--      document type). Numbers come from `next_number` under the row lock,
--      never from a SEQUENCE: a sequence is not transactional, so a rolled
--      back issue would burn a number and leave a gap. Only the TEST series
--      are seeded. The PRODUCTION series rows are inserted at go-live with the
--      prefix and starting number the accountant confirms (A1, input I7); until
--      then a production issue is refused (`series_missing`).
--   2. `fiscal_documents`: append-only (trigger, like `ledger_entries`). One
--      row per documented `customer_money` ledger entry (unique), carrying the
--      seller, lines and totals as printed. No buyer identity here.
--   3. `fiscal_document_parties`: the buyer block, the only mutable part, so a
--      privacy erasure can blank it while number, date and amounts stay (A13).
--
-- VAT values are derived by `src/server/domain/vat.ts` under a rule marked
-- UNCONFIRMED until the accountant answers doc 93 §8B; the rule name used is
-- stored on every row (`vat_rule`).
--
-- RLS on, no grants to the API roles, lock timeout (repository pattern). The
-- foreign keys to existing tables take a short lock on them.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "fiscal_series" (
  "id"           UUID           NOT NULL,
  "legal_entity" TEXT           NOT NULL,
  "environment"  TEXT           NOT NULL,
  "doc_type"     TEXT           NOT NULL,
  "prefix"       TEXT           NOT NULL,
  "next_number"  BIGINT         NOT NULL DEFAULT 1,
  "pad_to"       INTEGER        NOT NULL DEFAULT 6,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fiscal_series_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fiscal_series_entity_check" CHECK ("legal_entity" ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT "fiscal_series_environment_check" CHECK ("environment" IN ('production', 'test')),
  CONSTRAINT "fiscal_series_doc_type_check" CHECK ("doc_type" IN ('tax_invoice', 'tax_credit_note')),
  CONSTRAINT "fiscal_series_prefix_check" CHECK ("prefix" ~ '^[A-Z][A-Z0-9-]{0,23}$'),
  -- A test series always carries the TEST marker, a production series never does.
  CONSTRAINT "fiscal_series_test_prefix_check" CHECK (("environment" = 'test') = ("prefix" LIKE 'TEST-%')),
  CONSTRAINT "fiscal_series_next_check" CHECK ("next_number" >= 1),
  CONSTRAINT "fiscal_series_pad_check" CHECK ("pad_to" BETWEEN 1 AND 12)
);

CREATE UNIQUE INDEX "fiscal_series_entity_env_type_key" ON "fiscal_series" ("legal_entity", "environment", "doc_type");

CREATE TABLE "fiscal_documents" (
  "id"               UUID           NOT NULL,
  "series_id"        UUID           NOT NULL,
  "number"           BIGINT         NOT NULL,
  "display_number"   TEXT           NOT NULL,
  "doc_type"         TEXT           NOT NULL,
  "environment"      TEXT           NOT NULL,
  "order_id"         UUID           NOT NULL,
  "payment_id"       UUID           NOT NULL,
  "refund_id"        UUID,
  "ledger_entry_id"  UUID           NOT NULL,
  "refers_to_id"     UUID,
  "issued_at"        TIMESTAMPTZ(6) NOT NULL,
  "supply_date"      DATE           NOT NULL,
  "currency"         "currency"     NOT NULL,
  "net_minor"        BIGINT         NOT NULL,
  "vat_minor"        BIGINT         NOT NULL,
  "gross_minor"      BIGINT         NOT NULL,
  "seller"           JSONB          NOT NULL,
  "lines"            JSONB          NOT NULL,
  "vat_rule"         TEXT           NOT NULL,
  "template_version" INTEGER        NOT NULL,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fiscal_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fiscal_documents_number_check" CHECK ("number" >= 1),
  CONSTRAINT "fiscal_documents_display_check" CHECK ("display_number" ~ '^[A-Z][A-Z0-9-]{0,23}[0-9]{1,18}$'),
  CONSTRAINT "fiscal_documents_doc_type_check" CHECK ("doc_type" IN ('tax_invoice', 'tax_credit_note')),
  CONSTRAINT "fiscal_documents_environment_check" CHECK ("environment" IN ('production', 'test')),
  -- An invoice documents a capture and refers to nothing; a credit note documents one refund and names its invoice.
  CONSTRAINT "fiscal_documents_kind_refs_check" CHECK (
    ("doc_type" = 'tax_invoice' AND "refund_id" IS NULL AND "refers_to_id" IS NULL)
    OR ("doc_type" = 'tax_credit_note' AND "refund_id" IS NOT NULL AND "refers_to_id" IS NOT NULL)
  ),
  CONSTRAINT "fiscal_documents_amounts_check" CHECK (
    "gross_minor" > 0 AND "net_minor" >= 0 AND "vat_minor" >= 0 AND "net_minor" + "vat_minor" = "gross_minor"
  ),
  CONSTRAINT "fiscal_documents_seller_check" CHECK (jsonb_typeof("seller") = 'object' AND pg_column_size("seller") <= 8192),
  CONSTRAINT "fiscal_documents_lines_check" CHECK (
    jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") BETWEEN 1 AND 50 AND pg_column_size("lines") <= 65536
  ),
  CONSTRAINT "fiscal_documents_vat_rule_check" CHECK ("vat_rule" ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT "fiscal_documents_template_check" CHECK ("template_version" >= 1)
);

CREATE UNIQUE INDEX "fiscal_documents_series_number_key" ON "fiscal_documents" ("series_id", "number");
CREATE UNIQUE INDEX "fiscal_documents_display_number_key" ON "fiscal_documents" ("display_number");
-- One document per ledger entry: a retry of the same capture or refund finds the document already issued.
CREATE UNIQUE INDEX "fiscal_documents_ledger_entry_key" ON "fiscal_documents" ("ledger_entry_id");
-- One credit note per refund.
CREATE UNIQUE INDEX "fiscal_documents_refund_key" ON "fiscal_documents" ("refund_id") WHERE "refund_id" IS NOT NULL;
CREATE INDEX "fiscal_documents_order_idx" ON "fiscal_documents" ("order_id");
CREATE INDEX "fiscal_documents_payment_idx" ON "fiscal_documents" ("payment_id");
CREATE INDEX "fiscal_documents_refers_to_idx" ON "fiscal_documents" ("refers_to_id");

ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_series_id_fkey"
  FOREIGN KEY ("series_id") REFERENCES "fiscal_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_refund_id_fkey"
  FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_ledger_entry_id_fkey"
  FOREIGN KEY ("ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_refers_to_id_fkey"
  FOREIGN KEY ("refers_to_id") REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: an issued document is never edited or deleted; a mistake is corrected by a credit note.
CREATE TRIGGER fiscal_documents_immutable BEFORE UPDATE OR DELETE ON "fiscal_documents"
  FOR EACH ROW EXECUTE FUNCTION outly_raise_immutable();
CREATE TRIGGER fiscal_documents_no_truncate BEFORE TRUNCATE ON "fiscal_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION outly_raise_immutable();

CREATE TABLE "fiscal_document_parties" (
  "fiscal_document_id" UUID           NOT NULL,
  "buyer_name"         TEXT,
  "buyer_email"        TEXT,
  "buyer_address"      TEXT,
  "buyer_trn"          TEXT,
  "erased_at"          TIMESTAMPTZ(6),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fiscal_document_parties_pkey" PRIMARY KEY ("fiscal_document_id"),
  CONSTRAINT "fiscal_document_parties_sizes_check" CHECK (
    ("buyer_name" IS NULL OR char_length("buyer_name") <= 200)
    AND ("buyer_email" IS NULL OR char_length("buyer_email") <= 320)
    AND ("buyer_address" IS NULL OR char_length("buyer_address") <= 500)
    AND ("buyer_trn" IS NULL OR "buyer_trn" ~ '^[0-9]{15}$')
  ),
  -- An erased party holds no identity.
  CONSTRAINT "fiscal_document_parties_erased_check" CHECK (
    "erased_at" IS NULL OR ("buyer_name" IS NULL AND "buyer_email" IS NULL AND "buyer_address" IS NULL AND "buyer_trn" IS NULL)
  )
);

ALTER TABLE "fiscal_document_parties" ADD CONSTRAINT "fiscal_document_parties_document_fkey"
  FOREIGN KEY ("fiscal_document_id") REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- TEST series only (see header). Fixed ids so a re-run never duplicates them.
INSERT INTO "fiscal_series" ("id", "legal_entity", "environment", "doc_type", "prefix", "next_number", "pad_to") VALUES
  ('0193d1c0-0000-7000-8000-00000000c101', 'hpd_tourism', 'test', 'tax_invoice', 'TEST-INV-', 1, 6),
  ('0193d1c0-0000-7000-8000-00000000c102', 'hpd_tourism', 'test', 'tax_credit_note', 'TEST-CN-', 1, 6)
ON CONFLICT DO NOTHING;

ALTER TABLE "fiscal_series" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fiscal_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fiscal_document_parties" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "fiscal_series" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "fiscal_documents" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "fiscal_document_parties" FROM %I', r);
    END IF;
  END LOOP;
END $$;
