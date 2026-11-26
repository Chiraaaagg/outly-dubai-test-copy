-- Bitrix24 CRM push, batch C1 (doc 29 §6.4, §7.3 C1). Switched off; C1 runs
-- only against a fake portal.
--
-- Forward-only and additive. New tables:
--   crm_outbox        one row per local change of a deal subject (inquiry or
--                     direct-checkout order), written in the domain
--                     transaction; no payload (the worker re-reads state).
--   crm_links         local subject <-> CRM deal per (environment, portal);
--                     the per-entity version counter and the create/update lock.
--   crm_portal_state  stored portal identity, circuit breaker / throttle pause
--                     and the single-flight run lease, per (environment, portal).
--
-- No existing table is altered and no function is created. The tables hold
-- ids, versions, short codes and timestamps only: never customer contact
-- data, payloads, CRM credentials or URLs.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "crm_outbox" (
    "id" UUID NOT NULL,
    "environment" TEXT NOT NULL,
    "portal" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "version" BIGINT NOT NULL,
    "payload_version" INTEGER NOT NULL DEFAULT 1,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" TEXT,
    "locked_until" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "outcome" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_outbox_environment_check" CHECK ("environment" IN ('development', 'staging', 'production')),
    CONSTRAINT "crm_outbox_portal_check" CHECK ("portal" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND char_length("portal") <= 253),
    CONSTRAINT "crm_outbox_entity_type_check" CHECK ("entity_type" IN ('inquiry', 'order')),
    CONSTRAINT "crm_outbox_kind_check" CHECK ("kind" IN ('sync', 'delete')),
    CONSTRAINT "crm_outbox_status_check" CHECK ("status" IN ('queued', 'running', 'done', 'dead')),
    CONSTRAINT "crm_outbox_version_check" CHECK ("version" >= 1),
    CONSTRAINT "crm_outbox_payload_version_check" CHECK ("payload_version" >= 1),
    CONSTRAINT "crm_outbox_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 20),
    CONSTRAINT "crm_outbox_dedupe_key_check" CHECK (char_length("dedupe_key") BETWEEN 1 AND 400),
    CONSTRAINT "crm_outbox_last_error_code_check" CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[A-Za-z0-9_.:-]{1,64}$'),
    CONSTRAINT "crm_outbox_outcome_check" CHECK ("outcome" IS NULL OR "outcome" ~ '^[a-z0-9_]{1,40}$'),
    CONSTRAINT "crm_outbox_reason_check" CHECK (("kind" = 'delete') = ("reason" IS NOT NULL) AND ("reason" IS NULL OR "reason" IN ('erasure', 'retention'))),
    CONSTRAINT "crm_outbox_running_lock_check" CHECK ("status" <> 'running' OR ("locked_by" IS NOT NULL AND "locked_until" IS NOT NULL))
);

