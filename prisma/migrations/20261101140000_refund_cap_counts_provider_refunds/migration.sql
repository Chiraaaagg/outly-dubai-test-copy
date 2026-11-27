-- The refund cap also counts refunds the provider reports that Outly did not
-- create (doc 22 §23 B3, CR-B3-8). Replaces the two cap functions from
-- 20261101130000_b3_payments_saga_ledgers in place; the triggers keep
-- pointing at them. No table, column, row or grant changes.
--
-- Accounting. Two sources describe money refunded on one payment:
--   - `payments.refunded_minor`: what the provider has confirmed refunded,
--     from its reads (saga sync, max-merged, never stepped back) and from
--     Outly refunds settled `succeeded` (refunds.ts `settle` adds them). It
--     includes refunds made outside Outly, e.g. in the provider's dashboard.
--   - `refunds` rows: Outly's own refund intents. `succeeded` rows are
--     confirmed, so the provider total already holds them; `requested`,
--     `accepted` and `unknown` rows (open) may or may not have landed yet.
-- With S = sum of succeeded rows, O = sum of open rows and R = refunded_minor,
-- provider-reported refunds with no succeeded row behind them are
-- GREATEST(R - S, 0), and the money committed is
--     S + O + GREATEST(R - S, 0) = GREATEST(R, S) + O.
-- That is never below the truth while R >= S, which holds after every commit
-- because `settle` marks a row succeeded and raises refunded_minor in one
-- transaction. S is never counted twice, and an open row
-- that has landed and shows in R before its row is settled is counted twice
-- only until the refund driver marks it succeeded. Over-counting can only
-- refuse a refund, never allow one above captured. GREATEST(R, sum of all
-- non-failed rows) would not be safe: an open Outly refund of 50 and a
-- dashboard refund of 50 on 100 captured would leave 50 "refundable".
--
-- The cap: GREATEST(R, S) + O + the new claim <= captured_minor, where S and
-- O cover the other rows and the row being written counts as open (its
-- amount is not in R yet). It is checked when a refund claims more of the
-- payment (an insert, a failed row revived, a larger amount, a
-- move to another payment, a succeeded row reopened). A change that can only
-- keep or lower the total (open -> succeeded, open -> open, any -> failed)
-- is not refused, so the driver can always record what the provider said,
-- even while a provider-reported refund pushes the total over captured.
-- refunded_minor itself is not capped here: it is the provider's fact, and
-- payments_captured_refunded_check already keeps it <= captured_minor.
--
-- Concurrency is unchanged: the payment row is locked (FOR UPDATE) before the
-- sums, and every writer of refunds, captured_minor and refunded_minor takes
-- that lock first (src/server/payments/ledger.ts `lockPayment`). Under READ
-- COMMITTED the locking read returns the latest committed payment row and the
-- sums that follow see every refund committed while this writer waited;
-- REPEATABLE READ could miss them and is refused.

-- Fail fast behind a long query.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION outly_refunds_enforce_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cap BIGINT;
  provider_refunded BIGINT;
  pay_currency "currency";
  succeeded_sum BIGINT;
  open_sum BIGINT;
  committed BIGINT;
BEGIN
  IF NEW."status" = 'failed' THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'refunds: the refund cap needs READ COMMITTED or SERIALIZABLE isolation'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A change that cannot raise GREATEST(R, S) + O on the same payment.
  IF TG_OP = 'UPDATE'
     AND NEW."payment_id" = OLD."payment_id"
     AND NEW."currency" = OLD."currency"
     AND NEW."amount_minor" <= OLD."amount_minor"
     AND OLD."status" <> 'failed'
     AND NOT (OLD."status" = 'succeeded' AND NEW."status" <> 'succeeded') THEN
    RETURN NEW;
  END IF;

  SELECT p."captured_minor", p."refunded_minor", p."currency" INTO cap, provider_refunded, pay_currency
    FROM "payments" p WHERE p."id" = NEW."payment_id" FOR UPDATE;
  IF NOT FOUND THEN
    -- The foreign key reports it.
    RETURN NEW;
  END IF;
  IF NEW."currency" <> pay_currency THEN
    RAISE EXCEPTION 'refunds: currency % differs from payment currency %', NEW."currency", pay_currency
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(r."amount_minor") FILTER (WHERE r."status" = 'succeeded'), 0),
         COALESCE(SUM(r."amount_minor") FILTER (WHERE r."status" <> 'succeeded'), 0)
    INTO succeeded_sum, open_sum
    FROM "refunds" r
    WHERE r."payment_id" = NEW."payment_id" AND r."status" <> 'failed' AND r."id" <> NEW."id";
  -- The row being written is a new claim, not in refunded_minor yet (even
  -- when written as succeeded), so it goes on top like an open refund.
  committed := GREATEST(provider_refunded, succeeded_sum) + open_sum + NEW."amount_minor";
  IF committed > cap THEN
    RAISE EXCEPTION 'refunds: non-failed refunds would total % above captured % (provider-reported refunded %)',
      committed, cap, provider_refunded
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- The other side of the cap: captured_minor never drops below the same
-- committed total. The UPDATE already holds the payment row lock, so a
-- concurrent refund writer waits for it.
CREATE OR REPLACE FUNCTION outly_payments_keep_refund_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  succeeded_sum BIGINT;
  open_sum BIGINT;
  committed BIGINT;
BEGIN
  IF NEW."captured_minor" >= OLD."captured_minor" THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(SUM(r."amount_minor") FILTER (WHERE r."status" = 'succeeded'), 0),
         COALESCE(SUM(r."amount_minor") FILTER (WHERE r."status" <> 'succeeded'), 0)
    INTO succeeded_sum, open_sum
    FROM "refunds" r WHERE r."payment_id" = NEW."id" AND r."status" <> 'failed';
  committed := GREATEST(NEW."refunded_minor", succeeded_sum) + open_sum;
  IF committed > NEW."captured_minor" THEN
    RAISE EXCEPTION 'payments: captured % would be below non-failed and provider-reported refunds %', NEW."captured_minor", committed
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
