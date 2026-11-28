-- Approved offer hours, batch 3b follow-up (review 85 A1; doc 29 §8.6 "End time").
--
-- Batch 3b derives a slot's end from the offer's `numberOfHours` when the
-- slot stores none. Putting the hours into `approved_offer_hash` would have
-- turned every approved mapping (and every immutable evidence row) on such an
-- offer to "changed" on deploy. The hash therefore stays exactly as before and
-- the hours an approval accepted are kept in their own column, compared by
-- the code only where an end is derived (`approvedSlotHoursHold`).
--
-- Forward-only and additive: one nullable INTEGER on product_supplier_mappings,
-- no default, no constraint, no index. Then a one-off backfill: each mapping
-- that is already approved takes the hours its stored offer carries now, so on
-- deploy no approval changes; a later change of the hours does invalidate it.
-- Hours that are absent or not a whole number stay null, which never holds for
-- an offer whose end is derived (fail closed: re-approve).
--
-- Migration-safety classification: alters an existing table (ADD COLUMN plus
-- an UPDATE of existing rows), so it is in the default branch of
-- migration-safety.test.ts: own lock_timeout, must fail fast and roll back
-- behind a held lock. Not NULLABLE_COLUMNS_ONLY (it has an UPDATE).
--
-- Rows touched (count before a production apply, read-only):
--   SELECT count(*) FROM product_supplier_mappings m
--   JOIN supplier_catalogue_items o ON o.supplier_id = m.supplier_id
--     AND o.environment = m.environment AND o.kind = 'offer' AND o.external_id = m.supplier_offer_id
--   WHERE m.approved_offer_hash IS NOT NULL AND (o.payload->>'durationHours') ~ '^-?[0-9]{1,6}$';
-- Of those, the ones that rely on the backfill (a slot without a stored end):
--   ... AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.payload->'timeSlots') s WHERE s->'endMinutes' = 'null'::jsonb);
--
-- Code from the previous release names no such column and keeps working. An
-- approval written by that code during the deploy window records no hours and
-- reads as changed for a derived-end offer until re-approved (fail closed).
-- Rollback: the column stays.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "product_supplier_mappings" ADD COLUMN "approved_slot_hours" INTEGER;

UPDATE "product_supplier_mappings" AS m
SET "approved_slot_hours" = (o."payload"->>'durationHours')::integer
FROM "supplier_catalogue_items" AS o
WHERE m."approved_offer_hash" IS NOT NULL
  AND m."supplier_offer_id" IS NOT NULL
  AND o."supplier_id" = m."supplier_id"
  AND o."environment" = m."environment"
  AND o."kind" = 'offer'
  AND o."external_id" = m."supplier_offer_id"
  AND (o."payload"->>'durationHours') ~ '^-?[0-9]{1,6}$';
