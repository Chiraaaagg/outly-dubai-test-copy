-- B2 server quotes, order-bound contact verification and margin inputs
-- (doc 22 §23 B2; contracts in src/server/quotes/contracts.ts). Additive
-- only: three new tables, nullable columns on two live tables, one settings
-- row inserted only when absent. Nothing is dropped, no existing row is
-- rewritten and no existing grant is removed.
--
-- Historic order items keep NULL in every new column: they were priced by the
-- pre-B2 path and have no quote, allocation or margin snapshot. Mappings get
-- `approved_offer_hash` NULL; the catalogue service computes it from the
-- current snapshot, so there is no SQL backfill.
--
-- The three new tables get RLS and the Supabase API-role revokes at the end
-- (prisma/migrations/README.md); src/server/__tests__/schema-rls.test.ts
-- checks it.

-- Statements 4 to 6 alter live tables; fail fast behind a long query.
SET LOCAL lock_timeout = '5s';

-- 1. Guest checkout sessions. No guest session existed before B2: `guests`
-- is a traveller record on an order, not a browser identity. Opaque bearer
-- token like customer_sessions; only its SHA-256 is stored. A guest session
-- never implies a customer account.
CREATE TABLE "guest_sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "guest_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "guest_sessions_token_hash_key" ON "guest_sessions" ("token_hash");
CREATE INDEX "guest_sessions_expires_idx" ON "guest_sessions" ("expires_at");

ALTER TABLE "guest_sessions" ADD CONSTRAINT "gs_expiry_check" CHECK ("expires_at" > "created_at");

-- 2. Server quotes (QuoteSnapshot). `lines` holds QuoteLineSnapshot[] with
-- bigint amounts as decimal strings; `request` is the canonical QuoteRequest
-- the fingerprint was computed over.
--   owner        exactly one of customer_id / guest_session_id, matching
--                owner_kind.
--   status       active -> used (bound to one order) | expired | superseded.
--   fingerprint  sha256 hex over the canonical request and owner. Unique per
--                owner among ACTIVE quotes only, so the same cart can be quoted
--                again once the earlier quote is used, expired or superseded;
--                the service supersedes or returns the active one on replay.
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "owner_kind" TEXT NOT NULL,
    "customer_id" UUID,
    "guest_session_id" UUID,
    "currency" "currency" NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "lines" JSONB NOT NULL,
    "request" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_by_order_id" UUID,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quotes_customer_fingerprint_active_key" ON "quotes" ("customer_id", "fingerprint")
  WHERE "status" = 'active' AND "customer_id" IS NOT NULL;
CREATE UNIQUE INDEX "quotes_guest_fingerprint_active_key" ON "quotes" ("guest_session_id", "fingerprint")
  WHERE "status" = 'active' AND "guest_session_id" IS NOT NULL;
-- One order consumes at most one quote.
CREATE UNIQUE INDEX "quotes_used_by_order_id_key" ON "quotes" ("used_by_order_id");
CREATE INDEX "quotes_customer_status_idx" ON "quotes" ("customer_id", "status");
CREATE INDEX "quotes_guest_status_idx" ON "quotes" ("guest_session_id", "status");
CREATE INDEX "quotes_expires_idx" ON "quotes" ("expires_at");

