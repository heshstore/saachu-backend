#!/usr/bin/env bash
# Install PostgreSQL 17 client tools only (pg_dump) on Ubuntu VPS.
# Safe for production: does NOT install or upgrade PostgreSQL server.
# Run on VPS as root: bash install-pg17-client.sh
set -euo pipefail

log() { echo "[pg17-client] $*"; }

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the VPS" >&2
  exit 1
fi

if [[ -x /usr/lib/postgresql/17/bin/pg_dump ]]; then
  log "Already installed: $(/usr/lib/postgresql/17/bin/pg_dump --version)"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg

if [[ ! -f /etc/apt/sources.list.d/pgdg.list ]]; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "${VERSION_CODENAME:-noble}")-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
fi

apt-get update -qq
apt-get install -y -qq postgresql-client-17

/usr/lib/postgresql/17/bin/pg_dump --version
log "PostgreSQL 17 client installed successfully"
