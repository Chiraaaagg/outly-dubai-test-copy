-- External-supplier route on the supplier booking (doc 29 Batch 6).
--
-- Forward-only and additive. One nullable column on the existing
-- supplier_bookings table, no default, no constraint, no index, no backfill:
--   external_route  true when the attempt books an offer whose class is on
--                   the external-supplier route (`isExternal`), written once
--                   at intent from the capability verdict. The engine then
--                   takes the hold deadline from the supplier's answer only,
--                   refuses to confirm a hold too short to confirm safely,
--                   and the status page says confirmation can take a few
--                   minutes. Null (every row written before, and every
--                   internal attempt) reads as internal.
-- No external offer has ever been booked, so no existing row needs it. Code
-- from the previous release names no such column (rollback: the column
-- stays).
--
-- Migration-safety classification: NULLABLE_COLUMNS_ONLY (listed in
-- migration-safety.test.ts). ADD COLUMN without a default is a catalogue-only
-- change but takes ACCESS EXCLUSIVE on supplier_bookings for a moment: fail
-- fast behind a held lock.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "supplier_bookings" ADD COLUMN "external_route" BOOLEAN;
