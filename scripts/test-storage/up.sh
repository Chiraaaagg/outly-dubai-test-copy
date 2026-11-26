#!/bin/sh
# Disposable local Supabase Storage for the vitest `storage` project
# (docs/backend/21 §9.1-§9.3, review TKT-3). Never a hosted project.
#
#   sh scripts/test-storage/up.sh --workdir <dir> [--port <n>] [--recreate]
#   npm run test:storage:up -- --workdir <dir>
#
# - <dir> must be an absolute directory OUTSIDE the repository (for example
#   /tmp/outly-storage-disposable). Generated secrets and the env file live
#   there only, never in the repository.
# - Refuses to start when the repository root, the workdir or any parent of
#   the workdir is a linked Supabase project (supabase/.temp/project-ref).
# - Containers outly-storage-pg (postgres:17) and outly-storage-api
#   (supabase/storage-api) on the private network outly-storage-net. That
#   network has no NAT (enable_ip_masquerade=false), so neither container can
#   reach the internet; Postgres publishes no port at all; storage-api is
#   published on 127.0.0.1:<port> only. Data (Postgres and the object files)
#   is on tmpfs: down.sh destroys everything.
# - Fresh random secrets on every run: Postgres password, JWT secret (the
#   anon and service_role HS256 JWTs are signed locally with node), and the
#   S3 protocol access key pair.
# - Creates the bucket supplier-documents as PRIVATE and checks that
#   storage.objects has no row-level policies (so anon/authenticated see
#   nothing).
# - Writes <dir>/storage.env (mode 600): the SUPPLIER_DOCS_* values plus the
#   REST URL, anon key, service key and tenant id the storage tests use. Point the tests
#   at it with OUTLY_STORAGE_ENV_FILE=<dir>/storage.env.
#
# Port: --port or OUTLY_STORAGE_PORT (default 55480).
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
NET=outly-storage-net
PG=outly-storage-pg
API=outly-storage-api
PG_IMAGE=postgres:17
API_IMAGE=supabase/storage-api:latest
BUCKET=supplier-documents
REGION=local
PORT=${OUTLY_STORAGE_PORT:-55480}
WORKDIR=
RECREATE=0

fail() { echo "test-storage/up: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --workdir) [ $# -ge 2 ] || fail "--workdir needs a value"; WORKDIR=$2; shift 2 ;;
    --workdir=*) WORKDIR=${1#--workdir=}; shift ;;
    --port) [ $# -ge 2 ] || fail "--port needs a value"; PORT=$2; shift 2 ;;
    --port=*) PORT=${1#--port=}; shift ;;
    --recreate) RECREATE=1; shift ;;
    *) fail "unknown argument $1" ;;
  esac
done

[ -f "$ROOT/supabase/.temp/project-ref" ] && fail "the repository root is a linked Supabase project; refusing"
[ -n "$WORKDIR" ] || fail "pass --workdir <absolute directory outside the repository>"
case "$WORKDIR" in /*) ;; *) fail "--workdir must be absolute" ;; esac
case "$PORT" in ''|*[!0-9]*) fail "port must be a number" ;; esac
case "$PORT" in 5432|6543|54321|54322|54323|54324|55433|55434) fail "port $PORT is reserved for real, Supabase or other test services" ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "port out of range"

# Linked-project check on the workdir and every parent, before anything is created.
d=$WORKDIR
while :; do
  [ -f "$d/supabase/.temp/project-ref" ] && fail "$d is a linked Supabase project; refusing"
  [ "$d" = / ] && break
  d=$(dirname "$d")
done

# Resolve the workdir WITHOUT creating it (the real path of its nearest
# existing ancestor plus the rest), so nothing is ever created in the repository.
case "$WORKDIR" in */../*|*/..|*/./*|*/.) fail "--workdir must not contain . or .. segments" ;; esac
d=$WORKDIR
rest=
while [ ! -d "$d" ]; do
  rest="/$(basename "$d")$rest"
  d=$(dirname "$d")
done
base=$(cd "$d" && pwd -P)
[ "$base" = / ] && base=
RESOLVED="$base$rest"
case "$RESOLVED/" in "$ROOT/"*) fail "--workdir must be outside the repository" ;; esac
case "$RESOLVED" in ''|/|/tmp|/home|/root|"$HOME") fail "--workdir must be a dedicated directory" ;; esac

