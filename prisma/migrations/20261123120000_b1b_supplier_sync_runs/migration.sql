-- Scheduled catalogue sync, batch 1b (doc 29 §6.3, §7.3 Batch 1b; conflict
-- C10 decided by the owner, §8.4 row 13).
--
-- Forward-only and additive. One new table:
--   supplier_sync_runs  one row per catalogue sync run (admin button or the
--                       daily scheduled run): trigger, environment, account,
--                       start and finish, status, counts, the resume cursor,
--                       a short error code and whether the deadline was hit.
--
-- No existing table is altered, no foreign key is declared (the supplier is
-- named by its code, as the sync lease in `settings` is) and no function is
-- created. The table holds ids, counts, short codes and timestamps only:
-- never prices, payloads, credentials or URLs.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "supplier_sync_runs" (
    "id" UUID NOT NULL,
    "supplier_code" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "pass_started_at" TIMESTAMPTZ(6) NOT NULL,
    "resumed_from_run_id" UUID,
    "resume_after_tour_id" INTEGER,
    "tours" INTEGER NOT NULL DEFAULT 0,
    "offers" INTEGER NOT NULL DEFAULT 0,
    "added" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "removed" INTEGER NOT NULL DEFAULT 0,
    "revived" INTEGER NOT NULL DEFAULT 0,
    "mappings_changed" INTEGER NOT NULL DEFAULT 0,
    "failed_tours" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "removals_skipped" TEXT,
    "deadline_hit" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_sync_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_sync_runs_supplier_code_check" CHECK (char_length("supplier_code") BETWEEN 1 AND 64),
    CONSTRAINT "supplier_sync_runs_environment_check" CHECK ("environment" IN ('test', 'production')),
    CONSTRAINT "supplier_sync_runs_account_id_check" CHECK (char_length("account_id") BETWEEN 1 AND 128),
    CONSTRAINT "supplier_sync_runs_triggered_by_check" CHECK ("triggered_by" IN ('cron', 'admin')),
    CONSTRAINT "supplier_sync_runs_status_check" CHECK ("status" IN ('running', 'complete', 'incomplete', 'failed')),
    CONSTRAINT "supplier_sync_runs_finished_check" CHECK (("status" = 'running') = ("finished_at" IS NULL)),
    CONSTRAINT "supplier_sync_runs_cursor_check" CHECK ("resume_after_tour_id" IS NULL OR "status" = 'incomplete'),
    CONSTRAINT "supplier_sync_runs_pass_check" CHECK ("pass_started_at" <= "started_at"),
    CONSTRAINT "supplier_sync_runs_counts_check" CHECK ("tours" >= 0 AND "offers" >= 0 AND "added" >= 0 AND "changed" >= 0 AND "removed" >= 0 AND "revived" >= 0 AND "mappings_changed" >= 0),
    CONSTRAINT "supplier_sync_runs_failed_tours_check" CHECK ("failed_tours" IS NOT NULL AND cardinality("failed_tours") <= 1000),
    CONSTRAINT "supplier_sync_runs_removals_skipped_check" CHECK ("removals_skipped" IS NULL OR "removals_skipped" IN ('empty_tour_list', 'too_many_removals', 'incomplete')),
    CONSTRAINT "supplier_sync_runs_error_code_check" CHECK ("error_code" IS NULL OR "error_code" ~ '^[A-Za-z0-9_.:-]{1,64}$')
);

CREATE INDEX "ssr_latest_idx" ON "supplier_sync_runs"("supplier_code", "environment", "created_at" DESC);
CREATE INDEX "ssr_complete_idx" ON "supplier_sync_runs"("supplier_code", "environment", "status", "finished_at" DESC);

ALTER TABLE "supplier_sync_runs" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "supplier_sync_runs" FROM %I', r);
    END IF;
  END LOOP;
END $$;
