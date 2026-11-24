import { installEgressBlock } from "./src/server/__tests__/helpers/target-guard";

/**
 * `unit` project setup. No env file is loaded and no database is reachable:
 *
 *  - the libpq fallbacks are removed, and DATABASE_URL/DIRECT_URL are replaced
 *    by a sentinel on the discard port of loopback that nothing listens on.
 *    `env()` validates (it requires a URL), a suite that wrongly reaches for
 *    the database fails loudly instead of skipping, and the target guard
 *    refuses the sentinel;
 *  - the two auth secrets `env()` requires get synthetic unit-only values;
 *  - every non-loopback connection fails.
 */
for (const key of ["PGHOST", "PGHOSTADDR", "PGSERVICE", "PGDATABASE", "PGPORT"]) delete process.env[key];
process.env.DATABASE_URL = "postgresql://no-database@127.0.0.1:9/unit_tests_have_no_database";
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.AUTH_JWT_SECRET = "unit-test-only-jwt-secret-0123456789abcdef";
process.env.AUTH_COOKIE_SECRET = "unit-test-only-cookie-secret-0123456789abc";
installEgressBlock();
