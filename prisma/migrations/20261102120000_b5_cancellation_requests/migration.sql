-- B5: customer cancellation and exception requests (doc 22 §23 B5, F15, F51).
--
-- Forward-only and additive. New table:
--   cancellation_requests  one customer request per order item at a time
--
-- A supported request is an engine cancel (verified by the cancelled status,
-- status 4) followed by a refund opened through the payment refund driver;
-- an exception request only asks our team and promises nothing. The request
-- never writes supplier attempt state and never moves money itself: the
-- refund row it names is opened by the payments code under the refund cap.
--
-- No existing row is rewritten. The foreign keys reference existing tables
-- (orders, order_items, supplier_bookings, refunds) and take a SHARE ROW
-- EXCLUSIVE lock on each, so the migration starts with a lock timeout.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "cancellation_requests" (
  "id"                    UUID         NOT NULL,
  "order_id"              UUID         NOT NULL,
  "order_item_id"         UUID         NOT NULL,
  "supplier_booking_id"   UUID,
  "kind"                  TEXT         NOT NULL,
  "status"                TEXT         NOT NULL,
  "requested_via"         TEXT         NOT NULL,
  "eligibility"           JSONB        NOT NULL DEFAULT '{}',
  "reason_code"           TEXT,
  "refund_id"             UUID,
  "attention_required_at" TIMESTAMPTZ(6),
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at"             TIMESTAMPTZ(6),
  CONSTRAINT "cancellation_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cancellation_requests_kind_check" CHECK ("kind" IN ('supported', 'exception')),
  CONSTRAINT "cancellation_requests_status_check" CHECK ("status" IN (
    'requested', 'cancelling', 'cancel_unverified', 'refund_pending', 'refunded',
    'refused', 'refund_failed', 'exception_open', 'exception_closed')),
  -- An exception request is only ever open or closed; a supported one never uses those two values.
  CONSTRAINT "cancellation_requests_kind_status_check" CHECK (
    ("kind" = 'exception') = ("status" IN ('exception_open', 'exception_closed'))),
  CONSTRAINT "cancellation_requests_via_check" CHECK ("requested_via" IN ('customer', 'guest', 'staff')),
  -- A refund is named only once the operator's cancellation is verified.
  CONSTRAINT "cancellation_requests_refund_check" CHECK (
    "refund_id" IS NULL OR ("kind" = 'supported' AND "status" IN ('refund_pending', 'refunded', 'refund_failed'))),
  -- Closed exactly when the request has reached an end state.
  CONSTRAINT "cancellation_requests_closed_check" CHECK (
    ("closed_at" IS NOT NULL) = ("status" IN ('refunded', 'refused', 'exception_closed'))),
  CONSTRAINT "cancellation_requests_reason_code_check" CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z0-9_.]{1,64}$'),
  CONSTRAINT "cancellation_requests_eligibility_object_check" CHECK (jsonb_typeof("eligibility") = 'object')
);

ALTER TABLE "cancellation_requests"
  ADD CONSTRAINT "cancellation_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cancellation_requests_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cancellation_requests_supplier_booking_id_fkey" FOREIGN KEY ("supplier_booking_id") REFERENCES "supplier_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cancellation_requests_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "cancellation_requests_refund_id_key" ON "cancellation_requests" ("refund_id");
CREATE INDEX "cancellation_requests_order_idx" ON "cancellation_requests" ("order_id");
CREATE INDEX "cancellation_requests_item_idx" ON "cancellation_requests" ("order_item_id");
CREATE INDEX "cancellation_requests_status_idx" ON "cancellation_requests" ("status", "updated_at");
-- At most one open request per order item, so a double click or two tabs make one request.
CREATE UNIQUE INDEX "cancellation_requests_one_open_per_item" ON "cancellation_requests" ("order_item_id")
  WHERE "closed_at" IS NULL;

-- The order item must belong to the order, and a named supplier booking to that item.
CREATE OR REPLACE FUNCTION "outly_cancellation_request_consistent"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "order_items" WHERE "id" = NEW."order_item_id" AND "order_id" = NEW."order_id") THEN
    RAISE EXCEPTION 'cancellation request: order item % is not on order %', NEW."order_item_id", NEW."order_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supplier_booking_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "supplier_bookings" WHERE "id" = NEW."supplier_booking_id" AND "order_item_id" = NEW."order_item_id") THEN
    RAISE EXCEPTION 'cancellation request: supplier booking % is not for order item %', NEW."supplier_booking_id", NEW."order_item_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."refund_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "refunds" WHERE "id" = NEW."refund_id" AND "order_item_id" = NEW."order_item_id") THEN
    RAISE EXCEPTION 'cancellation request: refund % is not for order item %', NEW."refund_id", NEW."order_item_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."order_id" <> OLD."order_id" OR NEW."order_item_id" <> OLD."order_item_id" OR NEW."kind" <> OLD."kind"
       OR NEW."requested_via" <> OLD."requested_via" OR NEW."created_at" <> OLD."created_at" THEN
      RAISE EXCEPTION 'cancellation request: order, item, kind, origin and creation time are fixed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."closed_at" IS NOT NULL THEN
      RAISE EXCEPTION 'cancellation request % is closed', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."refund_id" IS NOT NULL AND NEW."refund_id" IS DISTINCT FROM OLD."refund_id" THEN
      RAISE EXCEPTION 'cancellation request: the refund it names is fixed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "cancellation_requests_consistent"
  BEFORE INSERT OR UPDATE ON "cancellation_requests"
  FOR EACH ROW EXECUTE FUNCTION "outly_cancellation_request_consistent"();

-- RLS on, and no Supabase API role may read or write it (prisma/migrations/README.md).
ALTER TABLE "cancellation_requests" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "cancellation_requests" FROM %I', r);
    END IF;
  END LOOP;
END $$;
