#!/usr/bin/env bash
# Dump Neon PostgreSQL using PG 17 client (required for Neon PG 17 servers).
# Usage on VPS: pg-dump-neon.sh <output.sql> [path-to-.env]
set -euo pipefail

OUT="${1:?output file required}"
ENV_FILE="${2:-/root/Saachu-app/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "pg-dump-neon: .env not found at $ENV_FILE" >&2
  exit 1
fi

DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
if [[ -z "$DATABASE_URL" ]]; then
  echo "pg-dump-neon: DATABASE_URL missing" >&2
  exit 1
fi

PG_DUMP=""
for candidate in \
  /usr/lib/postgresql/17/bin/pg_dump \
  /usr/local/pgsql-17/bin/pg_dump \
  "$(command -v pg_dump 2>/dev/null || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    ver="$("$candidate" --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
    if [[ "$ver" -ge 17 ]]; then
      PG_DUMP="$candidate"
      break
    fi
  fi
done

if [[ -z "$PG_DUMP" ]]; then
  echo "pg-dump-neon: PostgreSQL 17+ pg_dump not found. Run scripts/install-pg17-client.sh on VPS." >&2
  exit 1
fi

echo "pg-dump-neon: using $PG_DUMP ($("$PG_DUMP" --version))"
"$PG_DUMP" "$DATABASE_URL" --no-owner --clean --if-exists --format=plain > "$OUT"

size="$(wc -c < "$OUT" | tr -d ' ')"
if [[ "$size" -lt 1000 ]]; then
  echo "pg-dump-neon: dump suspiciously small (${size} bytes)" >&2
  exit 1
fi

echo "pg-dump-neon: OK — ${size} bytes written to $OUT"
