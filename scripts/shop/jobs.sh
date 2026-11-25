#!/bin/sh
# Local test shop: runs the background jobs Vercel Cron runs in production,
# against the local site (scripts/shop/README.md). Ctrl-C stops it.
#   sh scripts/shop/jobs.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SECRET=$(grep '^CRON_SECRET=' "$ROOT/.env.test.shop.local" | cut -d= -f2-)
BASE=${SHOP_URL:-http://localhost:3002}
# call <job> [max seconds]: booking-tick may run up to its maxDuration (300 s).
call() { curl -s -o /dev/null -w "%{http_code}" -m "${2:-150}" -H "Authorization: Bearer $SECRET" "$BASE/api/jobs/$1" || echo "---"; }
i=0
echo "shop jobs: running against $BASE"
echo "fx-refresh $(call fx-refresh)"
while true; do
  # payments-tick's step, then supplier-worker's scheduled run, in one call (as the production cron, CO-38).
  printf '%s booking-tick %s' "$(date +%H:%M:%S)" "$(call booking-tick 300)"
  if [ $((i % 3)) -eq 0 ]; then printf ' documents-tick %s' "$(call documents-tick)"; fi
  if [ $((i % 15)) -eq 0 ]; then printf ' supplier-reconcile %s' "$(call supplier-reconcile)"; fi
  echo
  i=$((i + 1))
  sleep 20
done
