#!/bin/sh
# Local test shop: the site on http://localhost:3002 with the shop env (scripts/shop/README.md).
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
unset NODE_OPTIONS
# Loaded into the shell, not via --env-file: Next passes node flags on to its workers, which refuse --env-file.
set -a
. "$ROOT/.env.test.shop.local"
set +a
# The shop runs the scheduled booking jobs (scripts/shop/jobs.sh); production keeps this off until pilot-day A10.
export SCHEDULED_BOOKING_JOBS_ENABLED="${SCHEDULED_BOOKING_JOBS_ENABLED:-true}"
# The log is also written to /tmp/outly-shop/server.log, so scripts/shop/otp.sh can show
# the phone verification code (the shop prints codes instead of sending SMS).
mkdir -p /tmp/outly-shop
node "$ROOT/node_modules/next/dist/bin/next" dev --webpack -p "${PORT:-3002}" 2>&1 | tee -a /tmp/outly-shop/server.log
