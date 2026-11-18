-- TravelDesk Stage 2 (docs/backend/21 §15.3): supplier booking attempts,
-- their append-only event log, a durable supplier job queue and the
-- single-flight lease per supplier account. Additive only: new enum, four new
-- tables, no change to existing tables. Generated with `prisma migrate diff`
-- and edited by hand: the products indexes and products.search_vector the
-- diff wanted to drop are hand-written in earlier migrations and are kept, as
-- are the partial index and CHECKs below (Prisma cannot express them).

-- CreateEnum
CREATE TYPE "supplier_booking_state" AS ENUM ('queued', 'reserving', 'reserved', 'confirming', 'awaiting_external', 'confirmed', 'outcome_unknown', 'not_created', 'rejected', 'expired', 'cancelling', 'cancelled', 'cancel_refused', 'manual_review');

-- CreateTable
CREATE TABLE "supplier_bookings" (
    "id" UUID NOT NULL,
    "order_id" UUID,
    "order_item_id" UUID,
    "supplier_id" UUID NOT NULL,
    "mapping_id" UUID,
    "environment" "supplier_environment" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" TEXT NOT NULL,
    "client_ref" TEXT NOT NULL,
    "booking_kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'two_step',
    "after_reserve" TEXT NOT NULL DEFAULT 'confirm',
    "state" "supplier_booking_state" NOT NULL DEFAULT 'queued',
    "tour_external_id" TEXT NOT NULL,
    "offer_external_id" TEXT NOT NULL,
    "service_date" DATE NOT NULL,
    "time_slot_id" TEXT,
    "start_minutes" INTEGER,
    "end_minutes" INTEGER,
    "adults" INTEGER NOT NULL,
    "children" INTEGER NOT NULL DEFAULT 0,
    "infants" INTEGER NOT NULL DEFAULT 0,
    "hotel_id" TEXT,
    "guest_name" TEXT NOT NULL,
    "expected_net_minor" BIGINT NOT NULL,
    "expected_net_usd_minor" BIGINT NOT NULL,
    "charged_net_minor" BIGINT,
    "charged_net_usd_minor" BIGINT,
    "refund_minor" BIGINT,
    "supplier_booking_id" TEXT,
    "supplier_status_code" INTEGER,
    "reservation_deadline" TIMESTAMPTZ(6),
    "external_in_progress" BOOLEAN NOT NULL DEFAULT false,
    "external_failed" BOOLEAN NOT NULL DEFAULT false,
    "external_failure_message" TEXT,
    "has_tickets" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "error_message" TEXT,
    "next_action_at" TIMESTAMPTZ(6),
    "poll_count" INTEGER NOT NULL DEFAULT 0,
    "recovery_searches" INTEGER NOT NULL DEFAULT 0,
    "request_payload" JSONB NOT NULL DEFAULT '{}',
    "last_response" JSONB,
    "requested_by" UUID,
    "request_sent_at" TIMESTAMPTZ(6),
    "reserved_at" TIMESTAMPTZ(6),
    "confirmed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_booking_events" (
    "id" UUID NOT NULL,
    "supplier_booking_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "operation" TEXT,
    "http_status" INTEGER,
    "duration_ms" INTEGER,
    "from_state" TEXT,
    "to_state" TEXT,
    "actor" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "supplier_booking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_jobs" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "supplier_booking_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "run_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "locked_by" TEXT,
    "locked_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_account_leases" (
    "supplier_id" UUID NOT NULL,
    "environment" "supplier_environment" NOT NULL,
    "holder" TEXT,
    "lease_until" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMPTZ(6),

    CONSTRAINT "supplier_account_leases_pkey" PRIMARY KEY ("supplier_id","environment")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bookings_idempotency_key_key" ON "supplier_bookings"("idempotency_key");

-- CreateIndex
CREATE INDEX "sb_state_next_idx" ON "supplier_bookings"("state", "next_action_at");

-- CreateIndex
CREATE INDEX "sb_service_date_idx" ON "supplier_bookings"("supplier_id", "environment", "service_date");

-- CreateIndex
CREATE UNIQUE INDEX "sb_client_ref_key" ON "supplier_bookings"("supplier_id", "environment", "client_ref");

-- CreateIndex
CREATE INDEX "sbe_booking_at_idx" ON "supplier_booking_events"("supplier_booking_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_jobs_dedupe_key_key" ON "supplier_jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "sj_due_idx" ON "supplier_jobs"("status", "run_after");

-- AddForeignKey
ALTER TABLE "supplier_bookings" ADD CONSTRAINT "supplier_bookings_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bookings" ADD CONSTRAINT "supplier_bookings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_bookings" ADD CONSTRAINT "supplier_bookings_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_booking_events" ADD CONSTRAINT "supplier_booking_events_supplier_booking_id_fkey" FOREIGN KEY ("supplier_booking_id") REFERENCES "supplier_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One live booking attempt per order item. Failed / closed attempts stay for history.
CREATE UNIQUE INDEX "sb_one_live_per_order_item" ON "supplier_bookings" ("order_item_id")
  WHERE "order_item_id" IS NOT NULL
    AND "state" NOT IN ('not_created', 'rejected', 'expired', 'cancelled');
ALTER TABLE "supplier_bookings" ADD CONSTRAINT "sb_mode_check" CHECK ("mode" IN ('two_step', 'one_step'));
ALTER TABLE "supplier_bookings" ADD CONSTRAINT "sb_after_reserve_check" CHECK ("after_reserve" IN ('confirm', 'cancel', 'hold'));
ALTER TABLE "supplier_bookings" ADD CONSTRAINT "sb_kind_check" CHECK ("booking_kind" IN ('live_book', 'ticket_only'));
ALTER TABLE "supplier_bookings" ADD CONSTRAINT "sb_pax_check" CHECK ("adults" >= 0 AND "children" >= 0 AND "infants" >= 0 AND "adults" + "children" > 0);
ALTER TABLE "supplier_bookings" ADD CONSTRAINT "sb_amounts_check" CHECK ("expected_net_minor" >= 0 AND "expected_net_usd_minor" >= 0);
ALTER TABLE "supplier_jobs" ADD CONSTRAINT "sj_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'));

-- The booking event log is append-only, like audit_logs.
CREATE TRIGGER supplier_booking_events_immutable BEFORE UPDATE OR DELETE ON "supplier_booking_events"
  FOR EACH ROW EXECUTE FUNCTION outly_raise_immutable();
