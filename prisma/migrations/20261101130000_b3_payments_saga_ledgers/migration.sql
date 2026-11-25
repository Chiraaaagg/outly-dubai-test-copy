-- B3 payment rails, money saga, refunds and ledgers (doc 22 §23 B3;
-- contracts in src/server/payments/contracts.ts). Additive only: four new
-- `payment_status` values, nullable columns and two zero-default amount
-- columns on `payments`, six new tables and their triggers. Nothing is
-- dropped, no existing row is rewritten and no existing grant is removed.
--
-- Historic manual payments are untouched: every new gateway column is NULL
-- and captured_minor/refunded_minor read 0 from the default (a metadata-only
-- column add on Postgres 11+, no table rewrite). A manual row was never
-- gateway evidence (PAY-9), so it never carries a captured amount here and no
-- refund can be written against it.
--
-- The six new tables get RLS and the Supabase API-role revokes at the end
-- (prisma/migrations/README.md); src/server/__tests__/schema-rls.test.ts
-- checks it.

-- Statements 1 and 2 alter live objects; fail fast behind a long query.
SET LOCAL lock_timeout = '5s';

-- 1. Provider payment states the gateway port reports (ProviderPaymentStatus)
-- and the saga needs. `capture_unknown`: a capture call whose outcome is not
-- known yet (F3); never voided or re-charged first. Postgres 12+ allows
-- ADD VALUE inside the migration's transaction, but the new values are usable
-- only after it commits, so nothing below refers to them.
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'requires_action';
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'voided';
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'expired';
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'capture_unknown';

-- 2. Gateway binding on payments (GatewayAccount, GatewayPaymentSnapshot).
-- The provider payment id stays in `gateway_payment_id`, already unique per
-- gateway (payments_gateway_payment_idx).
ALTER TABLE "payments" ADD COLUMN "rail" TEXT;
ALTER TABLE "payments" ADD COLUMN "provider" TEXT;
ALTER TABLE "payments" ADD COLUMN "provider_account_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "environment" TEXT;
ALTER TABLE "payments" ADD COLUMN "provider_order_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "idempotency_key" TEXT;
ALTER TABLE "payments" ADD COLUMN "authorized_at" TIMESTAMPTZ(6);
ALTER TABLE "payments" ADD COLUMN "authorization_expires_at" TIMESTAMPTZ(6);
ALTER TABLE "payments" ADD COLUMN "voided_at" TIMESTAMPTZ(6);
ALTER TABLE "payments" ADD COLUMN "captured_minor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "payments" ADD COLUMN "refunded_minor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "payments" ADD COLUMN "three_ds" TEXT;
ALTER TABLE "payments" ADD COLUMN "risk" TEXT;
ALTER TABLE "payments" ADD COLUMN "quote_id" UUID;

-- NULLs are distinct, so historic rows (all NULL) never collide.
CREATE UNIQUE INDEX "payments_provider_order_key" ON "payments" ("provider", "provider_order_id");
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments" ("idempotency_key");
CREATE INDEX "payments_quote_idx" ON "payments" ("quote_id");

ALTER TABLE "payments" ADD CONSTRAINT "payments_quote_id_fkey"
  FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" ADD CONSTRAINT "payments_rail_check"
  CHECK ("rail" IS NULL OR "rail" IN ('inr_pacb', 'aed_card'));
ALTER TABLE "payments" ADD CONSTRAINT "payments_environment_check"
  CHECK ("environment" IS NULL OR "environment" IN ('test', 'production'));
ALTER TABLE "payments" ADD CONSTRAINT "payments_three_ds_check"
  CHECK ("three_ds" IS NULL OR "three_ds" IN ('passed', 'failed', 'not_applicable', 'unknown'));
ALTER TABLE "payments" ADD CONSTRAINT "payments_risk_check"
  CHECK ("risk" IS NULL OR "risk" IN ('normal', 'elevated', 'highest', 'unknown'));
-- A gateway payment names its whole account binding, or none of it (manual rows).
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_binding_check" CHECK (
  ("provider" IS NULL AND "provider_account_id" IS NULL AND "environment" IS NULL AND "rail" IS NULL)
  OR ("provider" IS NOT NULL AND "provider_account_id" IS NOT NULL AND "environment" IS NOT NULL AND "rail" IS NOT NULL));
