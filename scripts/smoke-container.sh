#!/usr/bin/env bash
# Start a Bruno Web image and check it really works, not just that it runs:
# refuses anonymous access, accepts the password, and /bruno-web/selfcheck
# answers 200 (sandbox, SQLite, a real HTTP request, IPC coverage).
#   scripts/smoke-container.sh <image>
set -euo pipefail
IMAGE=$1
PASS=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
NAME=bruno-web-smoke-$$
JAR=$(mktemp)
cleanup() { docker rm -f "$NAME" > /dev/null 2>&1 || true; rm -f "$JAR"; }
trap cleanup EXIT

docker run -d --name "$NAME" -p 127.0.0.1::8484 -e BRUNO_WEB_PASSWORD="$PASS" "$IMAGE" > /dev/null
PORT=$(docker port "$NAME" 8484/tcp | head -1 | sed 's/.*://')
BASE=http://127.0.0.1:$PORT
for _ in $(seq 1 90); do
  curl -sf "$BASE/bruno-web/healthz" > /dev/null && break
  sleep 1
done
curl -sf "$BASE/bruno-web/healthz" > /dev/null || { docker logs "$NAME"; echo "not healthy"; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/bruno-web/selfcheck")
[ "$code" = 401 ] || { echo "anonymous selfcheck answered $code, expected 401"; exit 1; }

curl -s -c "$JAR" -o /dev/null --data-urlencode "password=$PASS" "$BASE/bruno-web/login"
code=$(curl -s -b "$JAR" -o /tmp/selfcheck-$$.json -w '%{http_code}' "$BASE/bruno-web/selfcheck")
cat /tmp/selfcheck-$$.json; echo; rm -f /tmp/selfcheck-$$.json
[ "$code" = 200 ] || { docker logs "$NAME" | tail -50; echo "selfcheck answered $code"; exit 1; }

[ "$(docker exec "$NAME" id -u)" = 1000 ] || { echo "container does not run as uid 1000"; exit 1; }
echo "smoke test passed: $IMAGE"
