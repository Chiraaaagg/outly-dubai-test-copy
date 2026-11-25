-- Doc 29 §6.5, CRM batch C1 review R13: an ops-alert incident for a CRM copy
-- that could not be deleted (a dead-lettered `delete` row in crm_outbox, from
-- erasure or the 2-year retention delete). ops_alerts keys incidents by
-- (entity_kind, entity_id, reason); this widens the entity kinds with
-- 'crm_subject' (entity_id `inquiry:<uuid>` or `order:<uuid>`, ids only).
--
-- Widening only: every existing row still passes. ops_alerts is a small table
-- (one row per incident and reason). Forward-compatible: code before this
-- migration never writes the new kind, and code after it writes the new kind
-- only for dead CRM delete rows, which need CRM delivery switched on (off
-- until C2). Rollback: none needed; the wider check can stay.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "ops_alerts" DROP CONSTRAINT "ops_alerts_entity_kind_check";
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_entity_kind_check" CHECK ("entity_kind" IN
  ('supplier_account', 'payment_saga', 'order_item', 'supplier_booking', 'supplier_document', 'crm_subject', 'digest'));
