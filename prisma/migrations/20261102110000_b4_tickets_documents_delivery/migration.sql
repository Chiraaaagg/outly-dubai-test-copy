-- B4: tickets, private storage and durable delivery (doc 22 §23 B4).
--
-- Forward-only and additive. New tables:
--   supplier_documents       one row per document version (TKT-1, TKT-2, TKT-3, F12, F13, F36, F47, F48)
--   supplier_ticket_codes    encrypted admission codes per version (TKT-1, PRV-5)
--   guest_capability_grants  hashed guest capability tokens (TKT-5, F39)
--   suppressed_contacts      keyed-hash suppression list (PRV-3)
-- Changed tables:
--   notifications            outbox dedup key, sender lock, attention flag (TKT-6)
--   notification_status      new value `unknown` (TKT-6)
--   role_permissions         tickets.view and tickets.resend for existing roles (§24.3, F55)
--
-- No existing row is rewritten. The notifications columns are nullable with
-- no default, so adding them is a catalogue-only change.

-- Fail fast behind a long query.
SET LOCAL lock_timeout = '5s';

-- 1. Notification outbox (TKT-6).
-- ADD VALUE is allowed inside a transaction on PG 12+; the value is not used
-- in this migration.
ALTER TYPE "notification_status" ADD VALUE IF NOT EXISTS 'unknown';

ALTER TABLE "notifications"
  ADD COLUMN "dedup_key" TEXT,
  ADD COLUMN "locked_until" TIMESTAMPTZ(6),
  ADD COLUMN "attention_required_at" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "notifications_dedup_key_key" ON "notifications" ("dedup_key");

-- 2. Supplier documents.
CREATE TABLE "supplier_documents" (
  "id" UUID NOT NULL,
  "supplier_booking_id" UUID NOT NULL,
  "order_id" UUID,
  "order_item_id" UUID,
  "kind" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "storage_key" TEXT,
  "content_type" TEXT,
  "byte_size" INTEGER,
  "sha256" TEXT,
  "units_expected" JSONB,
  "units_issued" JSONB,
  "quarantine_reason" TEXT,
  "customer_visible" BOOLEAN NOT NULL DEFAULT true,
  "issued_evidence" TEXT,
  "fetch_attempts" INTEGER NOT NULL DEFAULT 0,
  "next_fetch_at" TIMESTAMPTZ(6),
  "locked_until" TIMESTAMPTZ(6),
  "attention_required_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validated_at" TIMESTAMPTZ(6),
  "invalidated_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_documents_kind_check" CHECK ("kind" IN ('ticket_codes', 'tickets_pdf', 'voucher_pdf')),
  CONSTRAINT "supplier_documents_status_check" CHECK ("status" IN ('pending', 'valid', 'incomplete', 'quarantined', 'superseded', 'failed')),
  CONSTRAINT "supplier_documents_source_check" CHECK ("source" IN ('confirm_response', 'create_response', 'document_read', 'pdf_download')),
  CONSTRAINT "supplier_documents_version_check" CHECK ("version" >= 1),
  CONSTRAINT "supplier_documents_byte_size_check" CHECK ("byte_size" IS NULL OR "byte_size" >= 0),
  CONSTRAINT "supplier_documents_sha256_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  -- Object keys are random ids only: `<env>/<32 hex>`, never a reference, name or code (TKT-3).
  CONSTRAINT "supplier_documents_storage_key_check" CHECK ("storage_key" IS NULL OR "storage_key" ~ '^(test|production|development)/[0-9a-f]{32}$'),
  -- The code set has no object; a PDF is only valid with its object, size and checksum.
  CONSTRAINT "supplier_documents_codes_no_object" CHECK ("kind" <> 'ticket_codes' OR "storage_key" IS NULL),
  CONSTRAINT "supplier_documents_valid_pdf_complete" CHECK (
    "kind" = 'ticket_codes' OR "status" <> 'valid' OR ("storage_key" IS NOT NULL AND "sha256" IS NOT NULL AND "byte_size" IS NOT NULL)
  ),
  CONSTRAINT "supplier_documents_fetch_attempts_check" CHECK ("fetch_attempts" >= 0)
);

