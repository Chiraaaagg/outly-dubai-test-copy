#!/bin/sh
# Full browser suite (Playwright project `chromium`, every e2e/*.spec.ts except
# e2e/a11y-*.spec.ts) in CI, job "browser end-to-end tests".
#
#   sh e2e/support/ci-e2e.sh            CI only, after scripts/test-db/ci-prepare.sh
#   sh e2e/support/ci-e2e.sh -- <args>  extra arguments for `playwright test`
#
# Steps, all against the job's disposable Postgres 17 service container and
# synthetic data only:
#   1. `next build` and `next start` on localhost:3200 through
#      e2e/support/guarded-server.mjs --stack postgres, with the env file that
#      ci-prepare.sh wrote (.env.test.local: generated throwaway values, every
#      adapter on its mock, SMS and WhatsApp on log, no payment gateway). The
#      guard refuses any provider setting and passes no inherited variable to Next.
#   2. Playwright project `chromium` against that app (E2E_NEXT_DEV unset, so
#      the `private, no-store` Cache-Control check runs against `next start`).
#
# Never touches TravelDesk, Stripe or any hosted database.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

fail() { echo "ci-e2e: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    *) fail "unknown argument $1 (playwright arguments go after --)" ;;
  esac
done

[ "${CI:-}" = "true" ] || fail "runs in CI only"
ENV_FILE=.env.test.local
[ -f "$ENV_FILE" ] || fail "$ENV_FILE is missing: run scripts/test-db/ci-prepare.sh first"
PORT=${E2E_APP_PORT:-3200}

for name in STRIPE PAYMENTS_ TRAVELDESK_API_KEY; do
  env | cut -d= -f1 | grep -q "$name" && fail "a variable matching $name is set in this shell; unset it first"
done

SERVER=""
cleanup() {
  status=$?
  if [ -n "$SERVER" ] && kill -0 "$SERVER" 2>/dev/null; then
    kill "$SERVER" 2>/dev/null || true
    wait "$SERVER" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "ci-e2e: production build"
env -u NODE_OPTIONS OUTLY_TEST_ENV_FILE=$ENV_FILE node e2e/support/guarded-server.mjs build --stack postgres --port "$PORT"

mkdir -p test-results
LOG=test-results/e2e-server.log
env -u NODE_OPTIONS OUTLY_TEST_ENV_FILE=$ENV_FILE node e2e/support/guarded-server.mjs start --stack postgres --port "$PORT" > "$LOG" 2>&1 &
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
echo "ci-e2e: app up on http://localhost:$PORT"

set +e
E2E_BASE_URL="http://localhost:$PORT" OUTLY_TEST_ENV_FILE=$ENV_FILE node node_modules/@playwright/test/cli.js test --project=chromium ${1+"$@"}
result=$?
set -e
if [ "$result" != 0 ]; then
  echo "ci-e2e: browser tests failed; last app log lines:" >&2
  tail -n 40 "$LOG" >&2
fi
exit "$result"
