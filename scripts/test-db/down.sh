#!/bin/sh
# Removes the disposable test database container created by up.sh. Its data
# lives on tmpfs, so this destroys the database. Only a container labelled
# outly.disposable=1 is removed. .env.test.local is kept unless --env is given.
#
#   sh scripts/test-db/down.sh [--env]           (npm run test:db:down)
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CONTAINER=outly-test-pg17
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  [ "$(docker container inspect -f '{{ index .Config.Labels "outly.disposable" }}' "$CONTAINER")" = 1 ] || { echo "test-db/down: $CONTAINER is not labelled disposable; refusing" >&2; exit 2; }
  docker rm -f "$CONTAINER" >/dev/null
  echo "test-db/down: removed $CONTAINER"
fi
[ "${1:-}" = "--env" ] && rm -f "$ROOT/.env.test.local" && echo "test-db/down: removed .env.test.local"
exit 0