CREATE UNIQUE INDEX "supplier_documents_booking_kind_version_key" ON "supplier_documents" ("supplier_booking_id", "kind", "version");
CREATE UNIQUE INDEX "supplier_documents_storage_key_key" ON "supplier_documents" ("storage_key");
-- At most one served version per booking and kind: a reissue supersedes the old one first.
CREATE UNIQUE INDEX "supplier_documents_one_valid" ON "supplier_documents" ("supplier_booking_id", "kind") WHERE "status" = 'valid';
CREATE INDEX "supplier_documents_order_item_idx" ON "supplier_documents" ("order_item_id");
CREATE INDEX "supplier_documents_order_idx" ON "supplier_documents" ("order_id");
CREATE INDEX "supplier_documents_due_idx" ON "supplier_documents" ("next_fetch_at") WHERE "status" IN ('pending', 'incomplete');

ALTER TABLE "supplier_documents"
  ADD CONSTRAINT "supplier_documents_supplier_booking_id_fkey" FOREIGN KEY ("supplier_booking_id") REFERENCES "supplier_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_documents_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A document's order and item are its booking's, never another order's.
CREATE OR REPLACE FUNCTION outly_supplier_documents_match_booking() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "supplier_bookings" b
    WHERE b."id" = NEW."supplier_booking_id"
      AND b."order_id" IS NOT DISTINCT FROM NEW."order_id"
      AND b."order_item_id" IS NOT DISTINCT FROM NEW."order_item_id"
  ) THEN
    RAISE EXCEPTION 'supplier_documents: order and item must be those of supplier booking %', NEW."supplier_booking_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER supplier_documents_match_booking BEFORE INSERT OR UPDATE OF "supplier_booking_id", "order_id", "order_item_id" ON "supplier_documents"
  FOR EACH ROW EXECUTE FUNCTION outly_supplier_documents_match_booking();

-- 3. Ticket codes (encrypted; PRV-5 format v2).
CREATE TABLE "supplier_ticket_codes" (
  "id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "supplier_booking_id" UUID NOT NULL,
  "unit_index" INTEGER NOT NULL,
  "ticket_for" TEXT NOT NULL,
  "ticket_type_id" TEXT,
  "ticket_type_name" TEXT,
  "display_type" INTEGER,
  "code_ciphertext" TEXT NOT NULL,
  "code_key_id" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "valid_until" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_ticket_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_ticket_codes_unit_index_check" CHECK ("unit_index" >= 0),
  CONSTRAINT "supplier_ticket_codes_ticket_for_check" CHECK ("ticket_for" IN ('adult', 'child', 'infant', 'unknown')),
  -- Never plaintext: only the v2 ciphertext of the ticket_codes ring, under the key it names.
  CONSTRAINT "supplier_ticket_codes_ciphertext_check" CHECK ("code_ciphertext" ~ '^v2\.ticket_codes\.[a-z0-9]{1,16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  CONSTRAINT "supplier_ticket_codes_key_id_check" CHECK ("code_ciphertext" LIKE ('v2.ticket_codes.' || "code_key_id" || '.%')),
  CONSTRAINT "supplier_ticket_codes_hash_check" CHECK ("code_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "supplier_ticket_codes_document_unit_key" ON "supplier_ticket_codes" ("document_id", "unit_index");
CREATE INDEX "supplier_ticket_codes_booking_idx" ON "supplier_ticket_codes" ("supplier_booking_id");

ALTER TABLE "supplier_ticket_codes"
  ADD CONSTRAINT "supplier_ticket_codes_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "supplier_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_ticket_codes_supplier_booking_id_fkey" FOREIGN KEY ("supplier_booking_id") REFERENCES "supplier_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Codes belong to a ticket_codes document of the same booking.
CREATE OR REPLACE FUNCTION outly_ticket_codes_match_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "supplier_documents" d
    WHERE d."id" = NEW."document_id" AND d."kind" = 'ticket_codes' AND d."supplier_booking_id" = NEW."supplier_booking_id"
  ) THEN
    RAISE EXCEPTION 'supplier_ticket_codes: document % is not a ticket_codes document of booking %', NEW."document_id", NEW."supplier_booking_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER supplier_ticket_codes_match_document BEFORE INSERT ON "supplier_ticket_codes"
  FOR EACH ROW EXECUTE FUNCTION outly_ticket_codes_match_document();

-- A code row never changes, except that a key rotation may re-wrap its
-- ciphertext (code_ciphertext and code_key_id together). Deleting is allowed
-- for retention and erasure.
CREATE OR REPLACE FUNCTION outly_ticket_codes_rewrap_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'code_ciphertext' - 'code_key_id') IS DISTINCT FROM (to_jsonb(OLD) - 'code_ciphertext' - 'code_key_id') THEN
    RAISE EXCEPTION 'supplier_ticket_codes: only a key re-wrap may update a row' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER supplier_ticket_codes_rewrap_only BEFORE UPDATE ON "supplier_ticket_codes"
  FOR EACH ROW EXECUTE FUNCTION outly_ticket_codes_rewrap_only();

-- 4. Guest capability grants (TKT-5).
CREATE TABLE "guest_capability_grants" (
  "id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "token_ciphertext" TEXT,
  "order_id" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "issued_for" TEXT NOT NULL,
  "notification_id" UUID,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "revoke_reason" TEXT,
  "exchanged_at" TIMESTAMPTZ(6),
  "exchange_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "guest_capability_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guest_capability_grants_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "guest_capability_grants_token_ciphertext_check" CHECK ("token_ciphertext" IS NULL OR "token_ciphertext" LIKE 'v2.capability_tokens.%'),
  CONSTRAINT "guest_capability_grants_purpose_check" CHECK ("purpose" IN ('view_status', 'download_tickets', 'cancel_request')),
  CONSTRAINT "guest_capability_grants_issued_for_check" CHECK ("issued_for" IN ('ticket_notification', 'status_notification', 'staff_resend')),
  CONSTRAINT "guest_capability_grants_revoke_reason_check" CHECK ("revoke_reason" IS NULL OR "revoke_reason" IN ('superseded', 'staff', 'erasure', 'order_cancelled')),
  CONSTRAINT "guest_capability_grants_revoked_with_reason" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL)),
  CONSTRAINT "guest_capability_grants_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "guest_capability_grants_exchange_count_check" CHECK ("exchange_count" >= 0)
);

