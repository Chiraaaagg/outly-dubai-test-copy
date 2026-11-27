-- Doc 30 build N2, re-review 105 N2-16: the class proof delete guard has no
-- bypass. Migration 20261127160000 let a transaction-local setting
-- (`outly.purge_class_proofs`) through, and any role may set a custom setting,
-- so a future non-owner runtime role holding DELETE could have removed the only
-- proof of a seeded key and brought its no-evidence exception back without an
-- audit row. The function now always raises.
--
-- The only way past the trigger is DDL by the table owner
-- (`ALTER TABLE ... DISABLE TRIGGER`), which production code never runs; the
-- disposable-database test cleanup does it inside its own transaction.
--
-- Never grant DELETE on supplier_class_proofs to the application role
-- (SEC-14 / A13 grant list): proofs are revoked, never deleted.
--
-- Forward-only: replaces one function body. Rollback: none needed.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION outly_class_proof_no_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'supplier_class_proofs: a proof is never deleted; revoke it' USING ERRCODE = 'check_violation';
END $$;
