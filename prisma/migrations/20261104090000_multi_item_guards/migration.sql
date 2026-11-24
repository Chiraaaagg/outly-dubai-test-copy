-- Multi-item instant checkout, review follow-ups (Sentinel review of
-- ce9d603..4e2b5c4, P3-7 and P3-11). Additive only: one function body
-- replaced, one new function and trigger. No table, column or row changes.
-- 20261103140000_multi_item_instant is applied to test databases and is never
-- edited; this migration fixes forward.
--
-- 1. The per-item refund cap (`outly_refunds_enforce_item_cap`) now first
--    refuses a refund whose order item is not on the order its payment paid
--    for, before it reads that item's allocation. The separate trigger
--    `refunds_item_on_payment_order` (20261102100000) already refuses such a
--    row; the cap no longer depends on trigger order for it.
-- 2. `order_items_frozen_under_saga`: once an order has a payment saga, no
--    item may be added to it, and no item may be moved into or out of it.
--    The saga covers every instant item of its order, sized and allocated at
--    checkout; an item added later would be reserved and confirmed on a
--    payment that never covered it. Today no code path adds an item to an
--    existing order (items are created only inside `orderService.createOrder`,
--    before the saga row, in the checkout transaction); this makes it a rule.

-- Fail fast behind a long query.
SET LOCAL lock_timeout = '5s';

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
  IF NOT EXISTS (
    SELECT 1 FROM "order_items" i JOIN "payments" p ON p."order_id" = i."order_id"
    WHERE i."id" = NEW."order_item_id" AND p."id" = NEW."payment_id"
  ) THEN
    RAISE EXCEPTION 'refunds: item cap: order item % is not on the order of payment %', NEW."order_item_id", NEW."payment_id"
      USING ERRCODE = 'check_violation';
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

CREATE OR REPLACE FUNCTION outly_order_items_frozen_under_saga() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."order_id" = OLD."order_id" THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM "payment_sagas" s WHERE s."order_id" = NEW."order_id")
     OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM "payment_sagas" s WHERE s."order_id" = OLD."order_id")) THEN
    RAISE EXCEPTION 'order_items: order % has a payment saga; its items are fixed', NEW."order_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER order_items_frozen_under_saga
  BEFORE INSERT OR UPDATE OF "order_id" ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION outly_order_items_frozen_under_saga();
