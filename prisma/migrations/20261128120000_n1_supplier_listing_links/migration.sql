-- TravelDesk-native listings, build N1 (doc 30 §3.3, §3.9, §4 M2; RR-01).
--
-- Forward-only and additive. One new table:
--   supplier_listing_links  one row per listing the TravelDesk importer
--                           created or adopted: the listing's identity at the
--                           supplier (tour + arrival + route + fulfilment +
--                           kind + split number, fixed at import), the
--                           mutable attributes (exact class key, start-time
--                           set), the content hash and pricing rule version
--                           it was built from, the editorial fields a person
--                           has locked, the review state (`reviewed_at`,
--                           `noindex`), the old listing it replaces and the
--                           import batch that created it.
--
-- `noindex` lives here because the activity document is strict (doc 30 §4).
-- A rolled-back listing keeps its row with `deactivated_at` set, so the
-- identity is unique among active rows only; a product has one row ever.
-- No prices, no nets, no personal data. No existing table or constraint is
-- altered; the foreign keys take a SHARE ROW EXCLUSIVE lock on the tables
-- they reference, hence the lock timeout.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "supplier_listing_links" (
  "id"                    UUID                   NOT NULL,
  "product_id"            UUID                   NOT NULL,
  "supplier_id"           UUID                   NOT NULL,
  "environment"           "supplier_environment" NOT NULL,
  "tour_external_id"      TEXT                   NOT NULL,
  "kind"                  TEXT                   NOT NULL,
  "arrival"               TEXT                   NOT NULL,
  "route"                 TEXT                   NOT NULL,
  "fulfilment"            TEXT                   NOT NULL,
  "split_number"          INTEGER                NOT NULL DEFAULT 1,
  "class_key"             TEXT,
  "start_minutes"         INTEGER[]              NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "offer_external_ids"    TEXT[]                 NOT NULL DEFAULT ARRAY[]::TEXT[],
  "content_hash"          TEXT,
  "pricing_rule_version"  INTEGER                NOT NULL,
  "import_version"        INTEGER                NOT NULL DEFAULT 1,
  "locked_fields"         TEXT[]                 NOT NULL DEFAULT ARRAY[]::TEXT[],
  "pending_fields"        TEXT[]                 NOT NULL DEFAULT ARRAY[]::TEXT[],
  "adopted"               BOOLEAN                NOT NULL DEFAULT false,
  "noindex"               BOOLEAN                NOT NULL DEFAULT true,
  "reviewed_at"           TIMESTAMPTZ(6),
  "reviewed_by"           UUID,
  "replaces_product_id"   UUID,
  "import_batch_id"       UUID,
  "deactivated_at"        TIMESTAMPTZ(6),
  "created_at"            TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_listing_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sll_tour_external_id_check" CHECK ("tour_external_id" ~ '^[0-9]{1,10}$'),
  CONSTRAINT "sll_kind_check" CHECK ("kind" IN ('instant', 'inquiry')),
  CONSTRAINT "sll_arrival_check" CHECK ("arrival" IN ('self', 'pickup_required', 'unknown')),
  CONSTRAINT "sll_route_check" CHECK ("route" IN ('internal', 'external', 'unknown', 'any')),
  CONSTRAINT "sll_fulfilment_check" CHECK ("fulfilment" IN ('live', 'ticket', 'on_request', 'unknown')),
  CONSTRAINT "sll_split_number_check" CHECK ("split_number" BETWEEN 1 AND 99),
  -- An inquiry listing has no class key and no start-time agreement (D4); an instant listing has exactly one class key.
  CONSTRAINT "sll_kind_shape_check" CHECK (
    ("kind" = 'instant' AND "class_key" IS NOT NULL AND "route" <> 'any')
    OR ("kind" = 'inquiry' AND "class_key" IS NULL AND cardinality("start_minutes") = 0 AND "split_number" = 1)
  ),
  CONSTRAINT "sll_class_key_check" CHECK ("class_key" IS NULL OR char_length("class_key") BETWEEN 1 AND 200),
  CONSTRAINT "sll_start_minutes_check" CHECK (cardinality("start_minutes") <= 48),
  CONSTRAINT "sll_offers_check" CHECK (cardinality("offer_external_ids") BETWEEN 1 AND 12),
  CONSTRAINT "sll_content_hash_check" CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "sll_pricing_rule_version_check" CHECK ("pricing_rule_version" >= 1),
  CONSTRAINT "sll_import_version_check" CHECK ("import_version" >= 1),
  CONSTRAINT "sll_fields_check" CHECK (cardinality("locked_fields") <= 60 AND cardinality("pending_fields") <= 20),
  -- Indexable only once a person has reviewed it (D8).
  CONSTRAINT "sll_noindex_review_check" CHECK ("noindex" OR "reviewed_at" IS NOT NULL),
  CONSTRAINT "sll_review_pair_check" CHECK (("reviewed_at" IS NULL) = ("reviewed_by" IS NULL)),
  CONSTRAINT "sll_replaces_self_check" CHECK ("replaces_product_id" IS NULL OR "replaces_product_id" <> "product_id"),
  CONSTRAINT "sll_times_check" CHECK ("created_at" <= "updated_at")
);

CREATE UNIQUE INDEX "sll_product_key" ON "supplier_listing_links" ("product_id");
CREATE UNIQUE INDEX "sll_identity_active_key" ON "supplier_listing_links"
  ("supplier_id", "environment", "tour_external_id", "arrival", "route", "fulfilment", "kind", "split_number")
  WHERE "deactivated_at" IS NULL;
-- One active listing replaces a given old listing.
CREATE UNIQUE INDEX "sll_replaces_active_key" ON "supplier_listing_links" ("replaces_product_id")
  WHERE "deactivated_at" IS NULL AND "replaces_product_id" IS NOT NULL;
CREATE INDEX "sll_batch_idx" ON "supplier_listing_links" ("import_batch_id");
CREATE INDEX "sll_tour_idx" ON "supplier_listing_links" ("supplier_id", "environment", "tour_external_id");

ALTER TABLE "supplier_listing_links" ADD CONSTRAINT "supplier_listing_links_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_listing_links" ADD CONSTRAINT "supplier_listing_links_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_listing_links" ADD CONSTRAINT "supplier_listing_links_replaces_product_id_fkey"
  FOREIGN KEY ("replaces_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_listing_links" ADD CONSTRAINT "supplier_listing_links_import_batch_id_fkey"
  FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supplier_listing_links" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "supplier_listing_links" FROM %I', r);
    END IF;
  END LOOP;
END $$;
