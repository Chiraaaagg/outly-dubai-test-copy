-- Two database rules from the B3 review (doc 22 §23 B3, CR-B3-12). No
-- table or column changes and no data changes; neither trigger revisits
-- existing rows.
--
-- 1. `settlements` is append-only, like `ledger_entries`: a settlement row
--    records the provider's report as received (raw_digest), and a correction
--    arrives as another report, never as an edit. Uses the existing
--    outly_raise_immutable() from 20260914000000_init.
-- 2. A refund's order item belongs to the order its payment paid for. The
--    foreign keys alone allowed a refund on one order's payment to name
--    another order's item, which would charge the remedy to the wrong
--    booking. Checked when the row is written and whenever either column
--    changes.

-- Fail fast behind a long query.
SET LOCAL lock_timeout = '5s';

CREATE TRIGGER settlements_immutable BEFORE UPDATE OR DELETE ON "settlements"
  FOR EACH ROW EXECUTE FUNCTION outly_raise_immutable();

CREATE OR REPLACE FUNCTION outly_refunds_item_on_payment_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "order_items" i
    JOIN "payments" p ON p."order_id" = i."order_id"
    WHERE i."id" = NEW."order_item_id" AND p."id" = NEW."payment_id"
  ) THEN
    RAISE EXCEPTION 'refunds: order item % is not on the order of payment %', NEW."order_item_id", NEW."payment_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER refunds_item_on_payment_order BEFORE INSERT OR UPDATE OF "order_item_id", "payment_id" ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION outly_refunds_item_on_payment_order();
