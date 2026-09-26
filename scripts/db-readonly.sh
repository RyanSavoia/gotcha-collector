#!/bin/bash
# Read-only Postgres access for the gauntlet examiner.
#
# The examiner is an adversarial agent we deliberately point at production data. It
# gets THIS, never the connection string: credentials stay in the env file, every
# statement is screened and logged, and the transaction itself is READ ONLY so a
# screening miss still cannot write.
#
# Usage: db-readonly.sh "SELECT ..."   (or SQL on stdin)
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
GOTCHA="${GOTCHA_HOME:-$HOME/gotcha-collector}"
ENV_FILE="${GOTCHA_DB_ENV:-$HOME/client-platform/api/.env}"
LOG="$GOTCHA/logs/db-queries.log"
TIMEOUT_MS="${GOTCHA_DB_TIMEOUT_MS:-15000}"

SQL="${1:-}"
[[ -n $SQL ]] || SQL="$(cat)"
[[ -n ${SQL// /} ]] || { echo "db-readonly: empty query" >&2; exit 2; }

# Screen for anything that could mutate. Deliberately blunt: a false reject costs the
# examiner one retry, a false accept costs production data.
if printf '%s' "$SQL" | grep -qiE '\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|reindex|cluster|comment[[:space:]]+on|set[[:space:]]+role|do[[:space:]]*\$|call|merge|refresh[[:space:]]+materialized|lock)\b'; then
  printf 'db-readonly: REFUSED — statement contains a write/DDL keyword. This tool is SELECT-only.\n' >&2
  mkdir -p "$(dirname "$LOG")"
  printf '%s\tREFUSED\t%s\n' "$(date -u +%FT%TZ)" "$(printf '%s' "$SQL" | tr '\n' ' ' | cut -c1-500)" >> "$LOG"
  exit 3
fi

URL="$(node -e '
const fs=require("fs");
const t=fs.readFileSync(process.argv[1],"utf8");
const m=/^DATABASE_URL=(.*)$/m.exec(t);
if(!m){process.exit(1);}
process.stdout.write(m[1].trim().replace(/^["\x27]|["\x27]$/g,""));
' "$ENV_FILE" 2>/dev/null)"
[[ -n $URL ]] || { echo "db-readonly: no DATABASE_URL in $ENV_FILE" >&2; exit 4; }

mkdir -p "$(dirname "$LOG")"
printf '%s\tRUN\t%s\n' "$(date -u +%FT%TZ)" "$(printf '%s' "$SQL" | tr '\n' ' ' | cut -c1-500)" >> "$LOG"

# READ ONLY transaction is the actual enforcement; the grep above is defence in depth.
PGCONNECT_TIMEOUT=10 psql "$URL" \
  --quiet --no-psqlrc --pset pager=off \
  -v ON_ERROR_STOP=1 \
  -c "SET statement_timeout = ${TIMEOUT_MS}" \
  -c "BEGIN READ ONLY" \
  -c "$SQL" \
  -c "COMMIT" 2>&1 | grep -vE '^(SET|BEGIN|COMMIT)$'
exit "${PIPESTATUS[0]}"
