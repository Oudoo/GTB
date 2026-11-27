#!/usr/bin/env bash
# Provision the two PostgreSQL roles and the database named in `.env` on a LOCAL cluster,
# as an alternative to `docker compose up -d db` when Docker is unavailable.
#
#   alqarib_owner — schema owner, used only for migrations (MIGRATION_DATABASE_URL)
#   alqarib_app   — least-privilege runtime role (DATABASE_URL)
#
# Requires superuser access: either POSTGRES_ADMIN_URL, or `sudo -u postgres psql`
# (peer authentication). It is idempotent and never drops anything.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — run \`pnpm setup:env\` first." >&2
  exit 1
fi

# Parse URLs with node (no secret is echoed).
read -r OWNER_USER OWNER_PASS APP_USER APP_PASS DB_NAME DB_HOST DB_PORT < <(
  node --env-file="$ENV_FILE" -e '
    const o = new URL(process.env.MIGRATION_DATABASE_URL);
    const a = new URL(process.env.DATABASE_URL);
    const out = [o.username, decodeURIComponent(o.password), a.username, decodeURIComponent(a.password),
      o.pathname.slice(1), o.hostname, o.port || "5432"];
    console.log(out.join(" "));
  '
)

ADMIN_URL="$(node --env-file="$ENV_FILE" -e 'process.stdout.write(process.env.POSTGRES_ADMIN_URL ?? "")')"

# run_psql <database> [psql arguments…] — as the superuser, on the given database.
run_psql() {
  local database="$1"
  shift
  if [[ -n "$ADMIN_URL" ]]; then
    # The database goes INTO the URL: a separate `-d` would replace the whole connection
    # string and silently drop its host and password (psql would then try the local socket).
    local url
    url="$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + encodeURIComponent(process.argv[2]); process.stdout.write(u.toString())' "$ADMIN_URL" "$database")"
    psql "$url" -v ON_ERROR_STOP=1 -q "$@"
  elif [[ "$(id -u)" == "0" ]]; then
    su postgres -c "psql -v ON_ERROR_STOP=1 -q -p $DB_PORT -d $(printf '%q' "$database") $(printf '%q ' "$@")"
  else
    sudo -u postgres psql -v ON_ERROR_STOP=1 -q -p "$DB_PORT" -d "$database" "$@"
  fi
}

# Only a LOCAL cluster is started here. With POSTGRES_ADMIN_URL the server lives elsewhere
# (Docker, CI service) and a stopped local installation is none of this script's business.
if [[ -z "$ADMIN_URL" ]] && command -v pg_lsclusters >/dev/null 2>&1 && pg_lsclusters -h | grep -q " down "; then
  echo "Starting local PostgreSQL cluster…"
  CL=$(pg_lsclusters -h | awk '$4=="down"{print $1" "$2; exit}')
  # shellcheck disable=SC2086
  pg_ctlcluster $CL start || true
fi

run_psql postgres \
  -v owner="$OWNER_USER" -v owner_pass="$OWNER_PASS" \
  -v app="$APP_USER" -v app_pass="$APP_PASS" -v db="$DB_NAME" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN CREATEDB PASSWORD %L', :'owner', :'owner_pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner') \gexec
SELECT format('ALTER ROLE %I LOGIN CREATEDB PASSWORD %L', :'owner', :'owner_pass') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app', :'app_pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app') \gexec
SELECT format('ALTER ROLE %I LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD %L', :'app', :'app_pass') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'owner')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL

# btree_gist backs the "no overlapping effective agreement versions" exclusion constraint.
run_psql "$DB_NAME" -c 'CREATE EXTENSION IF NOT EXISTS btree_gist;'

echo "PostgreSQL ready: database \"$DB_NAME\" on $DB_HOST:$DB_PORT (owner \"$OWNER_USER\", runtime \"$APP_USER\")."
