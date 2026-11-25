#!/bin/sh
# Prepares the CI service-container Postgres 17 for the vitest `db` project
# (.github/workflows/ci.yml). The CI counterpart of scripts/test-db/up.sh: the
# container is already running (a job service, 127.0.0.1 only, destroyed with
# the job), so this only adds the disposable marker and the Supabase-style API
# roles, writes .env.test.local with generated throwaway values, and applies
# the migrations and the seed through scripts/db.mjs (target guard first).
#
#   PGPASSWORD=<service password> sh scripts/test-db/ci-prepare.sh
#
# Never point this at anything but the job's own service container: the
# guard refuses a non-loopback host, a port outside its allowlist, a database
# not named outly_test_*, a server older than Postgres 17, or a missing marker.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PORT=${OUTLY_TEST_DB_PORT:-55434}
DB=outly_test_main
DB_USER=outly_test
ENV_FILE="$ROOT/.env.test.local"

fail() { echo "test-db/ci-prepare: $*" >&2; exit 2; }
[ "${CI:-}" = "true" ] || fail "CI only; on a workstation use scripts/test-db/up.sh"
[ -n "${PGPASSWORD:-}" ] || fail "PGPASSWORD (the service container's password) is not set"
[ -e "$ENV_FILE" ] && fail ".env.test.local already exists"
case "$PORT" in 55433|55434) ;; *) fail "port $PORT is not a disposable test port" ;; esac

rand() { openssl rand -hex "$1"; }
INSTANCE_ID=$(cat /proc/sys/kernel/random/uuid)

psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB" <<SQL
CREATE SCHEMA zz_disposable;
CREATE TABLE zz_disposable.zz_disposable_instance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id uuid NOT NULL,
  host_port integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO zz_disposable.zz_disposable_instance (instance_id, host_port) VALUES ('$INSTANCE_ID', $PORT);
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE $DB_USER IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE $DB_USER IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE $DB_USER IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
SQL

URL="postgresql://$DB_USER:$PGPASSWORD@127.0.0.1:$PORT/$DB?schema=public"
umask 077
{
  echo "# CI disposable test database (scripts/test-db/ci-prepare.sh). Throwaway values for one job."
  echo "DATABASE_URL=$URL"
  echo "DIRECT_URL=$URL"
  echo "OUTLY_TEST_DB_INSTANCE_ID=$INSTANCE_ID"
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
echo "test-db/ci-prepare: $DB on 127.0.0.1:$PORT ready (instance ${INSTANCE_ID%%-*})"