CREATE UNIQUE INDEX "guest_capability_grants_token_hash_key" ON "guest_capability_grants" ("token_hash");
CREATE INDEX "guest_capability_grants_order_purpose_idx" ON "guest_capability_grants" ("order_id", "purpose");

ALTER TABLE "guest_capability_grants"
  ADD CONSTRAINT "guest_capability_grants_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A revoked grant stays revoked; its token hash, order and purpose never change.
CREATE OR REPLACE FUNCTION outly_capability_grants_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."token_hash" <> OLD."token_hash" OR NEW."order_id" <> OLD."order_id" OR NEW."purpose" <> OLD."purpose" OR NEW."expires_at" > OLD."expires_at" THEN
    RAISE EXCEPTION 'guest_capability_grants: token, order and purpose are fixed and expiry cannot be extended' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'guest_capability_grants: a revoked grant stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guest_capability_grants_guard BEFORE UPDATE ON "guest_capability_grants"
  FOR EACH ROW EXECUTE FUNCTION outly_capability_grants_guard();

-- 5. Hashed suppression (PRV-3).
CREATE TABLE "suppressed_contacts" (
  "contact_hash" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "suppressed_contacts_pkey" PRIMARY KEY ("contact_hash"),
  CONSTRAINT "suppressed_contacts_hash_check" CHECK ("contact_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "suppressed_contacts_channel_check" CHECK ("channel" IN ('phone', 'email'))
);

-- 6. Staff ticket permissions (§24.3, F55) for the roles that exist. On a
-- fresh database the seed creates the roles afterwards from
-- src/server/lib/permissions.ts, which carries the same matrix. Nothing is deleted.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", g."permission"
FROM "roles" r
JOIN (VALUES
    ('admin', 'tickets.view'),
    ('admin', 'tickets.resend'),
    ('ops', 'tickets.view'),
    ('ops', 'tickets.resend')
  ) AS g("code", "permission") ON g."code" = r."code"
ON CONFLICT DO NOTHING;

-- 7. Row level security and no Supabase API grants on the new tables.
ALTER TABLE "supplier_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_ticket_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guest_capability_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppressed_contacts" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "supplier_documents" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "supplier_ticket_codes" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "guest_capability_grants" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "suppressed_contacts" FROM %I', r);
    END IF;
  END LOOP;
END $$;
