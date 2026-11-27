-- Doc 30 build N2, review 105 N2-22: class proofs are never truncated either.
-- A row-level BEFORE DELETE trigger (migrations 20261127160000, 20261127170000)
-- does not fire on TRUNCATE, so TRUNCATE could remove every proof at once and
-- bring the seeded keys' no-evidence exception back without an audit row.
-- This adds a statement-level BEFORE TRUNCATE trigger that always raises.
--
-- As with the delete guard, only the table owner can pass it, by DDL
-- (`ALTER TABLE ... DISABLE TRIGGER`), which production code never runs.
--
-- Never grant DELETE or TRUNCATE on supplier_class_proofs, nor SET on the
-- parameter session_replication_role (which, set to `replica`, skips ordinary
-- triggers), to the application role (SEC-14 / A13 grant list): proofs are
-- revoked, never removed.
--
-- Forward-only and additive: one function and one trigger. Creating the
-- trigger takes a short lock on supplier_class_proofs, hence the lock timeout.
-- Rollback: none needed.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION outly_class_proof_no_truncate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'supplier_class_proofs: proofs are never truncated; revoke them' USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER "supplier_class_proofs_no_truncate" BEFORE TRUNCATE ON "supplier_class_proofs"
  FOR EACH STATEMENT EXECUTE FUNCTION outly_class_proof_no_truncate();
