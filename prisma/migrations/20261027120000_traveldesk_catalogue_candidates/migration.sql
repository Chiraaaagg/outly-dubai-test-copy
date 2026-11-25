-- TravelDesk Stage 1 (docs/backend/21 §3.2): supplier catalogue items, price
-- snapshots and mapping candidates, plus supplier identity columns on
-- product_supplier_mappings. Additive only: no existing column, index or row
-- is changed or dropped. Generated with `prisma migrate diff` and edited by
-- hand; the three products indexes and products.search_vector that the diff
-- wanted to drop are hand-written in earlier migrations and are kept.
-- Prisma cannot express the partial index smc_one_approved_per_variant or the
-- CHECK constraints at the end of this file: future `migrate diff` output that
-- proposes dropping them must be edited out the same way.

-- CreateEnum
CREATE TYPE "supplier_environment" AS ENUM ('test', 'production');

-- CreateEnum
CREATE TYPE "mapping_candidate_state" AS ENUM ('suggested', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "product_supplier_mappings" ADD COLUMN     "booking_kind" TEXT,
ADD COLUMN     "environment" "supplier_environment",
ADD COLUMN     "last_synced_at" TIMESTAMPTZ(6),
ADD COLUMN     "supplier_offer_id" TEXT,
ADD COLUMN     "supplier_product_id" TEXT,
ADD COLUMN     "sync_status" TEXT,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "supplier_catalogue_items" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "environment" "supplier_environment" NOT NULL,
    "kind" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "parent_external_id" TEXT,
    "name" TEXT,
    "booking_kind" TEXT,
    "is_external" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "payload_hash" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),

    CONSTRAINT "supplier_catalogue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_price_snapshots" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "environment" "supplier_environment" NOT NULL,
    "offer_external_id" TEXT NOT NULL,
    "service_date" DATE NOT NULL,
    "time_slot_id" TEXT,
    "start_minutes" INTEGER,
    "seats_left" INTEGER,
    "is_bookable" BOOLEAN NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'AED',
    "net_adult_minor" BIGINT NOT NULL,
    "net_child_minor" BIGINT NOT NULL,
    "net_trip_minor" BIGINT NOT NULL,
    "rec_adult_minor" BIGINT,
    "rec_child_minor" BIGINT,
    "rec_trip_minor" BIGINT,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_mapping_candidates" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_code" TEXT NOT NULL DEFAULT '',
    "supplier_id" UUID NOT NULL,
    "environment" "supplier_environment" NOT NULL,
    "tour_external_id" TEXT NOT NULL,
    "offer_external_id" TEXT NOT NULL,
    "state" "mapping_candidate_state" NOT NULL DEFAULT 'suggested',
    "score" INTEGER NOT NULL DEFAULT 0,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "conflicts" JSONB NOT NULL DEFAULT '[]',
    "sell_adult_minor" BIGINT,
    "net_adult_minor" BIGINT,
    "margin_bps" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'matcher',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_note" TEXT,
    "mapping_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_mapping_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sci_live_idx" ON "supplier_catalogue_items"("supplier_id", "environment", "kind", "removed_at");

-- CreateIndex
CREATE UNIQUE INDEX "sci_identity_key" ON "supplier_catalogue_items"("supplier_id", "environment", "kind", "external_id");

-- CreateIndex
CREATE INDEX "sps_offer_date_idx" ON "supplier_price_snapshots"("supplier_id", "environment", "offer_external_id", "service_date");

-- CreateIndex
CREATE INDEX "smc_state_product_idx" ON "supplier_mapping_candidates"("state", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "smc_identity_key" ON "supplier_mapping_candidates"("product_id", "variant_code", "supplier_id", "environment", "offer_external_id");

-- AddForeignKey
ALTER TABLE "supplier_catalogue_items" ADD CONSTRAINT "supplier_catalogue_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_price_snapshots" ADD CONSTRAINT "supplier_price_snapshots_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_mapping_candidates" ADD CONSTRAINT "supplier_mapping_candidates_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_mapping_candidates" ADD CONSTRAINT "supplier_mapping_candidates_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written guards (not expressible in the Prisma schema).
ALTER TABLE "supplier_catalogue_items" ADD CONSTRAINT "sci_kind_check" CHECK ("kind" IN ('tour', 'offer'));
ALTER TABLE "supplier_price_snapshots" ADD CONSTRAINT "sps_currency_aed_check" CHECK ("currency" = 'AED');
ALTER TABLE "supplier_price_snapshots" ADD CONSTRAINT "sps_amounts_nonneg_check"
  CHECK ("net_adult_minor" >= 0 AND "net_child_minor" >= 0 AND "net_trip_minor" >= 0);
ALTER TABLE "supplier_mapping_candidates" ADD CONSTRAINT "smc_source_check" CHECK ("source" IN ('matcher', 'manual'));
ALTER TABLE "supplier_mapping_candidates" ADD CONSTRAINT "smc_score_range_check" CHECK ("score" BETWEEN 0 AND 100);
-- A reviewed candidate records who decided and when.
ALTER TABLE "supplier_mapping_candidates" ADD CONSTRAINT "smc_reviewed_check"
  CHECK ("state" = 'suggested' OR ("reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL));
-- At most one approved offer per OUTLY product variant, supplier and environment.
CREATE UNIQUE INDEX "smc_one_approved_per_variant" ON "supplier_mapping_candidates" ("product_id", "variant_code", "supplier_id", "environment")
  WHERE "state" = 'approved';
