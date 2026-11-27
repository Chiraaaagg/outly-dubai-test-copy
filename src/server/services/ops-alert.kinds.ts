/**
 * Every `ops_alerts.entity_kind` the code writes, at run time, so a test can
 * check it against the database constraint `ops_alerts_entity_kind_check`
 * (review 102 finding 1). `digest` is the digest row's own kind and is not an
 * incident entity. No imports: unit tests read this without a database.
 *
 * Keep in step with the latest migration that re-creates the constraint; the
 * test `src/server/__tests__/group-c/ops-alert-entity-kinds.test.ts` fails
 * when a kind is missing there or when a migration narrows the list.
 */
export const OPS_ENTITY_KINDS = [
  "supplier_account",
  "payment_saga",
  "order_item",
  "supplier_booking",
  "supplier_document",
  "crm_subject",
  "privileged_approval",
  "bulk_operation_item",
  /** Group B (impl/postpay-b migration 20261130120000; re-review N12): listed here now so the merge cannot drop them. */
  "order_account_link",
  "customer",
  "email_volume",
  /** Group C: needs migration 20261130160000 (ops_alerts_entity_kind_check). */
  "payment",
  "ledger_entry",
] as const;

export type OpsEntityKind = (typeof OPS_ENTITY_KINDS)[number];
