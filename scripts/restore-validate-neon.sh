#!/usr/bin/env bash
# Full DB restore round-trip proof on a disposable Neon branch.
#
# Prerequisites:
#   1. Neon console → Branches → Create branch (e.g. "restore-test") from production
#   2. Copy branch connection string (pooler URL, sslmode=require)
#   3. export RESTORE_TEST_DATABASE_URL='postgresql://...'
#
# Usage:
#   RESTORE_TEST_DATABASE_URL='postgresql://...' \
#     ./scripts/restore-validate-neon.sh /root/backups/go-live-audit-20260609-222153
#
# Or from local machine with VPS backup path via SSH:
#   RESTORE_TEST_DATABASE_URL='postgresql://...' \
#     BACKUP_DIR=/root/backups/go-live-audit-20260609-222153 \
#     ./scripts/restore-validate-neon.sh
#
set -euo pipefail

BACKUP_DIR="${1:-${BACKUP_DIR:-}}"
RESTORE_URL="${RESTORE_TEST_DATABASE_URL:-}"

if [[ -z "$BACKUP_DIR" ]]; then
  echo "Usage: RESTORE_TEST_DATABASE_URL=... $0 /path/to/backup" >&2
  exit 1
fi

if [[ -z "$RESTORE_URL" ]]; then
  echo "FATAL: RESTORE_TEST_DATABASE_URL is required (disposable Neon branch)" >&2
  echo "Steps:" >&2
  echo "  1. Neon console → project → Branches → Create branch 'restore-test'" >&2
  echo "  2. Copy pooler connection string for the new branch" >&2
  echo "  3. export RESTORE_TEST_DATABASE_URL='postgresql://...'" >&2
  exit 1
fi

if echo "$RESTORE_URL" | grep -q 'ep-noisy-pond-a1nmenkk'; then
  echo "FATAL: RESTORE_TEST_DATABASE_URL must NOT point at production fingerprint" >&2
  exit 1
fi

SQL="${BACKUP_DIR}/db-snapshot.sql"
MANIFEST="${BACKUP_DIR}/counts-at-backup.json"

[[ -f "$SQL" ]]       || { echo "Missing $SQL" >&2; exit 1; }
[[ -f "$MANIFEST" ]]  || { echo "Missing $MANIFEST" >&2; exit 1; }

count_tables() {
  psql "$1" -t -A -c "
    SELECT json_build_object(
      'customer',           (SELECT COUNT(*)::int FROM customer),
      'marketing_audience', (SELECT COUNT(*)::int FROM marketing_audience),
      'campaigns',          (SELECT COUNT(*)::int FROM marketing_campaigns),
      'queue',              (SELECT COUNT(*)::int FROM whatsapp_message_queue),
      'logs',               (SELECT COUNT(*)::int FROM whatsapp_message_logs)
    );
  "
}

echo "[restore-validate] Backup: $BACKUP_DIR"
echo "[restore-validate] Target: $(echo "$RESTORE_URL" | sed -E 's#(postgresql://)[^@]+#\1***#')"

EXPECTED="$(cat "$MANIFEST")"
echo "[restore-validate] Expected counts: $EXPECTED"

BEFORE="$(count_tables "$RESTORE_URL")"
echo "[restore-validate] Counts BEFORE restore: $BEFORE"

echo "[restore-validate] Applying db-snapshot.sql ..."
psql "$RESTORE_URL" -v ON_ERROR_STOP=1 -f "$SQL"

AFTER="$(count_tables "$RESTORE_URL")"
echo "[restore-validate] Counts AFTER restore:  $AFTER"

node -e "
const exp = JSON.parse(process.argv[1]);
const got = JSON.parse(process.argv[2]);
const keys = ['customer','marketing_audience','campaigns','queue','logs'];
let ok = true;
for (const k of keys) {
  const match = Number(exp[k]) === Number(got[k]);
  console.log('[restore-validate] ' + k + ': expected=' + exp[k] + ' got=' + got[k] + ' ' + (match ? 'OK' : 'MISMATCH'));
  if (!match) ok = false;
}
process.exit(ok ? 0 : 1);
" "$EXPECTED" "$AFTER"

echo "[restore-validate] PASSED — 100% count match on disposable branch"
