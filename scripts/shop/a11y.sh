#!/bin/sh
# Browser and accessibility checks of the new controls: the checkout hotel
# Combobox and the product page Time Slot Picker (doc 29 §7.4 "Browser";
# scripts/shop/README.md, "Browser and accessibility checks").
#
#   sh scripts/shop/a11y.sh             workstation: a fresh disposable Postgres 17
#                                       container (outly-a11y-pg17, 127.0.0.1:55435),
#                                       removed again at the end
#   sh scripts/shop/a11y.sh --keep      the same, but keep the container and env files
#   sh scripts/shop/a11y.sh --ci        CI only: the job's service container, already
#                                       prepared by scripts/test-db/ci-prepare.sh
#   ... -- <playwright args>            passed on to `playwright test --project=a11y`
#
# On a workstation under /Users/ASUS/Programs/OUTLYY, pass
# OUTLY_TEST_ALLOW_LINKED_PARENT=/Users/ASUS/Programs/OUTLYY (scripts/test-db/up.sh).
#
# Steps, all against the disposable database and synthetic data only:
#   1. the database: migrations and the seed (up.sh, or ci-prepare.sh before --ci);
#   2. the synthetic shop: scripts/shop/a11y-fixture.ts (two seeded products made
#      instant; target guard first);
#   3. the app env file .env.test.a11y.local: the database env file with
#      INSTANT_RELEASE_ENABLED=true and nothing else changed (generated local-only
#      secrets, every adapter on its mock, SMS and WhatsApp on log, no payment
#      gateway configured);
#   4. `next build` and `next start` on localhost:3100 through
#      e2e/support/guarded-server.mjs --stack postgres, which refuses any provider
#      setting and passes no inherited variable to Next;
#   5. Playwright project `a11y` (e2e/a11y-*.spec.ts). The specs answer the two
#      public supplier reads in the browser; no request leaves the machine.
#      Screenshots land in test-results/a11y-screenshots/.
#
# Never touches TravelDesk, Stripe or any hosted database.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

fail() { echo "shop/a11y: $*" >&2; exit 2; }

MODE=local
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ci) MODE=ci ;;
    --keep) KEEP=1 ;;
    --) shift; break ;;
    *) fail "unknown argument $1 (playwright arguments go after --)" ;;
  esac
  shift
done

PORT=${A11Y_APP_PORT:-3100}
APP_ENV_FILE=.env.test.a11y.local
CONTAINER=outly-a11y-pg17
DB_PORT=55435

for name in STRIPE PAYMENTS_ TRAVELDESK_API_KEY; do
  env | cut -d= -f1 | grep -q "$name" && fail "a variable matching $name is set in this shell; unset it first"
done

if [ "$MODE" = ci ]; then
  [ "${CI:-}" = "true" ] || fail "--ci runs in CI only"
  DB_ENV_FILE=.env.test.local
  [ -f "$DB_ENV_FILE" ] || fail "$DB_ENV_FILE is missing: run scripts/test-db/ci-prepare.sh first"
else
  [ "${CI:-}" = "true" ] && fail "in CI, prepare the service container and pass --ci"
  DB_ENV_FILE=.env.test.a11y-db.local
  echo "shop/a11y: disposable database $CONTAINER on 127.0.0.1:$DB_PORT"
  OUTLY_TEST_DB_PORT=$DB_PORT OUTLY_TEST_DB_CONTAINER=$CONTAINER OUTLY_TEST_ENV_FILE=$DB_ENV_FILE sh scripts/test-db/up.sh --recreate
fi

SERVER=""
cleanup() {
  status=$?
  if [ -n "$SERVER" ] && kill -0 "$SERVER" 2>/dev/null; then
    kill "$SERVER" 2>/dev/null || true
    wait "$SERVER" 2>/dev/null || true
  fi
  if [ "$MODE" = local ] && [ "$KEEP" != 1 ]; then
    if docker container inspect "$CONTAINER" >/dev/null 2>&1 && [ "$(docker container inspect -f '{{ index .Config.Labels "outly.disposable" }}' "$CONTAINER")" = 1 ]; then
      docker rm -f "$CONTAINER" >/dev/null && echo "shop/a11y: removed $CONTAINER"
    fi
    rm -f "$ROOT/$DB_ENV_FILE" "$ROOT/$APP_ENV_FILE"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "shop/a11y: synthetic shop fixture"
OUTLY_TEST_ENV_FILE=$DB_ENV_FILE NODE_OPTIONS=--conditions=react-server \
  node --no-warnings --env-file="$DB_ENV_FILE" node_modules/tsx/dist/cli.mjs scripts/shop/a11y-fixture.ts

umask 077
{
  echo "# Browser and accessibility checks (scripts/shop/a11y.sh), from $DB_ENV_FILE. Local-only generated values."
  grep -v '^INSTANT_RELEASE_ENABLED=' "$DB_ENV_FILE"
  echo "INSTANT_RELEASE_ENABLED=true"
} > "$APP_ENV_FILE"
chmod 600 "$APP_ENV_FILE"

echo "shop/a11y: production build"
env -u NODE_OPTIONS OUTLY_TEST_ENV_FILE=$APP_ENV_FILE node e2e/support/guarded-server.mjs build --stack postgres --port "$PORT"

mkdir -p test-results
LOG=test-results/a11y-server.log
env -u NODE_OPTIONS OUTLY_TEST_ENV_FILE=$APP_ENV_FILE node e2e/support/guarded-server.mjs start --stack postgres --port "$PORT" > "$LOG" 2>&1 &
SERVER=$!
i=0
until curl -fsS -o /dev/null "http://localhost:$PORT/api/catalog"; do
  i=$((i + 1))
  if [ "$i" -gt 90 ] || ! kill -0 "$SERVER" 2>/dev/null; then
    tail -n 40 "$LOG" >&2
    fail "the app did not answer on localhost:$PORT"
  fi
  sleep 1
done
echo "shop/a11y: app up on http://localhost:$PORT"

set +e
E2E_BASE_URL="http://localhost:$PORT" OUTLY_TEST_ENV_FILE=$APP_ENV_FILE node node_modules/@playwright/test/cli.js test --project=a11y ${1+"$@"}
result=$?
set -e
if [ "$result" != 0 ]; then
  echo "shop/a11y: browser checks failed; last app log lines:" >&2
  tail -n 40 "$LOG" >&2
fi
exit "$result"
