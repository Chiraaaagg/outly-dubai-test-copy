-- Group B: customer sign-in on Supabase Auth (side-session plan 92, owner
-- answers 91 Q9, Q10, Q-B1..Q-B6).
--
-- Supabase Auth proves who the customer is; OUTLYY keeps the account and the
-- session. This migration adds what the sign-in needs and nothing else:
--
--   1. `customers.phone_e164` becomes nullable: an email or Google account
--      has no phone until one is linked (owner Q9). The unique index stays;
--      Postgres allows many NULLs. Metadata-only change.
--   2. `customer_identities`: one external identity (the Supabase Auth user
--      id) to one customer. Never keyed on email.
--   3. `customer_auth_intents`: the gate for the Send Email / Before User
--      Created hooks. A hook sends a code, or lets a user be created, only
--      for a live intent our own start route wrote. Hashes only.
--   4. `order_account_links`: every automatic attach of a guest order to an
--      account (rule a: verified email equals the order's verified email;
--      rule b: the same browser guest session paid), with the "this was not
--      me" token (hash, plus the token encrypted only until the notice email's
--      outcome is known), and the detach.
--   5. `email_send_counters`: daily counts of emails sent outside the
--      notification outbox (sign-in, checkout and recovery codes), so the
--      Resend free-tier volume alert sees every email (owner Q-B6). No
--      contact data.
--   6. `ops_alerts_entity_kind_check` widened with 'order_account_link',
--      'customer' and 'email_volume' (and Group C's 'payment' and
--      'ledger_entry', the same union as 20261130160000).
--   7. Hardening (plan 92 §3.3 item 2): EXECUTE on the public trigger
--      functions revoked from PUBLIC and the Supabase API roles, and default
--      privileges so future functions created by this role are not
--      executable by PUBLIC or the API roles. The app connects as the owner
--      and triggers fire without an EXECUTE check, so nothing changes for it.
--
-- Forward-compatible: every statement adds a table, adds a nullable column
-- path, or widens a check. The build deployed before this migration runs
-- unchanged as long as no customer row has a NULL phone, and none can exist
-- while CUSTOMER_SUPABASE_AUTH_ENABLED is off. Rollback is the flag, never a
-- redeploy of a build older than this one once a phone-less customer exists
-- (the older Prisma client types phone_e164 as non-null). Down path if ever
-- needed: detach and delete phone-less customers first, then SET NOT NULL.
--
-- RLS on and no API-role grants for every new table (prisma/migrations/README.md).

SET LOCAL lock_timeout = '5s';

-- 1. Accounts without a phone.
ALTER TABLE "customers" ALTER COLUMN "phone_e164" DROP NOT NULL;

