#!/usr/bin/env bash
set -euo pipefail

container_name="softplace-ava-event-facts-test"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
test_tmp="/tmp/softplace-ava-event-facts-test.$$"
mkdir -p "$test_tmp"

cleanup() {
  status=$?
  trap - EXIT
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$test_tmp"
  exit "$status"
}
trap cleanup EXIT
docker rm -f "$container_name" >/dev/null 2>&1 || true

docker run --name "$container_name" -e POSTGRES_PASSWORD=softplace-test \
  -v "$repo_root:/workspace:ro" -d pgvector/pgvector:pg16 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container_name" pg_isready -U postgres >/dev/null
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres \
  < "$repo_root/supabase/tests/bootstrap_local.sql"
for migration in "$repo_root"/supabase/migrations/*.sql; do
  docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres < "$migration"
done
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres \
  < "$repo_root/supabase/tests/018_ava_event_facts.sql"

docker exec "$container_name" psql -v ON_ERROR_STOP=1 -At -U postgres -c \
  "select id from public.ensure_ava_event_run('ava', date '2035-01-10', 'parallel-test', 2)" >/dev/null
(
  trap - EXIT
  docker exec "$container_name" psql -v ON_ERROR_STOP=1 -At -U postgres -c \
    "select id from public.claim_ava_event_facts('ava', '10000000-0000-0000-0000-000000000001', 120)" \
    >"$test_tmp/claim-one"
) &
first_pid=$!
(
  trap - EXIT
  docker exec "$container_name" psql -v ON_ERROR_STOP=1 -At -U postgres -c \
    "select id from public.claim_ava_event_facts('ava', '20000000-0000-0000-0000-000000000002', 120)" \
    >"$test_tmp/claim-two"
) &
second_pid=$!
wait "$first_pid" "$second_pid"

claim_count="$(cat "$test_tmp/claim-one" "$test_tmp/claim-two" | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "$claim_count" != "1" ]]; then
  echo "expected exactly one parallel claim, got $claim_count" >&2
  exit 1
fi

echo "ava event facts SQL integration test passed"
