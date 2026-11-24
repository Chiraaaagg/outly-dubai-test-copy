-- Ops alert emails for instant-path incidents (doc 22 §32.24: alerts by email).
--
-- Forward-only and additive. New table:
--   ops_alerts  one row per (entity, reason): the durable dedup (one email per
--               entity and reason per 6 hours), the hourly throttle and the
--               "N more alerts suppressed" digest, plus the after-commit
--               outbox flag (`dispatch_pending`).
--
-- No existing table is altered and no function is created. The table holds
-- codes, ids, timestamps and the email's own context only: never customer
-- contact data, never supplier net prices.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "ops_alerts" (
  "id"                  UUID           NOT NULL,
  "entity_kind"         TEXT           NOT NULL,
  "entity_id"           TEXT           NOT NULL,
  "reason"              TEXT           NOT NULL,
  "incident_at"         TIMESTAMPTZ(6) NOT NULL,
  "handled_at"          TIMESTAMPTZ(6) NOT NULL,
  "last_sent_at"        TIMESTAMPTZ(6),
  "last_suppressed_at"  TIMESTAMPTZ(6),
  "sends"               INTEGER        NOT NULL DEFAULT 0,
  "suppressed"          INTEGER        NOT NULL DEFAULT 0,
  "payload"             JSONB          NOT NULL DEFAULT '{}',
  "dispatch_pending"    BOOLEAN        NOT NULL DEFAULT false,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ops_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ops_alerts_entity_kind_check" CHECK ("entity_kind" IN
    ('supplier_account', 'payment_saga', 'order_item', 'supplier_booking', 'supplier_document', 'digest')),
  CONSTRAINT "ops_alerts_entity_id_check" CHECK (char_length("entity_id") BETWEEN 1 AND 200),
  CONSTRAINT "ops_alerts_reason_check" CHECK ("reason" ~ '^[a-z0-9_.:-]{1,80}$'),
  CONSTRAINT "ops_alerts_counts_check" CHECK ("sends" >= 0 AND "suppressed" >= 0),
  CONSTRAINT "ops_alerts_payload_object_check" CHECK (jsonb_typeof("payload") = 'object')
);

CREATE UNIQUE INDEX "ops_alerts_entity_reason_key" ON "ops_alerts" ("entity_kind", "entity_id", "reason");
CREATE INDEX "ops_alerts_last_sent_idx" ON "ops_alerts" ("last_sent_at");
CREATE INDEX "ops_alerts_last_suppressed_idx" ON "ops_alerts" ("last_suppressed_at");
CREATE INDEX "ops_alerts_dispatch_pending_idx" ON "ops_alerts" ("dispatch_pending");

ALTER TABLE "ops_alerts" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "ops_alerts" FROM %I', r);
    END IF;
  END LOOP;
END $$;
