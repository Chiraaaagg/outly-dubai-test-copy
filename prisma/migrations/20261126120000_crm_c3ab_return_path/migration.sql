-- Bitrix24 return path, CRM batch C3ab (doc 29e; owner answers of 25 November
-- 2026; gaps G10, G13, G15). Off by default (CRM_RETURN_PATH=off) and only
-- ever used while CRM_SYNC_ENABLED=true.
--
-- Forward-only and additive. Old code runs on the new schema: it never names
-- the new columns or the new table, and every widened check still accepts
-- every row it accepted before.
--
--   crm_portal_state      nullable columns: the poll cursor (a time the portal
--                         returned, and the deal id of a keyset position while
--                         catching up after a burst), the portal fingerprint (a sha256 hash, its
--                         state and check times; G13), the nightly sweep
--                         cursor and times (G15), the drift cursor.
--   crm_links             nullable columns: what the reconciler last saw on the
--                         deal (update time, stage id, owner's Bitrix24 user
--                         id), put-back counters and times, the per-deal hold,
--                         a "look again" marker (after a hold, an observe-mode
--                         finding or a failed check),
--                         the sweep's "seen" time and "missing since".
--   crm_timeline_comments the kind and key checks widened for the three fixed
--                         return path notes (stage_reverted, move_refused,
--                         owner_unmapped; key `<kind>:<day number>`).
--   crm_return_findings   new table: one row per (scope, finding kind,
--                         subject) for the ops alert (hand-made, orphan,
--                         foreign, reappeared, not visible, twin deals,
--                         tamper, loops, unknown stages, owner changes,
--                         fingerprint refusals), and the at-most-once state of
--                         the one fixed comment on an extra twin deal.
--
-- Nothing here holds a name, a phone number, an email address, a payload, a
-- URL, a comment text or a secret. Bitrix24 user ids of staff are stored
-- (doc 26 row 31). No foreign key: `link_id` is crm_links.id without a
-- reference, as in crm_timeline_comments.
--
-- Rollback: none needed; the columns, checks and table can stay.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "crm_portal_state" ADD COLUMN "reconcile_cursor" TIMESTAMPTZ(6);
ALTER TABLE "crm_portal_state" ADD COLUMN "reconcile_checked_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_portal_state" ADD COLUMN "reconcile_cursor_id" BIGINT;
ALTER TABLE "crm_portal_state" ADD COLUMN "reconcile_catching_up" BOOLEAN;
ALTER TABLE "crm_portal_state" ADD COLUMN "fingerprint_hash" TEXT;
ALTER TABLE "crm_portal_state" ADD COLUMN "fingerprint_state" TEXT;
ALTER TABLE "crm_portal_state" ADD COLUMN "fingerprint_checked_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_portal_state" ADD COLUMN "fingerprint_ok_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_portal_state" ADD COLUMN "sweep_cursor_id" BIGINT;
ALTER TABLE "crm_portal_state" ADD COLUMN "sweep_started_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_portal_state" ADD COLUMN "sweep_completed_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_portal_state" ADD COLUMN "drift_cursor_link_id" UUID;
ALTER TABLE "crm_portal_state" ADD CONSTRAINT "crm_portal_state_fingerprint_hash_check" CHECK ("fingerprint_hash" IS NULL OR "fingerprint_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "crm_portal_state" ADD CONSTRAINT "crm_portal_state_fingerprint_state_check" CHECK ("fingerprint_state" IS NULL OR "fingerprint_state" IN ('ok', 'mismatch', 'admin', 'unreadable'));
ALTER TABLE "crm_portal_state" ADD CONSTRAINT "crm_portal_state_sweep_cursor_check" CHECK ("sweep_cursor_id" IS NULL OR "sweep_cursor_id" >= 0);
ALTER TABLE "crm_portal_state" ADD CONSTRAINT "crm_portal_state_reconcile_cursor_id_check" CHECK ("reconcile_cursor_id" IS NULL OR "reconcile_cursor_id" >= 0);

ALTER TABLE "crm_links" ADD COLUMN "crm_seen_updated_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_links" ADD COLUMN "crm_seen_stage_id" TEXT;
ALTER TABLE "crm_links" ADD COLUMN "crm_seen_owner_id" BIGINT;
ALTER TABLE "crm_links" ADD COLUMN "revert_count" INTEGER;
ALTER TABLE "crm_links" ADD COLUMN "last_revert_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_links" ADD COLUMN "prev_revert_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_links" ADD COLUMN "last_revert_comment_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_links" ADD COLUMN "last_field_restore_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_links" ADD COLUMN "hold_until" TIMESTAMPTZ(6);
ALTER TABLE "crm_links" ADD COLUMN "missing_since" TIMESTAMPTZ(6);
ALTER TABLE "crm_links" ADD COLUMN "sweep_seen_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_links" ADD COLUMN "recheck_requested_at" TIMESTAMPTZ(6);
ALTER TABLE "crm_links" ADD CONSTRAINT "crm_links_seen_stage_check" CHECK ("crm_seen_stage_id" IS NULL OR "crm_seen_stage_id" ~ '^[A-Za-z0-9_:-]{1,60}$');
ALTER TABLE "crm_links" ADD CONSTRAINT "crm_links_seen_owner_check" CHECK ("crm_seen_owner_id" IS NULL OR "crm_seen_owner_id" > 0);
ALTER TABLE "crm_links" ADD CONSTRAINT "crm_links_revert_count_check" CHECK ("revert_count" IS NULL OR "revert_count" >= 0);

ALTER TABLE "crm_timeline_comments" DROP CONSTRAINT "crm_timeline_comments_kind_check";
ALTER TABLE "crm_timeline_comments" ADD CONSTRAINT "crm_timeline_comments_kind_check" CHECK ("kind" IN ('paid', 'confirmed', 'tickets_sent', 'refund', 'handed_to_team', 'stage_reverted', 'move_refused', 'owner_unmapped'));
ALTER TABLE "crm_timeline_comments" DROP CONSTRAINT "crm_timeline_comments_key_check";
ALTER TABLE "crm_timeline_comments" ADD CONSTRAINT "crm_timeline_comments_key_check" CHECK (
  "moment_key" = "kind"
  OR ("kind" = 'refund' AND "moment_key" ~ '^refund:[1-9][0-9]{0,17}$')
  OR ("kind" IN ('stage_reverted', 'move_refused', 'owner_unmapped') AND "moment_key" ~ ('^' || "kind" || ':[0-9]{1,9}$'))
);

CREATE TABLE "crm_return_findings" (
    "id" UUID NOT NULL,
    "environment" TEXT NOT NULL,
    "portal" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "crm_id" BIGINT,
    "link_id" UUID,
    "detail" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "raised_at" TIMESTAMPTZ(6) NOT NULL,
    "comment_state" TEXT,
    "comment_ref_crm_id" BIGINT,
    "comment_posting_by" TEXT,
    "comment_posting_since" TIMESTAMPTZ(6),
    "comment_posted_at" TIMESTAMPTZ(6),
    "crm_comment_id" BIGINT,
    "comment_error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_return_findings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_return_findings_environment_check" CHECK ("environment" IN ('development', 'staging', 'production')),
    CONSTRAINT "crm_return_findings_portal_check" CHECK ("portal" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND char_length("portal") <= 253),
    CONSTRAINT "crm_return_findings_kind_check" CHECK ("kind" IN (
      'crm_unlinked_deal', 'crm_orphan_deal', 'crm_foreign_environment_deal', 'crm_deleted_deal_reappeared',
      'crm_deal_not_visible', 'crm_twin', 'crm_stage_tamper', 'crm_field_tamper', 'crm_putback_loop',
      'crm_unknown_stage', 'crm_owner_unmapped', 'crm_owner_change_refused', 'crm_portal_fingerprint_mismatch',
      'crm_service_account_is_admin', 'crm_fingerprint_unverified', 'crm_staff_map_invalid', 'crm_return_config_invalid',
      'crm_poll_stuck')),
    CONSTRAINT "crm_return_findings_subject_check" CHECK ("subject_key" ~ '^(portal|deal:[1-9][0-9]{0,17}|(inquiry|order):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
    CONSTRAINT "crm_return_findings_crm_id_check" CHECK ("crm_id" IS NULL OR "crm_id" > 0),
    CONSTRAINT "crm_return_findings_detail_check" CHECK ("detail" IS NULL OR "detail" ~ '^[A-Za-z0-9_.:,>=-]{1,200}$'),
    CONSTRAINT "crm_return_findings_occurrences_check" CHECK ("occurrences" >= 1),
    CONSTRAINT "crm_return_findings_comment_state_check" CHECK ("comment_state" IS NULL OR "comment_state" IN ('pending', 'posting', 'posted', 'unknown', 'failed', 'dropped')),
    CONSTRAINT "crm_return_findings_comment_kind_check" CHECK ("comment_state" IS NULL OR ("kind" = 'crm_twin' AND "crm_id" IS NOT NULL AND "comment_ref_crm_id" IS NOT NULL AND "comment_ref_crm_id" > 0)),
    CONSTRAINT "crm_return_findings_posting_check" CHECK ("comment_state" IS DISTINCT FROM 'posting' OR ("comment_posting_by" IS NOT NULL AND "comment_posting_since" IS NOT NULL)),
    CONSTRAINT "crm_return_findings_posted_check" CHECK (("comment_state" IS NOT DISTINCT FROM 'posted') = ("comment_posted_at" IS NOT NULL AND "crm_comment_id" IS NOT NULL)),
    CONSTRAINT "crm_return_findings_error_check" CHECK ("comment_error_code" IS NULL OR "comment_error_code" ~ '^[A-Za-z0-9_.:-]{1,64}$')
);

CREATE UNIQUE INDEX "crm_return_findings_subject_key" ON "crm_return_findings"("environment", "portal", "kind", "subject_key");
CREATE INDEX "crm_return_findings_raised_idx" ON "crm_return_findings"("raised_at");
CREATE INDEX "crm_return_findings_comment_idx" ON "crm_return_findings"("environment", "portal", "comment_state");

ALTER TABLE "crm_return_findings" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "crm_return_findings" FROM %I', r);
    END IF;
  END LOOP;
END $$;
