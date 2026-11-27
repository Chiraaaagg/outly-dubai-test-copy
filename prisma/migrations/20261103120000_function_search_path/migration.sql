-- Pin search_path on every function in schema public (A4, doc 22 §32.15).
--
-- Supabase's Security Advisor flags functions whose search_path is mutable
-- (lint 0011). Production was fixed by hand for the two functions it reported
-- (outly_raise_immutable, product_versions_immutable); this migration makes
-- every environment match and also covers the functions added by later
-- migrations. Idempotent: functions that already set search_path are skipped.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', f.sig);
  END LOOP;
END
$$;
