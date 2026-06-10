#!/usr/bin/env bash
# Restore Saachu production from a deploy backup snapshot.
#
# Backup layout (created by deploy.sh):
#   /root/backups/pre-{VERSION}/
#     manifest.json
#     db-snapshot.sql
#     backend-dist.tar.gz
#     frontend-build.tar.gz
#     ecosystem.config.js
#
# Usage:
#   ./scripts/restore.sh --from /root/backups/pre-v2026.06.11 --confirm
#   ./scripts/restore.sh --from /root/backups/rehearse-xxx --test
#   ./scripts/restore.sh --from /root/backups/pre-v2026.06.11 --validate
#
# Modes:
#   --validate   Verify artifacts only (no writes)
#   --test       Restore code to temp dirs; DB restore only if RESTORE_TEST_DATABASE_URL set
#   --confirm    Required for production paths (/root/Saachu-app, /var/www/html, live DATABASE_URL)
#
# Components (default: all):
#   --component all|db|backend|frontend|ecosystem
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR=""
COMPONENT="all"
MODE="restore"
CONFIRM=0

VPS_BACKEND_PATH="${VPS_BACKEND_PATH:-/root/Saachu-app}"
VPS_FRONTEND_PATH="${VPS_FRONTEND_PATH:-/var/www/html}"
RESTORE_TEST_ROOT="${RESTORE_TEST_ROOT:-/tmp/saachu-restore-test}"

log()  { echo "[restore] $*"; }
fail() { echo "[restore] FATAL: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  restore.sh --from /root/backups/pre-vVERSION [--component all|db|backend|frontend|ecosystem]
             [--validate | --test | --confirm]

  --validate  Check backup artifacts and optionally extract code to temp (no production writes)
  --test      Restore to temp paths; DB only with RESTORE_TEST_DATABASE_URL
  --confirm   Required to restore to production paths

Environment:
  RESTORE_TEST_DATABASE_URL  Optional Neon branch / local DB for safe DB round-trip test
  VPS_BACKEND_PATH           Default /root/Saachu-app
  VPS_FRONTEND_PATH          Default /var/www/html
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) BACKUP_DIR="$2"; shift 2 ;;
    --component) COMPONENT="$2"; shift 2 ;;
    --validate) MODE="validate"; shift ;;
    --test) MODE="test"; shift ;;
    --confirm) CONFIRM=1; shift ;;
    -h|--help) usage ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -n "$BACKUP_DIR" ]] || fail "--from BACKUP_DIR is required"
[[ -d "$BACKUP_DIR" ]] || fail "Backup directory not found: $BACKUP_DIR"

ARTIFACTS=(manifest.json db-snapshot.sql backend-dist.tar.gz frontend-build.tar.gz ecosystem.config.js)
for f in "${ARTIFACTS[@]}"; do
  [[ -f "$BACKUP_DIR/$f" ]] || fail "Missing artifact: $BACKUP_DIR/$f"
done

BYTES="$(wc -c < "$BACKUP_DIR/db-snapshot.sql" | tr -d ' ')"
[[ "$BYTES" -gt 1000 ]] || fail "db-snapshot.sql too small: ${BYTES} bytes"

log "Backup validated — $BACKUP_DIR (${BYTES} bytes SQL)"

want_db()       { [[ "$COMPONENT" == "all" || "$COMPONENT" == "db" ]]; }
want_backend()  { [[ "$COMPONENT" == "all" || "$COMPONENT" == "backend" ]]; }
want_frontend() { [[ "$COMPONENT" == "all" || "$COMPONENT" == "frontend" ]]; }
want_eco()      { [[ "$COMPONENT" == "all" || "$COMPONENT" == "ecosystem" ]]; }

# ── Count helper (live or test DB) ───────────────────────────────────────────
count_tables() {
  local url="$1"
  psql "$url" -t -A -c "
    SELECT json_build_object(
      'customer',           (SELECT COUNT(*)::int FROM customer),
      'marketing_audience', (SELECT COUNT(*)::int FROM marketing_audience),
      'campaigns',          (SELECT COUNT(*)::int FROM marketing_campaigns),
      'queue',              (SELECT COUNT(*)::int FROM whatsapp_message_queue),
      'logs',               (SELECT COUNT(*)::int FROM whatsapp_message_logs)
    );
  " 2>/dev/null || echo '{}'
}

