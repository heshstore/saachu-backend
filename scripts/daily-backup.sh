#!/usr/bin/env bash
# Daily Neon backup — runs via cron on VPS.
# Dumps production DB, compresses, logs, prunes backups older than 30 days.
#
# Cron (as root, daily at 02:00 IST = 20:30 UTC):
#   30 20 * * * /root/Saachu-app/scripts/daily-backup.sh >> /root/backups/daily/cron.log 2>&1
#
# Paths (all configurable via environment):
#   BACKUP_ROOT     /root/backups/daily
#   ENV_FILE        /root/Saachu-app/.env
#   SCRIPTS_DIR     /root/Saachu-app/scripts
#   RETENTION_DAYS  30
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/root/backups/daily}"
ENV_FILE="${ENV_FILE:-/root/Saachu-app/.env}"
SCRIPTS_DIR="${SCRIPTS_DIR:-/root/Saachu-app/scripts}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

DATESTAMP="$(TZ=Asia/Kolkata date '+%Y-%m-%d')"
TIMESTAMP="$(TZ=Asia/Kolkata date '+%Y-%m-%d_%H-%M-%S_IST')"
DEST="${BACKUP_ROOT}/${DATESTAMP}"
LOGFILE="${BACKUP_ROOT}/cron.log"
TMPFILE="${DEST}/db-snapshot.sql"
OUTFILE="${DEST}/db-snapshot.sql.gz"

log() { echo "[daily-backup] $(TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M:%S IST') $*"; }

log "---- START backup ${TIMESTAMP} ----"

# ── Preflight ────────────────────────────────────────────────────────────────
[[ -f "$ENV_FILE" ]] || { log "FATAL: ENV_FILE not found: $ENV_FILE"; exit 1; }
[[ -f "${SCRIPTS_DIR}/pg-dump-neon.sh" ]] || { log "FATAL: pg-dump-neon.sh not found in $SCRIPTS_DIR"; exit 1; }

# Guard: do not overwrite an existing daily backup
if [[ -f "$OUTFILE" ]]; then
  log "SKIP: backup already exists for today: $OUTFILE"
  exit 0
fi

mkdir -p "$DEST"

# ── Dump ─────────────────────────────────────────────────────────────────────
log "Running pg-dump-neon.sh → $TMPFILE"
if ! bash "${SCRIPTS_DIR}/pg-dump-neon.sh" "$TMPFILE" "$ENV_FILE"; then
  log "FATAL: pg-dump-neon.sh failed — backup aborted"
  rm -rf "$DEST"
  exit 1
fi

SQL_BYTES="$(wc -c < "$TMPFILE" | tr -d ' ')"
log "SQL dump size: ${SQL_BYTES} bytes"

# ── Compress ─────────────────────────────────────────────────────────────────
log "Compressing → $OUTFILE"
gzip -9 "$TMPFILE"   # replaces $TMPFILE with $TMPFILE.gz = $OUTFILE

GZ_BYTES="$(wc -c < "$OUTFILE" | tr -d ' ')"
log "Compressed size: ${GZ_BYTES} bytes (ratio: $(echo "scale=1; ${SQL_BYTES} / ${GZ_BYTES}" | bc)x)"

# ── Manifest ─────────────────────────────────────────────────────────────────
cat > "${DEST}/manifest.json" <<JSON
{
  "date": "${DATESTAMP}",
  "timestamp_ist": "${TIMESTAMP}",
  "sql_bytes_uncompressed": ${SQL_BYTES},
  "gz_bytes": ${GZ_BYTES},
  "retention_days": ${RETENTION_DAYS},
  "file": "db-snapshot.sql.gz"
}
JSON

log "Manifest written: ${DEST}/manifest.json"

# ── Verify compressed file is readable ───────────────────────────────────────
if ! gzip -t "$OUTFILE"; then
  log "FATAL: compressed backup failed integrity check"
  rm -rf "$DEST"
  exit 1
fi
log "Integrity check: PASSED (gzip -t)"

# ── Prune backups older than RETENTION_DAYS ───────────────────────────────────
log "Pruning backups older than ${RETENTION_DAYS} days from ${BACKUP_ROOT}"
PRUNED=0
while IFS= read -r -d '' dir; do
  log "  Deleting: $dir"
  rm -rf "$dir"
  PRUNED=$((PRUNED + 1))
done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}" -print0 2>/dev/null)
log "Pruned ${PRUNED} expired backup(s)"

# ── Summary ──────────────────────────────────────────────────────────────────
TOTAL="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
log "SUCCESS — ${OUTFILE} | uncompressed=${SQL_BYTES}B compressed=${GZ_BYTES}B | total_retained=${TOTAL}"
log "---- END backup ${TIMESTAMP} ----"
