-- Explicit row level security and Supabase role revokes (SEC-1, doc 22 B0).
--
-- The two TravelDesk migrations (20261027120000, 20261031090000) created seven
-- tables with RLS off. On Supabase, a table created by SQL does not get RLS,
-- and default privileges can grant `anon` and `authenticated` access to new
-- tables in public, which the Data API then serves to anyone holding the
-- publishable key. Two of these tables hold supplier net rates; two are
-- writable queue and lease tables.
--
-- The application connects as the table owner through Prisma. RLS without
-- FORCE does not restrict the owner, so enabling it with no policies changes
-- nothing for the app and closes the Data API path. Additive and idempotent:
-- re-enabling RLS or revoking an absent privilege is a no-op, so this is safe
-- where the dashboard has already enabled RLS. Plain Postgres (no Supabase
-- roles) applies it too: the revokes are skipped when the roles do not exist.
--
-- Every later migration that creates a table must do the same for it
-- (prisma/migrations/README.md); src/server/__tests__/schema-rls.test.ts fails
-- otherwise.

-- 1. The seven TravelDesk tables.
ALTER TABLE "supplier_catalogue_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_price_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_mapping_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_bookings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_booking_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_account_leases" ENABLE ROW LEVEL SECURITY;

-- 2. Any other table in public that this role owns and that still has RLS off.
-- Production enabled RLS on the older tables in the dashboard; this makes a
-- database built from migrations alone match it. Tables owned by other roles
-- (extension tables) are left alone: ALTER TABLE would fail on them.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
      AND pg_get_userbyid(c.relowner) = current_user
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;

-- 3. No privileges for the Supabase API roles on the seven tables, or on any
-- other table or sequence in public that this role owns.
DO $$
DECLARE
  r text;
  t record;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON "supplier_catalogue_items", "supplier_price_snapshots", "supplier_mapping_candidates", '
        '"supplier_bookings", "supplier_booking_events", "supplier_jobs", "supplier_account_leases" FROM %I', r);
      FOR t IN
        SELECT c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND pg_get_userbyid(c.relowner) = current_user
      LOOP
        IF t.relkind = 'S' THEN
          EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I', t.relname, r);
        ELSE
          EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t.relname, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;