# ── Validate mode ─────────────────────────────────────────────────────────────
if [[ "$MODE" == "validate" ]]; then
  log "VALIDATE — artifacts OK"
  if command -v tar >/dev/null 2>&1; then
    tar -tzf "$BACKUP_DIR/backend-dist.tar.gz"  | head -3 | sed 's/^/[restore] backend: /'
    tar -tzf "$BACKUP_DIR/frontend-build.tar.gz" | head -3 | sed 's/^/[restore] frontend: /'
  fi
  if [[ -f "${VPS_BACKEND_PATH}/.env" ]]; then
    DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "${VPS_BACKEND_PATH}/.env" | cut -d= -f2- | tr -d '"')"
    if [[ -n "$DATABASE_URL" ]]; then
      COUNTS="$(count_tables "$DATABASE_URL")"
      log "Live counts: $COUNTS"
    fi
  fi
  log "VALIDATE PASSED"
  exit 0
fi

# ── Resolve target paths ──────────────────────────────────────────────────────
if [[ "$MODE" == "test" ]]; then
  TEST_DIR="${RESTORE_TEST_ROOT}/$(basename "$BACKUP_DIR")-$(date +%Y%m%d-%H%M%S)"
  BACKEND_TARGET="${TEST_DIR}/backend"
  FRONTEND_TARGET="${TEST_DIR}/frontend"
  ECO_TARGET="${TEST_DIR}/ecosystem.config.js"
  mkdir -p "$BACKEND_TARGET" "$FRONTEND_TARGET"
  log "TEST mode — targets under $TEST_DIR"
else
  [[ "$CONFIRM" == "1" ]] || fail "Production restore requires --confirm"
  BACKEND_TARGET="${VPS_BACKEND_PATH}"
  FRONTEND_TARGET="${VPS_FRONTEND_PATH}"
  ECO_TARGET="${VPS_BACKEND_PATH}/ecosystem.config.js"
  log "PRODUCTION restore — BACKEND=$BACKEND_TARGET FRONTEND=$FRONTEND_TARGET"
fi

# ── Backend restore ───────────────────────────────────────────────────────────
if want_backend; then
  log "Restoring backend dist → $BACKEND_TARGET"
  if [[ "$MODE" == "test" ]]; then
    tar -xzf "$BACKUP_DIR/backend-dist.tar.gz" -C "$BACKEND_TARGET"
    [[ -f "$BACKEND_TARGET/dist/main.js" || -f "$BACKEND_TARGET/main.js" ]] \
      || fail "Backend extract failed — main.js not found"
  else
    [[ -d "$BACKEND_TARGET/dist" ]] && cp -a "$BACKEND_TARGET/dist" "$BACKEND_TARGET/dist.pre-restore.$(date +%Y%m%d-%H%M%S).bak" || true
    tar -xzf "$BACKUP_DIR/backend-dist.tar.gz" -C "$BACKEND_TARGET"
    log "Backend dist restored"
  fi
fi

# ── Frontend restore ──────────────────────────────────────────────────────────
if want_frontend; then
  log "Restoring frontend build → $FRONTEND_TARGET"
  if [[ "$MODE" == "test" ]]; then
    tar -xzf "$BACKUP_DIR/frontend-build.tar.gz" -C "$FRONTEND_TARGET"
    [[ -f "$FRONTEND_TARGET/index.html" ]] || fail "Frontend extract failed — index.html not found"
  else
    rsync -a --delete "$FRONTEND_TARGET/" "$FRONTEND_TARGET.pre-restore.$(date +%Y%m%d-%H%M%S)/" 2>/dev/null \
      || cp -a "$FRONTEND_TARGET" "$FRONTEND_TARGET.pre-restore.$(date +%Y%m%d-%H%M%S)" || true
    tar -xzf "$BACKUP_DIR/frontend-build.tar.gz" -C "$FRONTEND_TARGET"
    log "Frontend restored"
  fi
fi

# ── Ecosystem config restore ──────────────────────────────────────────────────
if want_eco; then
  log "Restoring ecosystem.config.js → $ECO_TARGET"
  cp "$BACKUP_DIR/ecosystem.config.js" "$ECO_TARGET"
fi

