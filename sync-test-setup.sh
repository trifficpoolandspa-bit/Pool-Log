#!/bin/bash
# Local Postgres for sync-test.js: the Supabase stand-ins plus the real
# snippets 03 and 04, exactly as run in the SQL Editor.
set -e
cd "$(dirname "$0")"
if ! command -v psql >/dev/null; then
  apt-get update -qq -o Dir::Etc::sourceparts=- -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/dev/null
fi
service postgresql start >/dev/null; sleep 2
su postgres -c "psql -q -c \"alter user postgres password 'pw'\""
su postgres -c "psql -q -c 'drop database if exists pl' -c 'create database pl'"
for f in sql/00-fake-supabase.sql "sql/03 - sync support.sql" "sql/04 - merge by field.sql"; do
  su postgres -c "psql -q -v ON_ERROR_STOP=1 pl -f '$f'" 2>&1 | grep -v NOTICE || true
done
(npm ls pg >/dev/null 2>&1) || npm i pg >/dev/null 2>&1
echo "sync-test database ready"
