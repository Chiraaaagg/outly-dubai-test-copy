-- Bitrix24 CRM push, batch C2b (doc 29 §8.8 decision C2-11; doc 29d gap G7):
-- the record of deal timeline comments at key moments. Switched off with the
-- rest of the CRM sync (CRM_SYNC_ENABLED).
--
-- Forward-only and additive. One new table, no foreign key, no change to any
-- existing table:
--   crm_timeline_comments  one row per (crm_links row, moment key): a key
--                          moment a deal reached (paid, confirmed, tickets
--                          sent, a refunded total, handed to the team),
--                          when OUTLYY noticed it, and whether its comment
--                          was posted. The unique key makes a moment post at
--                          most once per deal; a row is never re-posted once
--                          its answer may have been lost (`unknown`).
-- It holds ids, codes, an AED amount, times and the CRM comment id only:
-- never comment text, customer contact data, payloads, credentials or URLs.
-- `link_id` is crm_links.id without a foreign key (the worker drops moments
-- of a deleted link; retention deletes them with the link's tombstone), so
-- this migration takes no lock on an existing table.
--
-- Code from the previous release names no such table. Rollback: none
-- needed; the table can stay.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "crm_timeline_comments" (
    "id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "moment_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_aed_minor" BIGINT,
    "noticed_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posting_by" TEXT,
    "posting_since" TIMESTAMPTZ(6),
    "posted_at" TIMESTAMPTZ(6),
    "crm_comment_id" BIGINT,
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_timeline_comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_timeline_comments_kind_check" CHECK ("kind" IN ('paid', 'confirmed', 'tickets_sent', 'refund', 'handed_to_team')),
    CONSTRAINT "crm_timeline_comments_key_check" CHECK ("moment_key" = "kind" OR ("kind" = 'refund' AND "moment_key" ~ '^refund:[1-9][0-9]{0,17}$')),
    CONSTRAINT "crm_timeline_comments_amount_check" CHECK ("amount_aed_minor" IS NULL OR "amount_aed_minor" > 0),
    CONSTRAINT "crm_timeline_comments_status_check" CHECK ("status" IN ('pending', 'posting', 'posted', 'unknown', 'failed', 'dropped')),
    CONSTRAINT "crm_timeline_comments_attempts_check" CHECK ("attempts" BETWEEN 0 AND 20),
    CONSTRAINT "crm_timeline_comments_posting_check" CHECK ("status" <> 'posting' OR ("posting_by" IS NOT NULL AND "posting_since" IS NOT NULL)),
    CONSTRAINT "crm_timeline_comments_posted_check" CHECK (("status" = 'posted') = ("posted_at" IS NOT NULL AND "crm_comment_id" IS NOT NULL)),
    CONSTRAINT "crm_timeline_comments_comment_id_check" CHECK ("crm_comment_id" IS NULL OR "crm_comment_id" > 0),
    CONSTRAINT "crm_timeline_comments_error_check" CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[A-Za-z0-9_.:-]{1,64}$')
);

CREATE UNIQUE INDEX "crm_timeline_comments_link_moment_key" ON "crm_timeline_comments"("link_id", "moment_key");
CREATE INDEX "crm_timeline_comments_due_idx" ON "crm_timeline_comments"("status", "next_attempt_at");

ALTER TABLE "crm_timeline_comments" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "crm_timeline_comments" FROM %I', r);
    END IF;
  END LOOP;
END $$;
