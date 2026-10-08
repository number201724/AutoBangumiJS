#!/usr/bin/env bash
# AutoBangumi (Node) smoke test — boots nothing, hits a running instance.
# Usage: BASE=http://127.0.0.1:7892 ./scripts/smoke.sh [username] [password]
set -u
BASE="${BASE:-http://127.0.0.1:7892}"
USER="${1:-admin}"
PASS="${2:-adminadmin}"
COOKIE="$(mktemp)"
trap 'rm -f "$COOKIE"' EXIT

ok=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then ok=$((ok+1)); echo "  ✓ $1";
  else fail=$((fail+1)); echo "  ✗ $1 (expected [$2], got [$3])"; fi
}
json() { python3 -c "import json,sys;print(str(json.load(sys.stdin)$1).lower())" 2>/dev/null; }

echo "== health =="
BODY=$(curl -s -m 5 "$BASE/health")
check "health ok" "ok" "$(echo "$BODY" | json "['status']")"

echo "== auth =="
BODY=$(curl -s -m 5 -c "$COOKIE" -X POST "$BASE/api/v1/auth/login" \
  -d "username=$USER&password=$PASS" -H 'Content-Type: application/x-www-form-urlencoded')
check "login" "true" "$(echo "$BODY" | json "['authenticated']")"
BODY=$(curl -s -m 5 -b "$COOKIE" "$BASE/api/v1/auth/me")
check "me username" "$USER" "$(echo "$BODY" | json "['username']")"
check "unauth 401" "unauthorized" "$(curl -s -m 5 "$BASE/api/v1/users" | json "['detail']")"

echo "== status =="
BODY=$(curl -s -m 5 -b "$COOKIE" "$BASE/api/v1/status")
check "status has version" "true" "$(echo "$BODY" | json "['version'] is not None and True or False")"

echo "== config =="
BODY=$(curl -s -m 5 -b "$COOKIE" "$BASE/api/v1/config/get")
check "config has downloader" "true" "$(echo "$BODY" | json "['downloader'] is not None and True or False")"

echo "== collections =="
for ep in bangumi/get/all rss movie/get/all; do
  BODY=$(curl -s -m 5 -b "$COOKIE" "$BASE/api/v1/$ep")
  check "GET $ep" "true" "$(echo "$BODY" | python3 -c 'import json,sys;print(str(isinstance(json.load(sys.stdin), list)).lower())' 2>/dev/null)"
done

echo "== inbox =="
BODY=$(curl -s -m 5 -b "$COOKIE" "$BASE/api/v1/notification/messages/unread-count")
check "unread-count" "true" "$(echo "$BODY" | json "['unread_count'] is not None and True or False")"

echo "== sse =="
BODY=$(timeout 4 curl -s -N -b "$COOKIE" "$BASE/api/v1/events/stream" | head -2)
check "sse status event" "event: status" "$(echo "$BODY" | head -1)"

echo
echo "passed: $ok, failed: $fail"
[ "$fail" -eq 0 ]
