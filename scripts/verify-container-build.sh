#!/usr/bin/env bash
set -euo pipefail

export POSTGRES_PASSWORD=ci_fixture_only SESSION_SECRET=ci_fixture_only
export APP_ORIGIN=https://monitoring.example.test SITE_ADDRESS=monitoring.example.test
export ARCHIVE_ROOT_HOST=. ARCHIVE_SERVICE_TOKEN=ci_fixture_only_not_for_runtime
export POTION_MODEL_HOST=. ANALYTICS_MODEL_HOST=.
docker compose config --quiet
docker compose -f docker-compose.yml -f deploy/lightweight.compose.yml config --quiet
docker compose -f docker-compose.yml -f deploy/local.compose.yml config --quiet
docker compose -f docker-compose.yml -f deploy/local.compose.yml -f deploy/local-gpu.compose.yml config --quiet
docker build --target runtime -t monitoring-ci:runtime .
docker build --target proxy -t monitoring-ci:proxy .

docker run --rm -i --entrypoint sh monitoring-ci:runtime -s <<'CHECK'
set -eu
test "$(id -u)" -ne 0
test -f dist/apps/api/src/server.js
test -f dist/src/storage/schema/run-migrations.js
CHECK
