-- Multi-item instant checkout (doc 22 §32.16 question 1; lead design of
-- 3 November 2026). Additive only: one nullable column, one partial unique
-- index, one check, one new trigger. No data changes, no existing row is
-- revisited, and the existing payment-level refund cap is unchanged.
--
-- 1. `order_items.quote_line_index`: the position of an instant order item in
--    the quote it was sold from (the `quotes.lines` array index). The payment
--    saga reserves, captures and confirms the items in this order, and the
--    engine reads the item's own quote line by it (two lines of one order may
--    name the same supplier mapping on different dates). NULL on every row
--    written before this migration and on every assisted item. Unique per
--    order when set.
--
-- 2. Per-item refund cap. `refunds_enforce_cap` caps the non-failed refunds of
--    one payment at its captured amount (GREATEST(R, S) + O, migration
--    20261101140000). With several items on one payment that alone would let
--    one item's refunds take another item's money. This trigger adds: on the
--    payment an order's payment saga is bound to, the non-failed refunds of one
--    order item never total more than that item's allocation (charged amount
--    less its discount share plus its tax share). Provider-reported refunds
--    (R) name no item, so they stay in the payment-level cap only; per item
--    the sum is S_item + O_item + the new claim. Not checked:
--      - a payment no saga is bound to (a duplicate payment, a manual row):
--        the payment-level cap is its only cap, as before;
--      - an item with no allocation (rows written before B2).
--    Same shortcut as the payment cap: a change that cannot raise the item's
--    total (same payment and item, amount not larger, not reviving a failed
--    row) is not refused, so the driver can always record what the provider
--    said. Concurrency: the payment row is locked (FOR UPDATE) before the sum,
--    like the payment cap and every refund writer (ledger.ts `lockPayment`).

-- Fail fast behind a long query.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "order_items" ADD COLUMN "quote_line_index" INTEGER;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quote_line_index_check"
  CHECK ("quote_line_index" IS NULL OR ("quote_line_index" >= 0 AND "quote_line_index" < 100));
CREATE UNIQUE INDEX "order_items_order_quote_line_key" ON "order_items" ("order_id", "quote_line_index")
  WHERE "quote_line_index" IS NOT NULL;

CREATE OR REPLACE FUNCTION outly_refunds_enforce_item_cap() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  allocation BIGINT;
  item_sum BIGINT;
BEGIN
  IF NEW."status" = 'failed' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."payment_id" = OLD."payment_id"
     AND NEW."order_item_id" = OLD."order_item_id"
     AND NEW."amount_minor" <= OLD."amount_minor"
     AND OLD."status" <> 'failed' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "payment_sagas" s WHERE s."payment_id" = NEW."payment_id") THEN
    RETURN NEW;
  END IF;
  SELECT i."charged_amount_minor" - COALESCE(i."discount_alloc_minor", 0) + COALESCE(i."tax_alloc_minor", 0)
    INTO allocation
    FROM "order_items" i WHERE i."id" = NEW."order_item_id";
  IF allocation IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "payments" p WHERE p."id" = NEW."payment_id" FOR UPDATE;
  SELECT COALESCE(SUM(r."amount_minor"), 0) INTO item_sum
    FROM "refunds" r
    WHERE r."payment_id" = NEW."payment_id" AND r."order_item_id" = NEW."order_item_id"
      AND r."status" <> 'failed' AND r."id" <> NEW."id";
  IF item_sum + NEW."amount_minor" > allocation THEN
    RAISE EXCEPTION 'refunds: non-failed refunds would total % above the allocation % of order item %',
      item_sum + NEW."amount_minor", allocation, NEW."order_item_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER refunds_enforce_item_cap
  BEFORE INSERT OR UPDATE OF "payment_id", "order_item_id", "amount_minor", "status" ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION outly_refunds_enforce_item_cap();