-- The provider's running totals: refunded <= captured <= authorized amount.
ALTER TABLE "payments" ADD CONSTRAINT "payments_captured_refunded_check"
  CHECK ("refunded_minor" >= 0 AND "refunded_minor" <= "captured_minor" AND "captured_minor" <= "amount_minor");

-- 3. Payment saga, one per instant order (B3 first release: one instant item
-- per order). `state` is PaymentSagaState; `version` is the optimistic
-- concurrency counter every transition compares and increments.
-- `deadline_at` is the next point the saga must act by (supplier hold or
-- authorization expiry minus buffer, F9); `attention_required_at` is set
-- when a human must look.
CREATE TABLE "payment_sagas" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "payment_id" UUID,
    "rail" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'session_created',
    "version" INTEGER NOT NULL DEFAULT 0,
    "deadline_at" TIMESTAMPTZ(6),
    "attention_required_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_sagas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_sagas_order_id_key" ON "payment_sagas" ("order_id");
CREATE UNIQUE INDEX "payment_sagas_payment_id_key" ON "payment_sagas" ("payment_id");
CREATE INDEX "payment_sagas_item_idx" ON "payment_sagas" ("order_item_id");
CREATE INDEX "payment_sagas_state_deadline_idx" ON "payment_sagas" ("state", "deadline_at");
CREATE INDEX "payment_sagas_attention_idx" ON "payment_sagas" ("attention_required_at")
  WHERE "attention_required_at" IS NOT NULL;

ALTER TABLE "payment_sagas" ADD CONSTRAINT "payment_sagas_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_sagas" ADD CONSTRAINT "payment_sagas_order_item_id_fkey"
  FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_sagas" ADD CONSTRAINT "payment_sagas_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_sagas" ADD CONSTRAINT "payment_sagas_rail_check" CHECK ("rail" IN ('inr_pacb', 'aed_card'));
ALTER TABLE "payment_sagas" ADD CONSTRAINT "payment_sagas_state_check" CHECK ("state" IN (
  'session_created', 'authorized', 'captured', 'capture_unknown', 'reserve_pending', 'reserved',
  'confirm_pending', 'fulfilled', 'release_pending', 'released', 'refund_pending', 'refunded',
  'failed', 'attention'));
ALTER TABLE "payment_sagas" ADD CONSTRAINT "payment_sagas_version_check" CHECK ("version" >= 0);

-- 4. Payment webhook inbox (PAY-13, F2). One row per (provider, event id), so
-- a duplicate or replay is acknowledged and not reprocessed. A body whose
-- signature fails is never stored. Only the sha256 hex of the raw body is
-- kept, never the body: it can carry customer contact and card metadata.
-- `received` -> `verified` (signature or authenticated read) -> `processed`,
-- or `processing_failed` (retryable at next_attempt_at).
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'received',
    "type" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "payload_digest" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "next_attempt_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_events_provider_event_key" ON "payment_events" ("provider", "provider_event_id");
CREATE INDEX "payment_events_state_next_idx" ON "payment_events" ("state", "next_attempt_at");
CREATE INDEX "payment_events_provider_payment_idx" ON "payment_events" ("provider", "provider_payment_id");

ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_state_check"
  CHECK ("state" IN ('received', 'verified', 'processing_failed', 'processed'));
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_digest_check" CHECK ("payload_digest" ~ '^[0-9a-f]{64}$');
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_attempts_check" CHECK ("attempts" >= 0);
-- An error code, not a message: short, so no response body or PII lands here.
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_error_code_check"
  CHECK ("last_error_code" IS NULL OR char_length("last_error_code") <= 64);
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_processed_check"
  CHECK (("state" = 'processed') = ("processed_at" IS NOT NULL));

-- 5. Refunds, one row per refund operation on one payment and item allocation
-- (F5, F16). `idempotency_key` is the key sent to the provider. `unknown`
-- means the request may have reached the provider and must be looked up
-- before any retry. `outly_funded`: Outly pays while supplier liability is
-- unresolved. `requested_by` is the staff member, NULL for a saga refund.
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_refund_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" "currency" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "reason" TEXT NOT NULL,
    "outly_funded" BOOLEAN NOT NULL DEFAULT false,
    "requested_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds" ("idempotency_key");
