-- B1 engine hardening and provenance (doc 22 §23 B1; contracts in
-- src/server/suppliers/booking-port.ts, B1 section). Additive only: one
-- widened check, new columns that are nullable or carry a constant default,
-- one rebuilt primary key, two new tables and additive permission rows.
-- Nothing is dropped and no existing grant is removed.
--
-- Columns added with a constant default are filled for every existing row by
-- the ADD COLUMN itself (metadata-only on Postgres 11+), so the NOT NULL
-- holds from the start. The one data backfill (job priority) is its own
-- statement after the column exists.
--
-- Both new tables get RLS and the Supabase API-role revokes at the end
-- (prisma/migrations/README.md); src/server/__tests__/schema-rls.test.ts
-- checks it.

-- Every statement below alters a live table; fail fast behind a long query.
SET LOCAL lock_timeout = '5s';

-- 1. Customer intents wait for captured payment (PAY-1). B1a stored them as
-- `hold` because the check did not allow `await_payment` yet.
ALTER TABLE "supplier_bookings" DROP CONSTRAINT "sb_after_reserve_check";
ALTER TABLE "supplier_bookings" ADD CONSTRAINT "sb_after_reserve_check"
  CHECK ("after_reserve" IN ('confirm', 'cancel', 'hold', 'await_payment'));

-- 2. Booking provenance.
--   request_hash  hash of the request body as first sent; a changed body under
--                 the same idempotency key is refused. Null for rows written
--                 before B1, which never get one.
--   account_id    the supplier account the credentials acted for (SUP-10,
--                 TravelDesk agencyId). `default` until the engine pins it.
ALTER TABLE "supplier_bookings" ADD COLUMN "request_hash" TEXT;
ALTER TABLE "supplier_bookings" ADD COLUMN "account_id" TEXT NOT NULL DEFAULT 'default';

-- 3. Account lease: one row per (supplier, environment, account).
--   generation  bumped on every acquisition, so a holder whose lease was taken
--               over can tell that its fencing token is stale.
-- Compatibility: existing rows and rows inserted by pre-B1 code without an
-- account get `default`, so the old (supplier, environment) reads and
-- conditional updates still address exactly one row while only `default`
-- exists.
ALTER TABLE "supplier_account_leases" ADD COLUMN "account_id" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "supplier_account_leases" ADD COLUMN "generation" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "supplier_account_leases" DROP CONSTRAINT "supplier_account_leases_pkey";
ALTER TABLE "supplier_account_leases" ADD CONSTRAINT "supplier_account_leases_pkey"
  PRIMARY KEY ("supplier_id", "environment", "account_id");

