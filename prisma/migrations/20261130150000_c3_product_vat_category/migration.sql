-- Group C: VAT category per product (doc 93 §1.2, question A6, input I8).
--
-- Forward-only and additive: one nullable column, no default, no constraint,
-- so old code and every existing row are unaffected. Null means "not
-- classified": an invoice line for such a product is refused
-- (`vat_category_missing`) and raises a staff alert; it never defaults
-- silently. The allowed values are checked in code
-- (`src/server/domain/vat.ts`, `VAT_CATEGORIES`) until the accountant
-- confirms the list; a database check follows in a later migration then.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "products" ADD COLUMN "vat_category" TEXT;
