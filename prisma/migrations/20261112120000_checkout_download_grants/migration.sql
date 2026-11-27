-- Checkout redesign batch 3 (CO-02): a capability grant issued at checkout to
-- the guest browser that made the quote and verified the order's contact.
--
-- Forward-only and additive:
--  1. guest_capability_grants.issued_for may be 'checkout';
--  2. at most one 'checkout' grant per order (partial unique index): a repeat
--     checkout call re-uses it, and once it is revoked or expired no new one
--     can be minted for that order;
--  3. revoke_reason may be 'customer' ("Remove access on this browser");
--  4. the row guard also keeps issued_for fixed, so a grant can never change
--     origin (and so never move in or out of the checkout rules).
-- No row is rewritten; every existing value stays valid, and no existing row
-- has issued_for = 'checkout', so the index builds empty. Not reversible once
-- checkout rows exist (the widened checks would then reject them); the
-- release switch GUEST_DOWNLOAD_GRANT_ENABLED is the rollback.
--
-- Replacing CHECKs and building an index lock the table, so the migration
-- starts with a lock timeout (prisma/migrations/README.md "Locks"). The
-- replaced guard function pins search_path like every function (A4,
-- migration 20261103120000), since CREATE OR REPLACE resets it.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "guest_capability_grants" DROP CONSTRAINT "guest_capability_grants_issued_for_check";
ALTER TABLE "guest_capability_grants" ADD CONSTRAINT "guest_capability_grants_issued_for_check"
  CHECK ("issued_for" IN ('ticket_notification', 'status_notification', 'staff_resend', 'recovery', 'checkout'));

ALTER TABLE "guest_capability_grants" DROP CONSTRAINT "guest_capability_grants_revoke_reason_check";
ALTER TABLE "guest_capability_grants" ADD CONSTRAINT "guest_capability_grants_revoke_reason_check"
  CHECK ("revoke_reason" IS NULL OR "revoke_reason" IN ('superseded', 'staff', 'erasure', 'order_cancelled', 'customer'));

CREATE UNIQUE INDEX "guest_capability_grants_one_checkout" ON "guest_capability_grants" ("order_id") WHERE "issued_for" = 'checkout';

-- A revoked grant stays revoked; its token hash, order, purpose and origin never change; its expiry never grows.
CREATE OR REPLACE FUNCTION outly_capability_grants_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."token_hash" <> OLD."token_hash" OR NEW."order_id" <> OLD."order_id" OR NEW."purpose" <> OLD."purpose" OR NEW."issued_for" <> OLD."issued_for" OR NEW."expires_at" > OLD."expires_at" THEN
    RAISE EXCEPTION 'guest_capability_grants: token, order, purpose and origin are fixed and expiry cannot be extended' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'guest_capability_grants: a revoked grant stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
