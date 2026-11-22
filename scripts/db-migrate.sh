#!/usr/bin/env bash
# Applies the SQL files in packages/server/src/hailboard_server/migrations in order.
# Each file runs in its own transaction together with its schema_migrations row,
# so a failing migration leaves nothing half-applied. Already applied files are skipped.
#
# Usage:  DATABASE_URL=postgres://user:pass@host:5432/dbname scripts/db-migrate.sh
# Needs the psql client on PATH.

set -euo pipefail
shopt -s nullglob

: "${DATABASE_URL:?DATABASE_URL is required}"

dir="$(cd "$(dirname "$0")/../packages/server/src/hailboard_server/migrations" && pwd)"

run() { psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

run -c "create table if not exists schema_migrations (
          version     text primary key,
          applied_at  timestamptz not null default now()
        )"

for file in "$dir"/*.sql; do
  version="$(basename "$file" .sql)"
  applied="$(run -tA -c "select 1 from schema_migrations where version = '$version'")"
  if [ -n "$applied" ]; then
    echo "skip   $version"
    continue
  fi
  echo "apply  $version"
  run --single-transaction -f "$file" \
      -c "insert into schema_migrations (version) values ('$version')"
done

echo "done"