CREATE UNIQUE INDEX "refunds_provider_refund_key" ON "refunds" ("provider", "provider_refund_id");
CREATE INDEX "refunds_payment_status_idx" ON "refunds" ("payment_id", "status");
CREATE INDEX "refunds_item_idx" ON "refunds" ("order_item_id");

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_item_id_fkey"
  FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Staff users are soft-deleted, so a refund never loses its requester.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_fkey"
  FOREIGN KEY ("requested_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_check" CHECK ("amount_minor" > 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status_check"
  CHECK ("status" IN ('requested', 'accepted', 'succeeded', 'failed', 'unknown'));

-- Refund cap: the non-failed refunds on a payment never total more than its
-- captured amount, and a refund is in the payment's currency. A CHECK cannot
-- see other rows, so a trigger enforces it:
--   - It locks the payment row (FOR UPDATE) before summing. Every writer of a
--     refund for that payment, and every change to its captured_minor,
--     takes that lock first, so they run one at a time.
--   - Under READ COMMITTED (the default, and what Prisma uses) the SUM after
--     the lock is a new statement with a new snapshot, so it sees a refund
--     that a concurrent writer committed while this one waited. Under
--     SERIALIZABLE, SSI aborts one of two such writers. Under REPEATABLE READ
--     the SUM would use the transaction's old snapshot and could miss it, so
--     the trigger refuses that isolation level.
--   - `requested`, `accepted`, `succeeded` and `unknown` all count: an unknown
--     refund may have been paid out.
CREATE OR REPLACE FUNCTION outly_refunds_enforce_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cap BIGINT;
  pay_currency "currency";
  total BIGINT;
BEGIN
  IF NEW."status" = 'failed' THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'refunds: the refund cap needs READ COMMITTED or SERIALIZABLE isolation'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p."captured_minor", p."currency" INTO cap, pay_currency
    FROM "payments" p WHERE p."id" = NEW."payment_id" FOR UPDATE;
  IF NOT FOUND THEN
    -- The foreign key reports it.
    RETURN NEW;
  END IF;
  IF NEW."currency" <> pay_currency THEN
    RAISE EXCEPTION 'refunds: currency % differs from payment currency %', NEW."currency", pay_currency
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(r."amount_minor"), 0) INTO total
    FROM "refunds" r
    WHERE r."payment_id" = NEW."payment_id" AND r."status" <> 'failed' AND r."id" <> NEW."id";
  IF total + NEW."amount_minor" > cap THEN
    RAISE EXCEPTION 'refunds: non-failed refunds would total % above captured %', total + NEW."amount_minor", cap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER refunds_enforce_cap
  BEFORE INSERT OR UPDATE OF "payment_id", "amount_minor", "currency", "status" ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION outly_refunds_enforce_cap();

-- The other side of the cap: captured_minor never drops below the payment's
-- non-failed refunds. The UPDATE already holds the payment row lock, so a
-- concurrent refund writer waits for it.
CREATE OR REPLACE FUNCTION outly_payments_keep_refund_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE total BIGINT;
BEGIN
  IF NEW."captured_minor" >= OLD."captured_minor" THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(SUM(r."amount_minor"), 0) INTO total
    FROM "refunds" r WHERE r."payment_id" = NEW."id" AND r."status" <> 'failed';
  IF total > NEW."captured_minor" THEN
    RAISE EXCEPTION 'payments: captured % would be below non-failed refunds %', NEW."captured_minor", total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payments_keep_refund_cap
  BEFORE UPDATE OF "captured_minor" ON "payments"
  FOR EACH ROW EXECUTE FUNCTION outly_payments_keep_refund_cap();

-- 6. Customer remedies (SUP-20, TKT-8): what the customer is given when an
-- item fails. A remedy only names the supplier attempt it compensates; it
-- never writes that attempt's state, which stays on supplier_bookings.
CREATE TABLE "customer_remedies" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "supplier_booking_id" UUID,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" "currency" NOT NULL,
    "outly_funded" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "refund_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_remedies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_remedies_order_idx" ON "customer_remedies" ("order_id");
CREATE INDEX "customer_remedies_item_idx" ON "customer_remedies" ("order_item_id");
CREATE INDEX "customer_remedies_supplier_booking_idx" ON "customer_remedies" ("supplier_booking_id");
CREATE INDEX "customer_remedies_status_idx" ON "customer_remedies" ("status", "created_at");
CREATE UNIQUE INDEX "customer_remedies_refund_id_key" ON "customer_remedies" ("refund_id");

ALTER TABLE "customer_remedies" ADD CONSTRAINT "customer_remedies_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_remedies" ADD CONSTRAINT "customer_remedies_order_item_id_fkey"
  FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_remedies" ADD CONSTRAINT "customer_remedies_supplier_booking_id_fkey"
  FOREIGN KEY ("supplier_booking_id") REFERENCES "supplier_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_remedies" ADD CONSTRAINT "customer_remedies_refund_id_fkey"
  FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_remedies" ADD CONSTRAINT "customer_remedies_kind_check"
  CHECK ("kind" IN ('release_authorization', 'refund', 'alternative_offered'));
ALTER TABLE "customer_remedies" ADD CONSTRAINT "customer_remedies_status_check"
  CHECK ("status" IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled'));
ALTER TABLE "customer_remedies" ADD CONSTRAINT "customer_remedies_amount_check" CHECK ("amount_minor" >= 0);
-- Only a refund remedy points at a refund.
ALTER TABLE "customer_remedies" ADD CONSTRAINT "customer_remedies_refund_kind_check"
  CHECK ("refund_id" IS NULL OR "kind" = 'refund');

-- 7. Ledger entries (PAY-10, PAY-14): three separate books, reconciled and
-- never auto-corrected. Append-only like audit_logs: a correction is a new
-- entry. Positive amount is money in to Outly (or into the supplier wallet
-- for that book). `evidence_ref` names what proves the entry (provider
-- payment, refund or settlement id, supplier statement line).
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "book" TEXT NOT NULL,
    "order_id" UUID,
    "supplier_booking_id" UUID,
    "payment_id" UUID,
    "currency" "currency" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ledger_entries_book_occurred_idx" ON "ledger_entries" ("book", "occurred_at");
CREATE INDEX "ledger_entries_order_idx" ON "ledger_entries" ("order_id");
CREATE INDEX "ledger_entries_payment_idx" ON "ledger_entries" ("payment_id");
CREATE INDEX "ledger_entries_supplier_booking_idx" ON "ledger_entries" ("supplier_booking_id");

ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_supplier_booking_id_fkey"
  FOREIGN KEY ("supplier_booking_id") REFERENCES "supplier_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_book_check"
  CHECK ("book" IN ('customer_money', 'supplier_wallet', 'gateway_settlement'));
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_check" CHECK ("amount_minor" <> 0);
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_evidence_check" CHECK (char_length("evidence_ref") > 0);

CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION outly_raise_immutable();

-- 8. Gateway settlement report rows, one per provider settlement. Fees are
-- recorded as reported; net is not derived here (the report may also net
-- refunds, tax and adjustments), and reconciliation compares it to the
-- gateway_settlement book. `raw_digest` is the sha256 hex of the report row
-- as received.
CREATE TABLE "settlements" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_settlement_id" TEXT NOT NULL,
    "currency" "currency" NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "settled_at" TIMESTAMPTZ(6) NOT NULL,
    "raw_digest" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "settlements_provider_settlement_key" ON "settlements" ("provider", "provider_settlement_id");
CREATE INDEX "settlements_settled_idx" ON "settlements" ("settled_at");

ALTER TABLE "settlements" ADD CONSTRAINT "settlements_fee_check" CHECK ("fee_minor" >= 0);
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_digest_check" CHECK ("raw_digest" ~ '^[0-9a-f]{64}$');

-- 9. Row level security and no Supabase API grants on the new tables. None
-- owns a sequence (UUID keys).
ALTER TABLE "payment_sagas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_remedies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settlements" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "payment_sagas", "payment_events", "refunds", "customer_remedies", "ledger_entries", "settlements" FROM %I', r);
    END IF;
  END LOOP;
END $$;
