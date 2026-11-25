-- TravelDesk-native listings, build N1 (doc 30 §3.5, §3.9, §4 M3).
--
-- Forward-only and additive:
--   1. `import_batches_source_check` widened with 'traveldesk' (the importer's
--      batches) and `smc_source_check` widened with 'import' (the candidate
--      row the importer writes when it creates a mapping, so an imported link
--      has the same candidate, mapping and audit rows as a reviewed one).
--      Widening refuses no existing row. Each swap drops the old check and
--      adds the new one NOT VALID, then VALIDATEs it. Prisma runs the file in
--      one transaction, so the ACCESS EXCLUSIVE lock the DROP takes is held
--      through the VALIDATE scan; both tables are small, and the lock timeout
--      makes the migration fail fast rather than queue traffic. Split the
--      migration if either table grows large.
--   2. New table `product_redirects`: a retired listing's old slug, unique,
--      to the listing that replaced it (D12). Written only when the
--      replacement is published and reviewed; the storefront follows it
--      permanently only while the target is published and indexable, and
--      otherwise sends the visitor to the old listing's category page.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "import_batches" DROP CONSTRAINT "import_batches_source_check";
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_source_check"
  CHECK ("source" IN ('manual', 'csv', 'sheet', 'doc', 'bulk', 'traveldesk')) NOT VALID;
ALTER TABLE "import_batches" VALIDATE CONSTRAINT "import_batches_source_check";

ALTER TABLE "supplier_mapping_candidates" DROP CONSTRAINT "smc_source_check";
ALTER TABLE "supplier_mapping_candidates" ADD CONSTRAINT "smc_source_check"
  CHECK ("source" IN ('matcher', 'manual', 'import')) NOT VALID;
ALTER TABLE "supplier_mapping_candidates" VALIDATE CONSTRAINT "smc_source_check";

CREATE TABLE "product_redirects" (
  "id"                 UUID           NOT NULL,
  "old_slug"           TEXT           NOT NULL,
  "old_product_id"     UUID           NOT NULL,
  "target_product_id"  UUID           NOT NULL,
  "link_id"            UUID,
  "created_by"         UUID,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_redirects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pr_old_slug_check" CHECK ("old_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("old_slug") <= 80),
  CONSTRAINT "pr_not_self_check" CHECK ("old_product_id" <> "target_product_id")
);

CREATE UNIQUE INDEX "pr_old_slug_key" ON "product_redirects" ("old_slug");
CREATE INDEX "pr_target_idx" ON "product_redirects" ("target_product_id");

ALTER TABLE "product_redirects" ADD CONSTRAINT "product_redirects_old_product_id_fkey"
  FOREIGN KEY ("old_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_redirects" ADD CONSTRAINT "product_redirects_target_product_id_fkey"
  FOREIGN KEY ("target_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_redirects" ADD CONSTRAINT "product_redirects_link_id_fkey"
  FOREIGN KEY ("link_id") REFERENCES "supplier_listing_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_redirects" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "product_redirects" FROM %I', r);
    END IF;
  END LOOP;
END $$;
