#!/bin/sh
# Removes the disposable local Supabase Storage stack created by up.sh: the
# two containers (only when labelled outly.disposable=1), their network and
# the generated files in the workdir. Data lives on tmpfs, so this destroys
# every stored object and the database.
#
#   sh scripts/test-storage/down.sh --workdir <dir>
#   npm run test:storage:down -- --workdir <dir>
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
NET=outly-storage-net
WORKDIR=

fail() { echo "test-storage/down: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --workdir) [ $# -ge 2 ] || fail "--workdir needs a value"; WORKDIR=$2; shift 2 ;;
    --workdir=*) WORKDIR=${1#--workdir=}; shift ;;
    *) fail "unknown argument $1" ;;
  esac
done

[ -f "$ROOT/supabase/.temp/project-ref" ] && fail "the repository root is a linked Supabase project; refusing"
[ -n "$WORKDIR" ] || fail "pass --workdir <the directory given to up.sh>"
case "$WORKDIR" in /*) ;; *) fail "--workdir must be absolute" ;; esac

for c in outly-storage-api outly-storage-pg; do
  if docker container inspect "$c" >/dev/null 2>&1; then
    [ "$(docker container inspect -f '{{ index .Config.Labels "outly.disposable" }}' "$c")" = 1 ] || fail "$c is not labelled disposable; refusing"
    docker rm -f "$c" >/dev/null
    echo "test-storage/down: removed $c"
  fi
done
if docker network inspect "$NET" >/dev/null 2>&1; then
  [ "$(docker network inspect -f '{{ index .Labels "outly.disposable" }}' "$NET")" = 1 ] || fail "network $NET is not labelled disposable; refusing"
  docker network rm "$NET" >/dev/null
  echo "test-storage/down: removed network $NET"
fi

if [ -d "$WORKDIR" ]; then
  W=$(cd "$WORKDIR" && pwd -P)
  case "$W/" in "$ROOT/"*) fail "--workdir must be outside the repository" ;; esac
  rm -f "$W/storage.env" "$W/.pg.docker.env" "$W/.storage-api.docker.env" "$W/.service-auth.hdr" "$W/.bucket-create.json"
  echo "test-storage/down: removed generated files in $W"
fi
exit 0