-- 4. Job priority. Claim order (the worker's ORDER BY, served by sj_claim_idx):
--
--     WHERE status = 'queued' AND run_after <= now
--     ORDER BY priority DESC, deadline_at ASC NULLS LAST, run_after ASC
--
-- Postgres sorts NULLs last for ASC, so a plain ASC index column matches.
-- Priority by job kind:
--   30  cancel                      releases a hold: returns money and inventory
--   20  confirm                     a paid hold that can lapse
--   10  recover, poll, watchdog     resolve uncertain state before new risk
--    0  reserve, create (default)   new sales
-- So a release or confirm due now is always claimed before a reserve due now,
-- and within one priority the job closest to its send deadline goes first.
ALTER TABLE "supplier_jobs" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

-- Backfill for jobs that can still be claimed; finished jobs keep 0.
UPDATE "supplier_jobs"
SET "priority" = CASE "kind"
    WHEN 'cancel' THEN 30
    WHEN 'confirm' THEN 20
    WHEN 'recover' THEN 10
    WHEN 'poll' THEN 10
    WHEN 'watchdog' THEN 10
    ELSE 0
  END
WHERE "status" IN ('queued', 'running');

CREATE INDEX "sj_claim_idx" ON "supplier_jobs" ("status", "priority" DESC, "deadline_at", "run_after");

-- 5. How an order item came to exist (PRD-3). Only `instant_checkout` may ever
-- create a supplier attempt. Every existing row is an assisted conversion and
-- gets that value from the default.
ALTER TABLE "order_items" ADD COLUMN "fulfilment_origin" TEXT NOT NULL DEFAULT 'assisted_conversion';
ALTER TABLE "order_items" ADD CONSTRAINT "oi_fulfilment_origin_check"
  CHECK ("fulfilment_origin" IN ('instant_checkout', 'assisted_conversion'));

-- 6. Where a payment record came from (PAY-9). Only `gateway_verified` counts as
-- payment evidence for a supplier confirm; every existing row was recorded by
-- staff.
ALTER TABLE "payments" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "payments" ADD CONSTRAINT "payments_source_check"
  CHECK ("source" IN ('manual', 'gateway_verified'));

-- 7. Effective eligibility per product, written by the readiness evaluation
-- (B2). A product with no row is inquiry-only: absence is the safe default,
-- so there is no backfill.
CREATE TABLE "product_eligibility" (
    "product_id" UUID NOT NULL,
    "effective_mode" "fulfilment_mode" NOT NULL DEFAULT 'inquiry',
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "readiness_version" INTEGER NOT NULL,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_eligibility_pkey" PRIMARY KEY ("product_id")
);

ALTER TABLE "product_eligibility" ADD CONSTRAINT "product_eligibility_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_eligibility" ADD CONSTRAINT "pe_reasons_check" CHECK (jsonb_typeof("reasons") = 'array');
ALTER TABLE "product_eligibility" ADD CONSTRAINT "pe_readiness_version_check" CHECK ("readiness_version" >= 0);

-- 8. Privileged operations (SEC-10, PRD-12): step-up and, in production, a
-- second staff member with the same permission. Written by
-- src/server/services/approval.service.ts.
CREATE TABLE "privileged_approvals" (
    "id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "payload_hash" TEXT NOT NULL,
    "environment" "supplier_environment" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "applied_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "privileged_approvals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pa_payload_status_idx" ON "privileged_approvals" ("payload_hash", "status");
CREATE INDEX "pa_requested_by_idx" ON "privileged_approvals" ("requested_by", "requested_at" DESC);

-- Staff users are soft-deleted, so an approval never loses its people.
ALTER TABLE "privileged_approvals" ADD CONSTRAINT "privileged_approvals_requested_by_fkey"
  FOREIGN KEY ("requested_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "privileged_approvals" ADD CONSTRAINT "privileged_approvals_approved_by_fkey"
  FOREIGN KEY ("approved_by") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_status_check"
  CHECK ("status" IN ('pending', 'applied', 'expired', 'cancelled'));
ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_operation_check"
  CHECK ("operation" IN ('instant.activate', 'supplier.resume', 'supplier.limits.raise', 'booking.privileged_resolution'));
ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_payload_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$');
-- One person can never be both requester and approver.
ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_distinct_approver_check"
  CHECK ("approved_by" IS NULL OR "approved_by" <> "requested_by");
ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_approved_pair_check"
  CHECK (("approved_by" IS NULL) = ("approved_at" IS NULL));
ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_applied_check"
  CHECK (("status" = 'applied') = ("applied_at" IS NOT NULL));
-- Dual control in the database too: nothing is applied in production without
-- a second person.
ALTER TABLE "privileged_approvals" ADD CONSTRAINT "pa_production_dual_check"
  CHECK ("environment" <> 'production' OR "status" <> 'applied' OR "approved_by" IS NOT NULL);

-- 9. Additive role grants for the B1 permissions (doc 22 §24.3; B1_PERMISSIONS
-- in booking-port.ts). Only for roles that exist: on a fresh database the
-- seed creates the roles afterwards from src/server/lib/permissions.ts, which
-- carries the same matrix. Nothing is deleted.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", g."permission"
FROM "roles" r
JOIN (VALUES
    ('admin', 'products.activate_instant'),
    ('admin', 'suppliers.pause'),
    ('admin', 'suppliers.resume'),
    ('admin', 'suppliers.limits.raise'),
    ('admin', 'suppliers.costs.view'),
    ('admin', 'bookings.privileged_resolution'),
    ('admin', 'payments.reconcile'),
    ('ops', 'suppliers.pause'),
    ('agent_lead', 'suppliers.pause'),
    ('finance', 'suppliers.costs.view'),
    ('finance', 'payments.reconcile')
  ) AS g("code", "permission") ON g."code" = r."code"
ON CONFLICT DO NOTHING;

-- 10. Row level security and no Supabase API grants on the new tables.
ALTER TABLE "product_eligibility" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "privileged_approvals" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "product_eligibility", "privileged_approvals" FROM %I', r);
    END IF;
  END LOOP;
END $$;
