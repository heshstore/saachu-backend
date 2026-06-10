#!/usr/bin/env bash
# Verify VPS .env is production-ready — abort deploy if misconfigured.
set -euo pipefail

ENV_FILE="${1:-/root/Saachu-app/.env}"
PRODUCTION_DB_HOST="${PRODUCTION_DB_HOST:-ep-noisy-pond-a1nmenkk-pooler.ap-southeast-1.aws.neon.tech}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "verify-production-db: .env not found at $ENV_FILE" >&2
  exit 1
fi

NODE_ENV="$(grep -m1 '^NODE_ENV=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)"
if [[ "$NODE_ENV" != "production" ]]; then
  echo "verify-production-db: NODE_ENV must be production (got: ${NODE_ENV:-unset})" >&2
  exit 1
fi

DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
if [[ -z "$DATABASE_URL" ]]; then
  echo "verify-production-db: DATABASE_URL missing" >&2
  exit 1
fi

if echo "$DATABASE_URL" | grep -qiE 'localhost|127\.0\.0\.1'; then
  echo "verify-production-db: local database detected — abort" >&2
  exit 1
fi

if echo "$DATABASE_URL" | grep -qiE 'test|staging|preview|sandbox'; then
  echo "verify-production-db: test/staging database detected — abort" >&2
  exit 1
fi

if ! echo "$DATABASE_URL" | grep -q "$PRODUCTION_DB_HOST"; then
  echo "verify-production-db: host mismatch — expected fingerprint $PRODUCTION_DB_HOST" >&2
  exit 1
fi

echo "verify-production-db: OK — NODE_ENV=production, DATABASE_URL=$PRODUCTION_DB_HOST"
