-- TravelDesk-native listings, build N3: daily upkeep (doc 30 §3.10; owner
-- decisions D17, D18, D19).
--
-- Forward-only and additive. Old code ignores every new column and table.
--   1. `supplier_listing_links` gets the upkeep state of an imported listing:
--        unavailable_since  set when its tour, or every offer it sells, left
--                           the catalogue (D19): the page stays public as
--                           inquiry with "currently unavailable";
--        hidden_at          set 14 days later, when the listing was taken off
--                           the storefront (status draft) with an alert;
--        approved_terms     per offer id, the semantic offer terms
--                           (`offerTermsOf`: pax rules, slots, pickup, policy,
--                           booking kind, price basis; never a price or net)
--                           last approved, so an automatic re-approval (D17)
--                           can name each changed term with old and new value;
--        sold_out_offer_ids offers the upkeep marked sold out (diverging,
--                           never instant, removed): it never clears a flag
--                           a person set, and never re-sells one by itself;
--        photos_hash        hash of the supplier photo list the listing's
--                           copies were made from, so photos are copied again
--                           only when the supplier's list changed;
--        upkeep_at          the last upkeep run that started on the listing
--                           (oldest first, so a run cut by its deadline is
--                           continued by the next one; set before the work,
--                           so a listing that was killed is not first forever);
--        supplier_text_hashes per editorial field, the hash of the last
--                           supplier-derived value, so "supplier text changed"
--                           beside a locked field is reported only when the
--                           supplier's own text for that field moved.
--   2. New table `supplier_listing_changes`: one row per change the upkeep
--      applied, per item it left for a person (review) and per locked field
--      whose supplier text changed (info). The admin "supplier changes" log
--      and the owner's daily digest read it. Values are listing facts, sell
--      prices and offer terms: never a supplier net. One open review per
--      listing, kind and field (partial unique index).
--
-- RLS on, no grants to the API roles, lock timeout (repository pattern).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "supplier_listing_links"
  ADD COLUMN "unavailable_since"  TIMESTAMPTZ(6),
  ADD COLUMN "hidden_at"          TIMESTAMPTZ(6),
  ADD COLUMN "approved_terms"     JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "sold_out_offer_ids" TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "photos_hash"        TEXT,
  ADD COLUMN "upkeep_at"          TIMESTAMPTZ(6),
  ADD COLUMN "supplier_text_hashes" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Constant checks on new, nullable or defaulted columns: no row can fail them, so they are added valid.
ALTER TABLE "supplier_listing_links"
  ADD CONSTRAINT "sll_hidden_check" CHECK ("hidden_at" IS NULL OR ("unavailable_since" IS NOT NULL AND "hidden_at" >= "unavailable_since")),
  ADD CONSTRAINT "sll_approved_terms_check" CHECK (jsonb_typeof("approved_terms") = 'object' AND pg_column_size("approved_terms") <= 65536),
  ADD CONSTRAINT "sll_sold_out_check" CHECK (cardinality("sold_out_offer_ids") <= 12),
  ADD CONSTRAINT "sll_photos_hash_check" CHECK ("photos_hash" IS NULL OR "photos_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "sll_supplier_text_hashes_check" CHECK (jsonb_typeof("supplier_text_hashes") = 'object' AND pg_column_size("supplier_text_hashes") <= 8192);

CREATE INDEX "sll_upkeep_idx" ON "supplier_listing_links" ("supplier_id", "environment", "upkeep_at")
  WHERE "deactivated_at" IS NULL;

CREATE TABLE "supplier_listing_changes" (
  "id"                     UUID                   NOT NULL,
  "link_id"                UUID                   NOT NULL,
  "product_id"             UUID                   NOT NULL,
  "environment"            "supplier_environment" NOT NULL,
  "run_id"                 UUID,
  "kind"                   TEXT                   NOT NULL,
  "field"                  TEXT                   NOT NULL DEFAULT '',
  "offer_external_id"      TEXT,
  "before"                 JSONB,
  "after"                  JSONB,
  "status"                 TEXT                   NOT NULL,
  "resolution"             TEXT,
  "resolved_at"            TIMESTAMPTZ(6),
  "resolved_by"            UUID,
  "digest_notification_id" UUID,
  "digested_at"            TIMESTAMPTZ(6),
  "created_at"             TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ(6)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_listing_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "slc_kind_check" CHECK ("kind" IN (
    'text', 'fact', 'price', 'photos', 'terms', 'offer_removed', 'unavailable', 'available_again', 'hidden',
    'price_jump', 'reprice_blocked', 'diverged', 'never_instant', 'new_offer', 'offer_revived', 'returned_after_hidden',
    'locked_text_changed', 'resumed'
  )),
  CONSTRAINT "slc_status_check" CHECK ("status" IN ('applied', 'review', 'resolved', 'info')),
  CONSTRAINT "slc_field_check" CHECK (char_length("field") <= 80),
  CONSTRAINT "slc_offer_check" CHECK ("offer_external_id" IS NULL OR "offer_external_id" ~ '^[0-9]{1,10}$'),
  CONSTRAINT "slc_values_check" CHECK (
    ("before" IS NULL OR pg_column_size("before") <= 16384) AND ("after" IS NULL OR pg_column_size("after") <= 16384)
  ),
  CONSTRAINT "slc_resolved_check" CHECK (
    ("status" = 'resolved') = ("resolved_at" IS NOT NULL)
    AND ("resolved_at" IS NULL OR "resolution" IN ('applied', 'dismissed', 'superseded'))
    AND ("resolved_at" IS NOT NULL OR ("resolution" IS NULL AND "resolved_by" IS NULL))
  ),
  CONSTRAINT "slc_digest_pair_check" CHECK (("digested_at" IS NULL) = ("digest_notification_id" IS NULL)),
  CONSTRAINT "slc_times_check" CHECK ("created_at" <= "updated_at")
);

-- One open review per listing, kind and field: a repeat run updates it instead of adding another.
CREATE UNIQUE INDEX "slc_open_review_key" ON "supplier_listing_changes" ("link_id", "kind", "field") WHERE "status" = 'review';
CREATE INDEX "slc_product_idx" ON "supplier_listing_changes" ("product_id", "created_at" DESC);
CREATE INDEX "slc_digest_idx" ON "supplier_listing_changes" ("environment", "created_at") WHERE "digested_at" IS NULL;
CREATE INDEX "slc_status_idx" ON "supplier_listing_changes" ("status", "created_at" DESC);

ALTER TABLE "supplier_listing_changes" ADD CONSTRAINT "supplier_listing_changes_link_id_fkey"
  FOREIGN KEY ("link_id") REFERENCES "supplier_listing_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_listing_changes" ADD CONSTRAINT "supplier_listing_changes_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_listing_changes" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "supplier_listing_changes" FROM %I', r);
    END IF;
  END LOOP;
END $$;
