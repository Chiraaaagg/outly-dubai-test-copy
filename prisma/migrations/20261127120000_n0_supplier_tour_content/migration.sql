-- TravelDesk tour content, build N0 (doc 30 §3.2, §4 M1; owner decision D3,
-- 25 Nov 2026).
--
-- Forward-only and additive. One new table:
--   supplier_tour_content  one row per supplier, environment and tour: the
--                          tour's sales description and terms as plain text,
--                          FAQ, itinerary and photo references as parsed by
--                          `traveldesk.content.ts`, the sanitised raw lists
--                          they came from, the parser's schema version,
--                          warnings, a content hash and the fetch times.
--
-- Held apart from `supplier_catalogue_items` on purpose: the approved offer
-- terms hash reads the stored tour payload, so this table cannot mark an
-- approved mapping as changed. No existing table or constraint is altered.
-- No prices and no personal data: supplier marketing text and photo
-- addresses only. Supplier HTML is stored as plain text, never as HTML.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "supplier_tour_content" (
  "id"                UUID                   NOT NULL,
  "supplier_id"       UUID                   NOT NULL,
  "environment"       "supplier_environment" NOT NULL,
  "tour_external_id"  TEXT                   NOT NULL,
  "schema_version"    INTEGER                NOT NULL,
  "name"              TEXT                   NOT NULL DEFAULT '',
  "sales_description" TEXT                   NOT NULL DEFAULT '',
  "terms"             TEXT                   NOT NULL DEFAULT '',
  "video_url"         TEXT,
  "faq"               JSONB                  NOT NULL DEFAULT '[]',
  "itinerary"         JSONB                  NOT NULL DEFAULT '[]',
  "photos"            JSONB                  NOT NULL DEFAULT '[]',
  "raw"               JSONB                  NOT NULL DEFAULT '{}',
  "warnings"          TEXT[]                 NOT NULL DEFAULT ARRAY[]::TEXT[],
  "content_hash"      TEXT                   NOT NULL,
  "first_fetched_at"  TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fetched_at"        TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "changed_at"        TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_tour_content_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stc_tour_external_id_check" CHECK ("tour_external_id" ~ '^[0-9]{1,10}$'),
  CONSTRAINT "stc_schema_version_check" CHECK ("schema_version" >= 1),
  CONSTRAINT "stc_name_check" CHECK (char_length("name") <= 500),
  CONSTRAINT "stc_sales_description_check" CHECK (char_length("sales_description") <= 20000),
  CONSTRAINT "stc_terms_check" CHECK (char_length("terms") <= 20000),
  CONSTRAINT "stc_video_url_check" CHECK ("video_url" IS NULL OR ("video_url" ~ '^https://' AND char_length("video_url") <= 2048)),
  CONSTRAINT "stc_faq_array_check" CHECK (jsonb_typeof("faq") = 'array'),
  CONSTRAINT "stc_itinerary_array_check" CHECK (jsonb_typeof("itinerary") = 'array'),
  CONSTRAINT "stc_photos_array_check" CHECK (jsonb_typeof("photos") = 'array'),
  CONSTRAINT "stc_raw_object_check" CHECK (jsonb_typeof("raw") = 'object'),
  CONSTRAINT "stc_warnings_check" CHECK (cardinality("warnings") <= 500),
  CONSTRAINT "stc_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "stc_times_check" CHECK ("first_fetched_at" <= "fetched_at" AND "changed_at" <= "fetched_at")
);

CREATE UNIQUE INDEX "stc_identity_key" ON "supplier_tour_content" ("supplier_id", "environment", "tour_external_id");

ALTER TABLE "supplier_tour_content" ADD CONSTRAINT "supplier_tour_content_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supplier_tour_content" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "supplier_tour_content" FROM %I', r);
    END IF;
  END LOOP;
END $$;
