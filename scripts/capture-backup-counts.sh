#!/usr/bin/env bash
# Capture table counts into a backup directory manifest for restore verification.
set -euo pipefail

BACKUP_DIR="${1:?backup directory required}"
ENV_FILE="${2:-/root/Saachu-app/.env}"

DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
[[ -n "$DATABASE_URL" ]] || { echo "DATABASE_URL missing" >&2; exit 1; }

COUNTS="$(psql "$DATABASE_URL" -t -A -c "
  SELECT json_build_object(
    'customer',           (SELECT COUNT(*)::int FROM customer),
    'marketing_audience', (SELECT COUNT(*)::int FROM marketing_audience),
    'campaigns',          (SELECT COUNT(*)::int FROM marketing_campaigns),
    'queue',              (SELECT COUNT(*)::int FROM whatsapp_message_queue),
    'logs',               (SELECT COUNT(*)::int FROM whatsapp_message_logs)
  );
")"

echo "$COUNTS" > "${BACKUP_DIR}/counts-at-backup.json"
echo "capture-backup-counts: wrote ${BACKUP_DIR}/counts-at-backup.json — $COUNTS"
