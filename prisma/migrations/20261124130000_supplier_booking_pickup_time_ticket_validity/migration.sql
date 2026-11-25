-- Supplier pickup time and booking ticket validity (doc 29 §8.7 "Pickup";
-- review 86 B5-07).
--
-- Forward-only and additive. Two nullable columns on the existing
-- supplier_bookings table, no default, no constraint, no index, no backfill:
--   pickup_time_minutes  the pickup time TravelDesk returned for the booking,
--                        minutes after midnight Asia/Dubai, shown on the
--                        status page, the voucher card and the tickets email;
--   tickets_valid_until  the booking's own "tickets valid until" day.
-- The engine writes each only when an answer carries it, so a later answer
-- that leaves it out (a list re-read) keeps the earlier value, which the
-- sanitised last_response alone did not.
-- Both stay null for every row written before, and code from the previous
-- release names neither column (rollback: the columns stay).
--
-- Migration-safety classification: NULLABLE_COLUMNS_ONLY (listed in
-- migration-safety.test.ts). ADD COLUMN without a default is a catalogue-only
-- change but takes ACCESS EXCLUSIVE on supplier_bookings for a moment: fail
-- fast behind a held lock.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "supplier_bookings" ADD COLUMN "pickup_time_minutes" INTEGER;
ALTER TABLE "supplier_bookings" ADD COLUMN "tickets_valid_until" DATE;