# ── Database restore ──────────────────────────────────────────────────────────
if want_db; then
  if [[ "$MODE" == "test" ]]; then
    if [[ -z "${RESTORE_TEST_DATABASE_URL:-}" ]]; then
      log "TEST — DB restore SKIPPED (set RESTORE_TEST_DATABASE_URL for round-trip test)"
      log "DB file verified: ${BYTES} bytes"
    else
      log "TEST — restoring DB to RESTORE_TEST_DATABASE_URL"
      BEFORE="$(count_tables "$RESTORE_TEST_DATABASE_URL")"
      log "Counts before restore: $BEFORE"

      if [[ -f "${BACKUP_DIR}/counts-at-backup.json" ]]; then
        log "Expected counts (at backup): $(cat "${BACKUP_DIR}/counts-at-backup.json")"
      elif [[ -f "${VPS_BACKEND_PATH}/.env" ]]; then
        PROD_URL="$(grep -m1 '^DATABASE_URL=' "${VPS_BACKEND_PATH}/.env" | cut -d= -f2- | tr -d '"')"
        if [[ -n "$PROD_URL" ]]; then
          log "Expected counts (live production reference): $(count_tables "$PROD_URL")"
        fi
      fi

      psql "$RESTORE_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$BACKUP_DIR/db-snapshot.sql"
      AFTER="$(count_tables "$RESTORE_TEST_DATABASE_URL")"
      log "Counts after restore: $AFTER"

      if [[ -f "${BACKUP_DIR}/counts-at-backup.json" ]]; then
        if node -e "
          const exp = JSON.parse(require('fs').readFileSync('${BACKUP_DIR}/counts-at-backup.json','utf8'));
          const got = JSON.parse(process.argv[1]);
          const keys = ['customer','marketing_audience','campaigns','queue','logs'];
          for (const k of keys) {
            if (Number(exp[k]) !== Number(got[k])) {
              console.error('MISMATCH ' + k + ': expected ' + exp[k] + ' got ' + got[k]);
              process.exit(1);
            }
          }
          console.log('COUNT_VERIFY_OK');
        " "$AFTER"; then
          log "DB count verification PASSED"
        else
          fail "DB count verification FAILED after restore"
        fi
      fi
    fi
  else
    ENV_FILE="${VPS_BACKEND_PATH}/.env"
    [[ -f "$ENV_FILE" ]] || fail ".env not found at $ENV_FILE"
    DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
    [[ -n "$DATABASE_URL" ]] || fail "DATABASE_URL missing in $ENV_FILE"

    log "WARNING — restoring database will OVERWRITE production data"
    BEFORE="$(count_tables "$DATABASE_URL")"
    log "Counts before restore: $BEFORE"

    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$BACKUP_DIR/db-snapshot.sql"

    AFTER="$(count_tables "$DATABASE_URL")"
    log "Counts after restore: $AFTER"
  fi
fi

# ── Test verification ─────────────────────────────────────────────────────────
if [[ "$MODE" == "test" ]]; then
  log "TEST artifact checks:"
  want_backend  && ls -la "$BACKEND_TARGET/dist/main.js" 2>/dev/null || ls -la "$BACKEND_TARGET/main.js" 2>/dev/null || true
  want_frontend && ls -la "$FRONTEND_TARGET/index.html" 2>/dev/null || true
  want_eco      && ls -la "$ECO_TARGET" 2>/dev/null || true

  if [[ -f "${VPS_BACKEND_PATH}/.env" && -z "${RESTORE_TEST_DATABASE_URL:-}" ]]; then
    LIVE="$(count_tables "$(grep -m1 '^DATABASE_URL=' "${VPS_BACKEND_PATH}/.env" | cut -d= -f2- | tr -d '"')")"
    log "Live DB counts (reference): $LIVE"
    log "DB round-trip not executed — code restore test only"
  fi
  log "RESTORE TEST PASSED — artifacts extracted to $TEST_DIR"
  exit 0
fi

# ── Production post-restore ───────────────────────────────────────────────────
if [[ "$MODE" == "restore" ]]; then
  log "Reloading pm2..."
  if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.nvm/nvm.sh"
  fi
  cd "$VPS_BACKEND_PATH" && pm2 reload ecosystem.config.js --env production \
    || fail "pm2 reload failed after restore"
  log "RESTORE COMPLETE — verify /health/version"
fi
