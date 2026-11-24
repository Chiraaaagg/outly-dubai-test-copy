-- B5: a capability grant minted by a recovery challenge (doc 22 §26 F23).
--
-- Forward-only. Widens one check so guest_capability_grants.issued_for may be
-- 'recovery': a grant the customer earned by proving control of the order's
-- bound, verified contact, rather than one carried by a message. No row is
-- rewritten; every existing value stays valid.
--
-- Replacing a CHECK takes ACCESS EXCLUSIVE on the table and validates the
-- existing rows, so the migration starts with a lock timeout.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "guest_capability_grants" DROP CONSTRAINT "guest_capability_grants_issued_for_check";
ALTER TABLE "guest_capability_grants" ADD CONSTRAINT "guest_capability_grants_issued_for_check"
  CHECK ("issued_for" IN ('ticket_notification', 'status_notification', 'staff_resend', 'recovery'));
