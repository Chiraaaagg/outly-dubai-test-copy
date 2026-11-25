# Migrations

Prisma applies the directories here in name order. Never edit a migration that
has been applied anywhere; fix forward with a new one. All migrations have one
writer (doc 22 §24.1).

## Every new table: RLS and no Supabase API grants

Production runs on Supabase. A table created by a migration does **not** get
row level security, and Supabase default privileges may grant `anon` and
`authenticated` access to it, which the Data API then serves to anyone with
the publishable key (SEC-1). The application connects as the table owner, so
RLS with no policies does not affect it.

So every migration that creates a table, view or sequence in `public` ends
with:

```sql
ALTER TABLE "my_new_table" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "my_new_table" FROM %I', r);
      -- and each sequence it owns, e.g. a BIGSERIAL id:
      -- EXECUTE format('REVOKE ALL ON SEQUENCE "my_new_table_id_seq" FROM %I', r);
    END IF;
  END LOOP;
END $$;
```

The role check keeps the migration valid on plain Postgres (the disposable
test database), where those roles do not exist unless the bootstrap simulates
them.

`src/server/__tests__/schema-rls.test.ts` (vitest `db` project) fails when any
table in `public` has RLS off, or when `anon` or `authenticated` holds any
privilege on a table or sequence in `public`. `scripts/test-db/up.sh` creates
both roles and Supabase-style default grants, so the test sees what a hosted
apply would expose.

## Locks: set a lock timeout

`ENABLE ROW LEVEL SECURITY`, most `ALTER TABLE` forms and new constraints take
`ACCESS EXCLUSIVE` on the table, and Prisma runs the whole file in one
transaction. Behind a long-running query, that lock request queues every later
query on the table. A migration that alters an existing table therefore starts
with:

```sql
SET LOCAL lock_timeout = '5s';
```

so it fails fast and can be retried instead of stalling production traffic.
`SET LOCAL` ends with the migration's transaction. Before a production apply,
list the tables the migration alters, their owners and `current_user` for both
URLs (read-only), and confirm the runtime role owns them or has `BYPASSRLS`;
otherwise enabling RLS hides their rows from it.

## Applying

`npm run db:migrate` applies to the disposable test database only (through
`scripts/db.mjs` and the target guard). A production apply is an owner action
under its own approval:
`node scripts/db.mjs migrate --target=production --project-ref=<ref> --env-file=<path>`.
