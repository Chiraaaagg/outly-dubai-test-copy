-- Group C generated documents (doc 93 §2, §4.4; owner answers O1, O11, O12,
-- O15, answer 15): the files OUTLYY draws itself, kept beside the supplier's
-- own files in the same private store.
--
-- Forward-only and additive. Old code ignores the new table. Nothing is
-- written here while FISCAL_DOCUMENTS_ENABLED and BRANDED_ENTRY_PDF_ENABLED
-- are off (the default everywhere).
--
-- `generated_documents`, one row per generated file version:
--   kind  entry_pdf        branded entry PDF carrying the operator's own code
--                          area, copied unchanged (one page per guest);
--         cover_page       the same details with no code area: the fallback
--                          when no code was found (the operator's PDF stays
--                          the entry document);
--         tax_invoice      the combined "Tax invoice / Receipt" (O1), drawn
--                          from its immutable `fiscal_documents` snapshot;
--         tax_credit_note  a credit note, drawn from its snapshot.
--   An entry file names its source supplier document and that file's sha256;
--   a fiscal file names its fiscal document. The supplier's original is never
--   changed and stays downloadable. A file is re-drawn from its snapshot when
--   its stored object is missing or changed; drawing never assigns a number.
--   `status` pending | valid | superseded | failed; `reason_code` a short code.
--
-- RLS on, no grants to the API roles, lock timeout (repository pattern). The
-- foreign keys to existing tables take a short lock on them.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "generated_documents" (
  "id"                 UUID           NOT NULL,
  "kind"               TEXT           NOT NULL,
  "order_id"           UUID           NOT NULL,
  "order_item_id"      UUID,
  "source_document_id" UUID,
  "source_sha256"      TEXT,
  "fiscal_document_id" UUID,
  "version"            INTEGER        NOT NULL DEFAULT 1,
  "status"             TEXT           NOT NULL DEFAULT 'pending',
  "reason_code"        TEXT,
  "storage_key"        TEXT,
  "content_type"       TEXT,
  "byte_size"          INTEGER,
  "sha256"             TEXT,
  "template_version"   INTEGER        NOT NULL,
  "snapshot"           JSONB          NOT NULL DEFAULT '{}'::jsonb,
  "attempts"           INTEGER        NOT NULL DEFAULT 0,
  "next_attempt_at"    TIMESTAMPTZ(6),
  "locked_until"       TIMESTAMPTZ(6),
  "validated_at"       TIMESTAMPTZ(6),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generated_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "generated_documents_kind_check" CHECK ("kind" IN ('entry_pdf', 'cover_page', 'tax_invoice', 'tax_credit_note')),
  CONSTRAINT "generated_documents_status_check" CHECK ("status" IN ('pending', 'valid', 'superseded', 'failed')),
  -- Entry files come from one supplier document of one item; fiscal files from one fiscal document of the order.
  CONSTRAINT "generated_documents_source_check" CHECK (
    ("kind" IN ('entry_pdf', 'cover_page') AND "order_item_id" IS NOT NULL AND "source_document_id" IS NOT NULL
      AND "source_sha256" ~ '^[0-9a-f]{64}$' AND "fiscal_document_id" IS NULL)
    OR ("kind" IN ('tax_invoice', 'tax_credit_note') AND "fiscal_document_id" IS NOT NULL
      AND "source_document_id" IS NULL AND "source_sha256" IS NULL)
  ),
  CONSTRAINT "generated_documents_storage_key_check" CHECK ("storage_key" IS NULL OR "storage_key" ~ '^(test|production|development)/[0-9a-f]{32}$'),
  CONSTRAINT "generated_documents_sha_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  -- A valid file has its stored object, size and checksum.
  CONSTRAINT "generated_documents_valid_check" CHECK (
    "status" <> 'valid' OR ("storage_key" IS NOT NULL AND "sha256" IS NOT NULL AND "byte_size" > 0 AND "content_type" = 'application/pdf' AND "validated_at" IS NOT NULL)
  ),
  CONSTRAINT "generated_documents_reason_check" CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT "generated_documents_version_check" CHECK ("version" >= 1 AND "template_version" >= 1 AND "attempts" >= 0),
  CONSTRAINT "generated_documents_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object' AND pg_column_size("snapshot") <= 65536)
);

CREATE UNIQUE INDEX "generated_documents_storage_key_key" ON "generated_documents" ("storage_key");
-- One live (pending or valid) entry file per item and kind, and one per fiscal document.
CREATE UNIQUE INDEX "generated_documents_one_live_entry" ON "generated_documents" ("order_item_id", "kind")
  WHERE "kind" IN ('entry_pdf', 'cover_page') AND "status" IN ('pending', 'valid');
CREATE UNIQUE INDEX "generated_documents_one_live_fiscal" ON "generated_documents" ("fiscal_document_id")
  WHERE "fiscal_document_id" IS NOT NULL AND "status" IN ('pending', 'valid');
CREATE UNIQUE INDEX "generated_documents_source_version_key" ON "generated_documents" ("source_document_id", "kind", "version")
  WHERE "source_document_id" IS NOT NULL;
CREATE INDEX "generated_documents_order_idx" ON "generated_documents" ("order_id");
CREATE INDEX "generated_documents_due_idx" ON "generated_documents" ("status", "next_attempt_at") WHERE "status" = 'pending';

ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_order_item_id_fkey"
  FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_source_document_id_fkey"
  FOREIGN KEY ("source_document_id") REFERENCES "supplier_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_fiscal_document_id_fkey"
  FOREIGN KEY ("fiscal_document_id") REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "generated_documents" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "generated_documents" FROM %I', r);
    END IF;
  END LOOP;
END $$;