CREATE TABLE "crm_links" (
    "id" UUID NOT NULL,
    "environment" TEXT NOT NULL,
    "portal" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "crm_entity_type_id" INTEGER NOT NULL DEFAULT 2,
    "crm_id" BIGINT,
    "originator_id" TEXT NOT NULL,
    "origin_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "creating_since" TIMESTAMPTZ(6),
    "local_version" BIGINT NOT NULL DEFAULT 0,
    "pushed_version" BIGINT NOT NULL DEFAULT 0,
    "pushed_hash" TEXT,
    "pushed_at" TIMESTAMPTZ(6),
    "locked_by" TEXT,
    "locked_until" TIMESTAMPTZ(6),
    "twin_flagged_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "delete_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_links_environment_check" CHECK ("environment" IN ('development', 'staging', 'production')),
    CONSTRAINT "crm_links_portal_check" CHECK ("portal" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND char_length("portal") <= 253),
    CONSTRAINT "crm_links_entity_type_check" CHECK ("entity_type" IN ('inquiry', 'order')),
    -- C1 writes deals only (owner decision 16): no contact, lead or other record type.
    CONSTRAINT "crm_links_crm_entity_type_check" CHECK ("crm_entity_type_id" = 2),
    CONSTRAINT "crm_links_crm_id_check" CHECK ("crm_id" IS NULL OR "crm_id" > 0),
    CONSTRAINT "crm_links_originator_check" CHECK ("originator_id" = 'outlyy-' || "environment"),
    CONSTRAINT "crm_links_origin_check" CHECK ("origin_id" = (CASE "entity_type" WHEN 'inquiry' THEN 'inq:' ELSE 'ord:' END) || "entity_id"::text),
    CONSTRAINT "crm_links_state_check" CHECK ("state" IN ('pending', 'creating', 'active', 'deleted')),
    CONSTRAINT "crm_links_creating_check" CHECK ("state" <> 'creating' OR "creating_since" IS NOT NULL),
    CONSTRAINT "crm_links_active_check" CHECK ("state" <> 'active' OR "crm_id" IS NOT NULL),
    CONSTRAINT "crm_links_deleted_check" CHECK (("state" = 'deleted') = ("deleted_at" IS NOT NULL AND "delete_reason" IS NOT NULL)),
    CONSTRAINT "crm_links_delete_reason_check" CHECK ("delete_reason" IS NULL OR "delete_reason" IN ('erasure', 'retention', 'crm_deleted')),
    CONSTRAINT "crm_links_versions_check" CHECK ("local_version" >= 0 AND "pushed_version" >= 0 AND "pushed_version" <= "local_version"),
    CONSTRAINT "crm_links_pushed_hash_check" CHECK ("pushed_hash" IS NULL OR "pushed_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "crm_portal_state" (
    "environment" TEXT NOT NULL,
    "portal" TEXT NOT NULL,
    "category_id" INTEGER NOT NULL,
    "originator_id" TEXT NOT NULL,
    "paused_until" TIMESTAMPTZ(6),
    "pause_reason" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "lease_holder" TEXT,
    "lease_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_portal_state_pkey" PRIMARY KEY ("environment","portal"),
    CONSTRAINT "crm_portal_state_environment_check" CHECK ("environment" IN ('development', 'staging', 'production')),
    -- Funnel 0 is the other business's pipeline on the shared portal (doc 29 §5.1): never OUTLYY's.
    CONSTRAINT "crm_portal_state_category_check" CHECK ("category_id" > 0),
    CONSTRAINT "crm_portal_state_originator_check" CHECK ("originator_id" = 'outlyy-' || "environment"),
    CONSTRAINT "crm_portal_state_pause_reason_check" CHECK ("pause_reason" IS NULL OR "pause_reason" IN ('throttled', 'breaker', 'auth')),
    CONSTRAINT "crm_portal_state_failures_check" CHECK ("consecutive_failures" >= 0)
);

CREATE UNIQUE INDEX "crm_outbox_dedupe_key_key" ON "crm_outbox"("dedupe_key");
CREATE INDEX "crm_outbox_claim_idx" ON "crm_outbox"("environment", "portal", "status", "next_attempt_at", "created_at");
CREATE INDEX "crm_outbox_entity_idx" ON "crm_outbox"("entity_type", "entity_id");
CREATE INDEX "crm_outbox_status_updated_idx" ON "crm_outbox"("status", "updated_at");
CREATE INDEX "crm_links_state_pushed_idx" ON "crm_links"("environment", "portal", "state", "pushed_at");
CREATE UNIQUE INDEX "crm_links_entity_key" ON "crm_links"("environment", "portal", "entity_type", "entity_id");

ALTER TABLE "crm_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crm_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crm_portal_state" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "crm_outbox" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "crm_links" FROM %I', r);
      EXECUTE format('REVOKE ALL ON "crm_portal_state" FROM %I', r);
    END IF;
  END LOOP;
END $$;