mkdir -p "$WORKDIR"
chmod 700 "$WORKDIR"
WORKDIR=$(cd "$WORKDIR" && pwd -P)
case "$WORKDIR/" in "$ROOT/"*) fail "--workdir must be outside the repository" ;; esac
[ -f "$WORKDIR/supabase/.temp/project-ref" ] && fail "the workdir is a linked Supabase project; refusing"
cd "$WORKDIR"

ENV_FILE="$WORKDIR/storage.env"
PG_ENV="$WORKDIR/.pg.docker.env"
API_ENV="$WORKDIR/.storage-api.docker.env"

for c in "$PG" "$API"; do
  if docker container inspect "$c" >/dev/null 2>&1; then
    [ "$RECREATE" = 1 ] || fail "container $c exists; run scripts/test-storage/down.sh --workdir <dir> or pass --recreate"
    [ "$(docker container inspect -f '{{ index .Config.Labels "outly.disposable" }}' "$c")" = 1 ] || fail "$c is not labelled disposable; refusing"
    docker rm -f "$c" >/dev/null
  fi
done
if docker network inspect "$NET" >/dev/null 2>&1; then
  [ "$RECREATE" = 1 ] || fail "network $NET exists; run down.sh or pass --recreate"
  docker network rm "$NET" >/dev/null
fi
[ -e "$ENV_FILE" ] && [ "$RECREATE" != 1 ] && fail "$ENV_FILE exists; pass --recreate to replace it"

for img in "$PG_IMAGE" "$API_IMAGE"; do
  docker image inspect "$img" >/dev/null 2>&1 || fail "image $img is not present locally; pull it deliberately first"
done

rand() { openssl rand -hex "$1"; }
PG_PASSWORD=$(rand 24)
JWT_SECRET=$(rand 32)
S3_KEY_ID=$(rand 16)
S3_SECRET=$(rand 32)