-- Customers are soft-deleted and orders are anonymised, never deleted, so a
-- quote keeps its owner and order. A guest session purge must delete the
-- session's unused quotes first.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_guest_session_id_fkey"
  FOREIGN KEY ("guest_session_id") REFERENCES "guest_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_used_by_order_id_fkey"
  FOREIGN KEY ("used_by_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quotes" ADD CONSTRAINT "quotes_owner_check" CHECK (
  ("owner_kind" = 'customer' AND "customer_id" IS NOT NULL AND "guest_session_id" IS NULL)
  OR ("owner_kind" = 'guest' AND "guest_session_id" IS NOT NULL AND "customer_id" IS NULL));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_status_check"
  CHECK ("status" IN ('active', 'used', 'expired', 'superseded'));
-- A quote is used exactly when it names its order.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_used_order_check"
  CHECK (("status" = 'used') = ("used_by_order_id" IS NOT NULL));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_total_check" CHECK ("total_minor" >= 0);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_lines_check" CHECK (jsonb_typeof("lines") = 'array');
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_request_check" CHECK (jsonb_typeof("request") = 'object');
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_expiry_check" CHECK ("expires_at" > "created_at");

-- 3. Order-bound recovery contact (TKT-4, ContactVerification). Written
-- before payment against the quote; order_id is bound when the order is
-- created from that quote. Verifying never creates a customer row. The
-- contact itself lives on the order; only its sha256 hex is stored here.
CREATE TABLE "order_contact_verifications" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "order_id" UUID,
    "channel" TEXT NOT NULL,
    "contact_hash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_contact_verifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ocv_quote_channel_key" ON "order_contact_verifications" ("quote_id", "channel");
CREATE INDEX "ocv_order_idx" ON "order_contact_verifications" ("order_id");
CREATE INDEX "ocv_contact_hash_idx" ON "order_contact_verifications" ("contact_hash");

ALTER TABLE "order_contact_verifications" ADD CONSTRAINT "order_contact_verifications_quote_id_fkey"
  FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_contact_verifications" ADD CONSTRAINT "order_contact_verifications_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_contact_verifications" ADD CONSTRAINT "ocv_channel_check" CHECK ("channel" IN ('phone', 'email'));
-- A method proves only its own channel.
ALTER TABLE "order_contact_verifications" ADD CONSTRAINT "ocv_method_check" CHECK (
  ("channel" = 'phone' AND "method" IN ('otp_sms', 'otp_whatsapp'))
  OR ("channel" = 'email' AND "method" = 'email_code'));
ALTER TABLE "order_contact_verifications" ADD CONSTRAINT "ocv_contact_hash_check" CHECK ("contact_hash" ~ '^[0-9a-f]{64}$');

-- 4. Per-item charged amount and allocations (PRD-8, PAY-11), in minor units of
-- the charged currency, plus the quote and margin snapshot the item was sold
-- from. All NULL for historic rows. Currency and amount are set together;
-- allocations exist only with a charged amount.
ALTER TABLE "order_items" ADD COLUMN "charged_currency" "currency";
ALTER TABLE "order_items" ADD COLUMN "charged_amount_minor" BIGINT;
ALTER TABLE "order_items" ADD COLUMN "discount_alloc_minor" BIGINT;
ALTER TABLE "order_items" ADD COLUMN "tax_alloc_minor" BIGINT;
ALTER TABLE "order_items" ADD COLUMN "quote_id" UUID;
ALTER TABLE "order_items" ADD COLUMN "margin_snapshot" JSONB;

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quote_id_fkey"
  FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "order_items_quote_idx" ON "order_items" ("quote_id");

ALTER TABLE "order_items" ADD CONSTRAINT "oi_charged_amounts_check" CHECK (
  ("charged_amount_minor" IS NULL OR "charged_amount_minor" >= 0)
  AND ("discount_alloc_minor" IS NULL OR "discount_alloc_minor" >= 0)
  AND ("tax_alloc_minor" IS NULL OR "tax_alloc_minor" >= 0));
ALTER TABLE "order_items" ADD CONSTRAINT "oi_charged_pair_check"
  CHECK (("charged_currency" IS NULL) = ("charged_amount_minor" IS NULL));
ALTER TABLE "order_items" ADD CONSTRAINT "oi_alloc_needs_charge_check"
  CHECK ("charged_amount_minor" IS NOT NULL OR ("discount_alloc_minor" IS NULL AND "tax_alloc_minor" IS NULL));
ALTER TABLE "order_items" ADD CONSTRAINT "oi_margin_snapshot_check"
  CHECK ("margin_snapshot" IS NULL OR jsonb_typeof("margin_snapshot") = 'object');

-- 5. The supplier offer terms an editor approved for a mapping (PRD-4,
-- SUP-14). NULL until the catalogue service computes it; a NULL hash never
-- passes readiness.
ALTER TABLE "product_supplier_mappings" ADD COLUMN "approved_offer_hash" TEXT;

-- 6. Margin policy (PAY-11), versioned settings, never a code constant. The
-- 1,500 bps floor is provisional and configurable; an existing row (an owner
-- edit) is never overwritten. effectiveFrom is this migration's time.
INSERT INTO "settings" ("key", "value", "updated_at")
VALUES (
  'pricing.margin_policy',
  jsonb_build_object(
    'version', 1,
    'floorBps', 1500,
    'effectiveFrom', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- 7. Row level security and no Supabase API grants on the new tables. None
-- owns a sequence (UUID keys).
ALTER TABLE "guest_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_contact_verifications" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "guest_sessions", "quotes", "order_contact_verifications" FROM %I', r);
    END IF;
  END LOOP;
END $$;