-- 2. Identity map.
CREATE TABLE "customer_identities" (
  "id"                UUID PRIMARY KEY,
  "customer_id"       UUID NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "provider"          TEXT NOT NULL,
  "provider_subject"  TEXT NOT NULL,
  "email"             TEXT,
  "email_hash"        TEXT,
  "email_verified_at" TIMESTAMPTZ(6),
  "last_method"       TEXT NOT NULL,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_used_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "customer_identities_provider_check" CHECK ("provider" IN ('supabase')),
  CONSTRAINT "customer_identities_subject_check" CHECK (char_length("provider_subject") BETWEEN 1 AND 128),
  CONSTRAINT "customer_identities_email_hash_check" CHECK ("email_hash" IS NULL OR "email_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "customer_identities_email_lower_check" CHECK ("email" IS NULL OR ("email" = lower("email") AND char_length("email") <= 254)),
  CONSTRAINT "customer_identities_method_check" CHECK ("last_method" IN ('email_otp', 'google', 'apple', 'sms_otp', 'whatsapp_otp')),
  CONSTRAINT "customer_identities_provider_subject_key" UNIQUE ("provider", "provider_subject"),
  CONSTRAINT "customer_identities_customer_provider_key" UNIQUE ("customer_id", "provider")
);
CREATE INDEX "customer_identities_email_hash_idx" ON "customer_identities"("email_hash");

-- 3. Hook gate.
CREATE TABLE "customer_auth_intents" (
  "id"           UUID PRIMARY KEY,
  "channel"      TEXT NOT NULL,
  "contact_hash" TEXT NOT NULL,
  "ip_hash"      TEXT,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at"   TIMESTAMPTZ(6) NOT NULL,
  "consumed_at"  TIMESTAMPTZ(6),
  CONSTRAINT "customer_auth_intents_channel_check" CHECK ("channel" IN ('email', 'phone')),
  CONSTRAINT "customer_auth_intents_hash_check" CHECK ("contact_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "customer_auth_intents_expiry_check" CHECK ("expires_at" > "created_at")
);
CREATE INDEX "customer_auth_intents_open_idx" ON "customer_auth_intents"("channel", "contact_hash") WHERE "consumed_at" IS NULL;
CREATE INDEX "customer_auth_intents_expires_idx" ON "customer_auth_intents"("expires_at");

-- 4. Attach audit and "this was not me".
CREATE TABLE "order_account_links" (
  "id"                       UUID PRIMARY KEY,
  "order_id"                 UUID NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "customer_id"              UUID NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "identity_id"              UUID REFERENCES "customer_identities"("id") ON DELETE SET NULL,
  "rule"                     TEXT NOT NULL,
  "verification_id"          UUID REFERENCES "order_contact_verifications"("id") ON DELETE RESTRICT,
  "guest_session_id"         UUID REFERENCES "guest_sessions"("id") ON DELETE SET NULL,
  "notification_id"          UUID,
  "attached_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "dispute_token_hash"       TEXT,
  "dispute_token_ciphertext" TEXT,
  "dispute_expires_at"       TIMESTAMPTZ(6),
  "detached_at"              TIMESTAMPTZ(6),
  "detach_reason"            TEXT,
  CONSTRAINT "order_account_links_rule_check" CHECK ("rule" IN ('verified_email', 'guest_session', 'phone_verification', 'staff')),
  CONSTRAINT "order_account_links_token_hash_check" CHECK ("dispute_token_hash" IS NULL OR "dispute_token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "order_account_links_token_expiry_check" CHECK (("dispute_token_hash" IS NULL) = ("dispute_expires_at" IS NULL)),
  CONSTRAINT "order_account_links_detach_reason_check" CHECK ("detach_reason" IS NULL OR "detach_reason" IN ('not_me', 'staff', 'erasure')),
  CONSTRAINT "order_account_links_detach_pair_check" CHECK (("detached_at" IS NULL) = ("detach_reason" IS NULL)),
  CONSTRAINT "order_account_links_email_rule_check" CHECK ("rule" <> 'verified_email' OR "verification_id" IS NOT NULL),
  CONSTRAINT "order_account_links_dispute_token_hash_key" UNIQUE ("dispute_token_hash")
);
-- A guest session is purged by retention 1 day after it expires; the link keeps the rule, the session id goes to NULL.
-- The rule-b proof is recorded in the audit row written at attach time.
CREATE UNIQUE INDEX "order_account_links_one_active" ON "order_account_links"("order_id") WHERE "detached_at" IS NULL;
CREATE INDEX "order_account_links_customer_idx" ON "order_account_links"("customer_id");
CREATE INDEX "order_account_links_order_idx" ON "order_account_links"("order_id");
CREATE INDEX "order_account_links_detached_idx" ON "order_account_links"("detached_at") WHERE "detached_at" IS NOT NULL;

-- 5. Email volume outside the outbox.
CREATE TABLE "email_send_counters" (
  "day"        DATE NOT NULL,
  "kind"       TEXT NOT NULL,
  "count"      INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "email_send_counters_pkey" PRIMARY KEY ("day", "kind"),
  CONSTRAINT "email_send_counters_kind_check" CHECK ("kind" IN ('signin_code', 'checkout_code', 'recovery_code')),
  CONSTRAINT "email_send_counters_count_check" CHECK ("count" >= 0)
);

-- 6. Ops alert entity kinds (form of migration 20261127160000). The list is the union with Group C's
--    20261130160000_c4_fiscal_attention ('payment', 'ledger_entry'), so whichever of the two reaches a database
--    last, the other's kinds stay allowed and VALIDATE cannot fail on its rows.
ALTER TABLE "ops_alerts" DROP CONSTRAINT "ops_alerts_entity_kind_check";
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_entity_kind_check" CHECK ("entity_kind" IN
  ('supplier_account', 'payment_saga', 'order_item', 'supplier_booking', 'supplier_document', 'crm_subject', 'privileged_approval', 'bulk_operation_item',
   'order_account_link', 'customer', 'email_volume', 'payment', 'ledger_entry', 'digest')) NOT VALID;
ALTER TABLE "ops_alerts" VALIDATE CONSTRAINT "ops_alerts_entity_kind_check";

-- RLS and no API-role grants on the new tables.
ALTER TABLE "customer_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_auth_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_account_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_send_counters" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['customer_identities', 'customer_auth_intents', 'order_account_links', 'email_send_counters'] LOOP
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- 7. Trigger functions are not callable by PUBLIC or the API roles; future functions of this role neither.
DO $$
DECLARE f record; r text;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype AND pg_get_userbyid(p.proowner) = current_user
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', f.sig, r);
      END IF;
    END LOOP;
  END LOOP;

  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