# HS256 JWTs signed locally; the secret is passed through the environment, not argv.
jwt() {
  JWT_SECRET="$JWT_SECRET" JWT_ROLE="$1" node -e '
    const { createHmac } = require("node:crypto");
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: process.env.JWT_ROLE, iss: "outly-disposable-storage", iat: now, exp: now + 7 * 86400 })}`;
    process.stdout.write(`${body}.${createHmac("sha256", process.env.JWT_SECRET).update(body).digest("base64url")}`);
  '
}
ANON_KEY=$(jwt anon)
SERVICE_KEY=$(jwt service_role)

umask 077
{
  echo "POSTGRES_USER=postgres"
  echo "POSTGRES_PASSWORD=$PG_PASSWORD"
  echo "POSTGRES_DB=postgres"
} > "$PG_ENV"
{
  echo "DATABASE_URL=postgres://postgres:$PG_PASSWORD@$PG:5432/postgres"
  echo "DB_INSTALL_ROLES=true"
  echo "AUTH_JWT_SECRET=$JWT_SECRET"
  echo "AUTH_JWT_ALGORITHM=HS256"
  echo "ANON_KEY=$ANON_KEY"
  echo "SERVICE_KEY=$SERVICE_KEY"
  echo "TENANT_ID=outly-disposable"
  echo "REGION=$REGION"
  echo "STORAGE_BACKEND=file"
  echo "STORAGE_FILE_BACKEND_PATH=/var/lib/storage"
  echo "S3_PROTOCOL_ENABLED=true"
  echo "S3_PROTOCOL_ENFORCE_REGION=true"
  echo "S3_PROTOCOL_ACCESS_KEY_ID=$S3_KEY_ID"
  echo "S3_PROTOCOL_ACCESS_KEY_SECRET=$S3_SECRET"
  echo "SERVER_HOST=0.0.0.0"
  echo "SERVER_PORT=5000"
  echo "UPLOAD_FILE_SIZE_LIMIT=52428800"
  echo "IMAGE_TRANSFORMATION_ENABLED=false"
  echo "PG_QUEUE_ENABLE=false"
  echo "EXPOSE_DOCS=false"
  echo "LOG_LEVEL=warn"
} > "$API_ENV"
chmod 600 "$PG_ENV" "$API_ENV"

# No NAT: containers on this bridge cannot reach anything beyond the host.
docker network create --label outly.disposable=1 -o com.docker.network.bridge.enable_ip_masquerade=false "$NET" >/dev/null

docker run -d --name "$PG" \
  --label outly.disposable=1 --label "outly.storage-workdir=$WORKDIR" \
  --network "$NET" \
  --tmpfs /var/lib/postgresql/data:rw \
  --env-file "$PG_ENV" \
  "$PG_IMAGE" >/dev/null

i=0
until docker exec "$PG" pg_isready -q -U postgres -d postgres 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && fail "postgres did not become ready"
  sleep 1
done
# The entrypoint restarts the server once after init; wait for the final one.
sleep 2
until docker exec "$PG" pg_isready -q -U postgres -d postgres 2>/dev/null; do sleep 1; done

docker run -d --name "$API" \
  --label outly.disposable=1 --label "outly.storage-workdir=$WORKDIR" \
  --network "$NET" \
  -p "127.0.0.1:$PORT:5000" \
  --tmpfs /var/lib/storage:rw \
  --env-file "$API_ENV" \
  "$API_IMAGE" >/dev/null

BASE="http://127.0.0.1:$PORT"
i=0
until curl -sf --noproxy '*' -m 2 -o /dev/null "$BASE/status"; do
  i=$((i + 1))
  if [ "$i" -gt 90 ] || [ "$(docker container inspect -f '{{.State.Running}}' "$API" 2>/dev/null)" != true ]; then
    docker logs --tail 40 "$API" >&2 || true
    fail "storage-api did not become ready"
  fi
  sleep 1
done

# Service key as a header file, so it never appears in argv.
AUTH_HDR="$WORKDIR/.service-auth.hdr"
printf 'Authorization: Bearer %s\n' "$SERVICE_KEY" > "$AUTH_HDR"
cleanup() { rm -f "$AUTH_HDR"; }
trap cleanup EXIT

code=$(curl -s --noproxy '*' -m 10 -o "$WORKDIR/.bucket-create.json" -w '%{http_code}' -X POST "$BASE/bucket" \
  -H @"$AUTH_HDR" -H 'Content-Type: application/json' \
  --data "{\"id\":\"$BUCKET\",\"name\":\"$BUCKET\",\"public\":false}")
[ "$code" = 200 ] || { cat "$WORKDIR/.bucket-create.json" >&2; fail "bucket creation returned HTTP $code"; }
rm -f "$WORKDIR/.bucket-create.json"

public=$(docker exec "$PG" psql -U postgres -d postgres -Atc "select public from storage.buckets where id = '$BUCKET'")
[ "$public" = f ] || fail "bucket $BUCKET is not private (public=$public)"
policies=$(docker exec "$PG" psql -U postgres -d postgres -Atc "select count(*) from pg_policies where schemaname = 'storage' and tablename in ('objects', 'buckets')")
[ "$policies" = 0 ] || fail "storage has $policies row-level policies; expected none"
rls=$(docker exec "$PG" psql -U postgres -d postgres -Atc "select relrowsecurity from pg_class where oid = 'storage.objects'::regclass")
[ "$rls" = t ] || fail "row-level security is off on storage.objects"

{
  echo "# Disposable local Supabase Storage: scripts/test-storage/up.sh, $(date -u +%Y-%m-%dT%H:%M:%SZ)."
  echo "# Local-only generated values for 127.0.0.1; destroyed by down.sh. Never copy them anywhere else."
  echo "OUTLY_STORAGE_DISPOSABLE=1"
  echo "SUPPLIER_DOCS_STORE=supabase_s3"
  echo "SUPPLIER_DOCS_S3_ENDPOINT=$BASE/s3"
  echo "SUPPLIER_DOCS_S3_REGION=$REGION"
  echo "SUPPLIER_DOCS_S3_ACCESS_KEY_ID=$S3_KEY_ID"
  echo "SUPPLIER_DOCS_S3_SECRET_ACCESS_KEY=$S3_SECRET"
  echo "SUPPLIER_DOCS_BUCKET=$BUCKET"
  echo "OUTLY_STORAGE_REST_URL=$BASE"
  echo "OUTLY_STORAGE_ANON_KEY=$ANON_KEY"
  echo "OUTLY_STORAGE_SERVICE_KEY=$SERVICE_KEY"
  echo "OUTLY_STORAGE_TENANT_ID=outly-disposable"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "test-storage/up: storage-api on 127.0.0.1:$PORT, private bucket $BUCKET, no storage policies, RLS on"
echo "test-storage/up: env in $ENV_FILE (run: OUTLY_STORAGE_ENV_FILE=$ENV_FILE npm run test:storage)"
