-- Hotel pickup, batch 3 (doc 29 §3.4, §7.3 Batch 3; owner decision §8.4 row 11).
--
-- Forward-only and additive. Two nullable columns on the existing
-- order_items table, no default, no constraint, no index, no backfill:
--   pickup_hotel_id             the TravelDesk hotel id (plain decimal) the
--                               server quote accepted for pickup;
--   pickup_hotel_name_snapshot  that hotel's name on the supplier's list at
--                               quote time, for staff and the customer.
-- Both stay null for items without pickup and for every row written before
-- this batch, so code from the previous release, which names neither column,
-- keeps working (rollback: the columns stay, doc 29 §7.3 Batch 3).
--
-- ADD COLUMN without a default is a catalogue-only change, but it still takes
-- ACCESS EXCLUSIVE on order_items for a moment: fail fast behind a held lock.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "order_items" ADD COLUMN "pickup_hotel_id" TEXT;
ALTER TABLE "order_items" ADD COLUMN "pickup_hotel_name_snapshot" TEXT;
