#!/bin/sh
# Disposable Postgres 17 for the vitest `db` project and the guarded scripts
# (docs/backend/reviews/2026-10-31-independent/security-database.md §6.3).
#
#   sh scripts/test-db/up.sh [--recreate]       (npm run test:db:up)
#
# - Container outly-test-pg17 (postgres:17), bound to 127.0.0.1 only, data on
#   tmpfs: stopping the container destroys the database, and with it the
#   marker, so the guard then refuses until this script runs again.
# - Database outly_test_main, user outly_test, random password.
# - Marker zz_disposable.zz_disposable_instance with a fresh UUID and the port.
# - Roles anon and authenticated with Supabase-style default grants, so the
#   RLS/grant lint sees what a hosted apply would expose.
# - Writes .env.test.local (git-ignored, mode 600) with generated local-only
#   secrets, then applies the migrations and the seed through scripts/db.mjs,
#   which runs the target guard first.
#
# Port: OUTLY_TEST_DB_PORT (default 55434; must be in the guard's allowlist).
# The worktrees sit under /Users/ASUS/Programs/OUTLYY, whose supabase/ is linked
# to production. Pass OUTLY_TEST_ALLOW_LINKED_PARENT=<that directory> to
# acknowledge it; the value is written to .env.test.local.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# A second disposable instance (the local test shop, scripts/shop/up.sh) passes its own
# container name and env file; the defaults are the test-suite instance.
CONTAINER=${OUTLY_TEST_DB_CONTAINER:-outly-test-pg17}
IMAGE=postgres:17
PORT=${OUTLY_TEST_DB_PORT:-55434}
DB=outly_test_main
DB_USER=outly_test
ENV_FILE="$ROOT/${OUTLY_TEST_ENV_FILE:-.env.test.local}"

fail() { echo "test-db/up: $*" >&2; exit 2; }

[ -f "$ROOT/supabase/.temp/project-ref" ] && fail "the repository root is a linked Supabase project; refusing"
case "$PORT" in 5432|6543|54322) fail "port $PORT is reserved for real or Supabase databases" ;; esac

RECREATE=0
[ "${1:-}" = "--recreate" ] && RECREATE=1

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  [ "$RECREATE" = 1 ] || fail "container $CONTAINER exists; run scripts/test-db/down.sh or pass --recreate"
  docker rm -f "$CONTAINER" >/dev/null
fi
if [ -e "$ENV_FILE" ] && [ "$RECREATE" != 1 ]; then
  fail ".env.test.local exists; pass --recreate to replace it"
fi

rand() { openssl rand -hex "$1"; }
PASSWORD=$(rand 24)
INSTANCE_ID=$(uuidgen | tr 'A-Z' 'a-z')

docker run -d --name "$CONTAINER" \
  --label outly.disposable=1 \
  -p "127.0.0.1:$PORT:5432" \
  --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB="$DB" \
  "$IMAGE" >/dev/null

i=0
until docker exec "$CONTAINER" pg_isready -q -U "$DB_USER" -d "$DB" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && fail "postgres did not become ready"
  sleep 1
done
# The entrypoint restarts the server once after init; wait for the final one.
sleep 2
until docker exec "$CONTAINER" pg_isready -q -U "$DB_USER" -d "$DB" 2>/dev/null; do sleep 1; done

docker exec -i "$CONTAINER" psql -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB" <<SQL
CREATE SCHEMA zz_disposable;
CREATE TABLE zz_disposable.zz_disposable_instance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id uuid NOT NULL,
  host_port integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO zz_disposable.zz_disposable_instance (instance_id, host_port) VALUES ('$INSTANCE_ID', $PORT);

-- Supabase API roles and the default grants an older Supabase project applies
-- to new objects in public. Migrations must revoke them (prisma/migrations/README.md).
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE $DB_USER IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE $DB_USER IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE $DB_USER IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
SQL

URL="postgresql://$DB_USER:$PASSWORD@127.0.0.1:$PORT/$DB?schema=public"
umask 077
{
  echo "# Disposable test database: scripts/test-db/up.sh, $(date -u +%Y-%m-%dT%H:%M:%SZ)."
  echo "# Local-only generated values. Recreated by up.sh --recreate; never copy these anywhere else."
  echo "DATABASE_URL=$URL"
  echo "DIRECT_URL=$URL"
  echo "OUTLY_TEST_DB_INSTANCE_ID=$INSTANCE_ID"
  [ "$PORT" = 55433 ] || [ "$PORT" = 55434 ] || echo "OUTLY_TEST_DB_PORTS=$PORT"
  [ -n "${OUTLY_TEST_ALLOW_LINKED_PARENT:-}" ] && echo "OUTLY_TEST_ALLOW_LINKED_PARENT=$OUTLY_TEST_ALLOW_LINKED_PARENT"
  echo "APP_ENV=development"
  echo "NEXT_PUBLIC_SITE_URL=http://localhost:3000"
  echo "AUTH_JWT_SECRET=$(rand 32)"
  echo "AUTH_COOKIE_SECRET=$(rand 32)"
  echo "TOTP_ENCRYPTION_KEY=$(rand 32)"
  echo "CRON_SECRET=$(rand 24)"
  echo "WHATSAPP_WEBHOOK_SECRET=$(rand 24)"
  echo "SMS_PROVIDER=log"
  echo "WHATSAPP_PROVIDER=log"
  echo "SUPPLIER_ADAPTER_RATHIN=mock"
  echo "SUPPLIER_ADAPTER_TRAVELDESK=mock"
  echo "TRAVELDESK_BOOKINGS_ENABLED=false"
  echo "INSTANT_RELEASE_ENABLED=false"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

cd "$ROOT"
node --no-warnings scripts/db.mjs migrate
node --no-warnings scripts/db.mjs seed
echo "test-db/up: $DB on 127.0.0.1:$PORT ready (instance ${INSTANCE_ID%%-*}); env in ${OUTLY_TEST_ENV_FILE:-.env.test.local}"
