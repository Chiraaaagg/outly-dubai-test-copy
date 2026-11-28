-- The payments job visits the sagas it watches least recently checked first
-- (doc 22 §23 B3, CR-B3-14). Paging by id from the oldest saga meant that
-- once more than one run's worth of sagas was watched (the eight-day
-- late-money window includes every released or failed checkout), the newest
-- live sagas were never reached. `checked_at` is when the job last picked the
-- saga; it is written before the saga runs, so a saga that keeps failing goes
-- to the back of the queue instead of blocking it. Null means never checked,
-- which sorts first.
--
-- One nullable column with no default: a catalogue-only change, no rewrite.
-- No index: the job filters by state and the candidate set is bounded by the
-- watch windows; payment_sagas_state_deadline_idx serves the deadline pass.

-- Fail fast behind a long query.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "payment_sagas" ADD COLUMN "checked_at" TIMESTAMPTZ(6);
