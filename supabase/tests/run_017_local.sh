#!/usr/bin/env bash
set -euo pipefail

container_name="softplace-retrieval-observability-test"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

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
  < "$repo_root/supabase/tests/017_retrieval_observability.sql"

echo "retrieval observability SQL integration test passed"
