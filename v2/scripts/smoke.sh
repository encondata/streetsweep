#!/bin/sh
# Run the API smoke tests inside the api container: ./scripts/smoke.sh [stage1|stage2|...]
# Each creates throwaway accounts and deletes them afterwards.
set -e
cd "$(dirname "$0")/.."
docker compose exec -T api mkdir -p /app/smoke
for f in scripts/smoke-*.mjs; do docker compose cp "$f" "api:/app/smoke/$(basename "$f")" >/dev/null 2>&1; done
for s in ${@:-stage1 stage2}; do
  echo "== $s"
  docker compose exec -T -w /app api node "smoke/smoke-$s.mjs"
done
