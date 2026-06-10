#!/usr/bin/env bash
# Saachu atomic production deployment — fail-fast, no partial deploys.
#
# Flow: Build → Backup → Deploy → Health → Tag → VersionHistory → Success
# Tags and VersionHistory are written ONLY after health passes.
#
# Usage:
#   ./scripts/deploy.sh --version v2026.06.12 --notes "Release notes"
#   ./scripts/deploy.sh --validate-only          # build + preflight only
#   ./scripts/deploy-rehearsal.sh                # full rehearsal, no production deploy
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_ROOT="${FRONTEND_ROOT:-$(cd "${BACKEND_ROOT}/../frontend" 2>/dev/null && pwd || echo '')}"
VPS_HOST="${VPS_HOST:-root@158.220.110.75}"
VPS_BACKEND_PATH="${VPS_BACKEND_PATH:-/root/Saachu-app}"
VPS_FRONTEND_PATH="${VPS_FRONTEND_PATH:-/var/www/html}"
VPS_BACKUP_ROOT="${VPS_BACKUP_ROOT:-/root/backups}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/health/version}"
REHEARSAL="${REHEARSAL:-0}"
VALIDATE_ONLY="${VALIDATE_ONLY:-0}"
VERSION=""
DEPLOY_NOTES=""
DEPLOYED_AT="$(TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M IST')"
REHEARSE_ID="$(date +%Y%m%d-%H%M%S)"

log()  { echo "[deploy] $*"; }
fail() { echo "[deploy] FATAL: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  deploy.sh --version v2026.06.12 [--notes "description"] [--validate-only]
  deploy-rehearsal.sh   (sets REHEARSAL=1 — no production deploy, no tags, no VH update)

Atomic order: Build → Backup → Deploy → Health → Tag → VersionHistory → Success
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --notes)   DEPLOY_NOTES="$2"; shift 2 ;;
    --validate-only) VALIDATE_ONLY=1; shift ;;
    --rehearsal) REHEARSAL=1; shift ;;
    -h|--help) usage ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

if [[ "$REHEARSAL" == "1" ]]; then
  SNAPSHOT="rehearse-${REHEARSE_ID}"
  log "REHEARSAL mode — snapshot: ${SNAPSHOT} (not a production rollback point)"
elif [[ -n "$VERSION" ]]; then
  [[ "$VERSION" =~ ^v[0-9]{4}\.[0-9]{2}\.[0-9]+$ ]] || fail "Version must match vYYYY.MM.N (got: $VERSION)"
  SNAPSHOT="pre-${VERSION}"
else
  [[ "$VALIDATE_ONLY" == "1" ]] || fail "--version is required (e.g. v2026.06.12)"
  SNAPSHOT=""
fi

BACKEND_SHA=""
FRONTEND_SHA=""
BUNDLE_HASH=""

# ── 1. Pre-flight ─────────────────────────────────────────────────────────────
log "Step 1/8 — Pre-flight validation"

[[ -d "$BACKEND_ROOT" ]] || fail "Backend root not found: $BACKEND_ROOT"
[[ -d "$FRONTEND_ROOT" ]] || fail "Frontend root not found: $FRONTEND_ROOT (set FRONTEND_ROOT)"

if [[ "${SKIP_GIT_CLEAN:-0}" != "1" ]]; then
  if [[ -n "$(git -C "$BACKEND_ROOT" status --porcelain 2>/dev/null)" ]]; then
    fail "Backend git working tree not clean. Commit or set SKIP_GIT_CLEAN=1"
  fi
  if [[ -n "$(git -C "$FRONTEND_ROOT" status --porcelain 2>/dev/null)" ]]; then
    fail "Frontend git working tree not clean. Commit or set SKIP_GIT_CLEAN=1"
  fi
fi

command -v npm >/dev/null 2>&1 || fail "npm not found"
command -v rsync >/dev/null 2>&1 || fail "rsync not found"
command -v node >/dev/null 2>&1 || fail "node not found"

if [[ "$VALIDATE_ONLY" != "1" ]]; then
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$VPS_HOST" "echo ok" >/dev/null 2>&1 \
    || fail "SSH to $VPS_HOST failed"
fi

# ── 2. Build ──────────────────────────────────────────────────────────────────
log "Step 2/8 — Build backend + frontend"

(cd "$BACKEND_ROOT" && npm run build) || fail "Backend build failed"
(cd "$FRONTEND_ROOT" && npm run build) || fail "Frontend build failed"

[[ -f "$BACKEND_ROOT/dist/main.js" ]] || fail "Backend dist/main.js missing after build"
MAIN_JS="$(ls "$FRONTEND_ROOT/build/static/js/main."*.js 2>/dev/null | head -1)"
[[ -n "$MAIN_JS" ]] || fail "Frontend main.*.js bundle missing after build"
BUNDLE_HASH="$(basename "$MAIN_JS" .js | sed 's/^main\.//')"

# ── 3. Capture SHAs + tag collision check ─────────────────────────────────────
log "Step 3/8 — Capture commit SHAs"

BACKEND_SHA="$(git -C "$BACKEND_ROOT" rev-parse --short HEAD)"
FRONTEND_SHA="$(git -C "$FRONTEND_ROOT" rev-parse --short HEAD)"
log "Backend SHA:  $BACKEND_SHA"
log "Frontend SHA: $FRONTEND_SHA"
log "Bundle hash:  $BUNDLE_HASH"

if [[ -n "$VERSION" && "$REHEARSAL" != "1" ]]; then
  if git -C "$BACKEND_ROOT" rev-parse "$VERSION" >/dev/null 2>&1; then
    fail "Backend git tag ${VERSION} already exists"
  fi
  if git -C "$FRONTEND_ROOT" rev-parse "$VERSION" >/dev/null 2>&1; then
    fail "Frontend git tag ${VERSION} already exists"
  fi
fi

if [[ "$VALIDATE_ONLY" == "1" ]]; then
  log "VALIDATE-ONLY complete — build and preflight passed"
  exit 0
fi

# ── 4. VPS backup ─────────────────────────────────────────────────────────────
log "Step 4/8 — Verify production database + create backup: ${SNAPSHOT}"

rsync -az "$SCRIPT_DIR/verify-production-db.sh" \
  "${VPS_HOST}:${VPS_BACKEND_PATH}/scripts/" 2>/dev/null \
  || ssh "$VPS_HOST" "mkdir -p ${VPS_BACKEND_PATH}/scripts"

ssh "$VPS_HOST" "bash ${VPS_BACKEND_PATH}/scripts/verify-production-db.sh ${VPS_BACKEND_PATH}/.env" \
  || fail "Production database verification failed — deploy aborted"

# Sync pg-dump helper to VPS
rsync -az "$SCRIPT_DIR/pg-dump-neon.sh" "$SCRIPT_DIR/install-pg17-client.sh" \
  "${VPS_HOST}:${VPS_BACKEND_PATH}/scripts/" 2>/dev/null \
  || ssh "$VPS_HOST" "mkdir -p ${VPS_BACKEND_PATH}/scripts" \
  && rsync -az "$SCRIPT_DIR/pg-dump-neon.sh" "$SCRIPT_DIR/install-pg17-client.sh" \
     "${VPS_HOST}:${VPS_BACKEND_PATH}/scripts/"

BACKUP_CMD=$(cat <<EOS
set -euo pipefail
DEST="${VPS_BACKUP_ROOT}/${SNAPSHOT}"
if [[ -d "\$DEST" ]]; then echo "Backup dir already exists: \$DEST"; exit 1; fi
mkdir -p "\$DEST"

# Ensure PG 17 client for Neon
if [[ ! -x /usr/lib/postgresql/17/bin/pg_dump ]]; then
  bash "${VPS_BACKEND_PATH}/scripts/install-pg17-client.sh"
fi

bash "${VPS_BACKEND_PATH}/scripts/pg-dump-neon.sh" "\$DEST/db-snapshot.sql" "${VPS_BACKEND_PATH}/.env"

tar -czf "\$DEST/backend-dist.tar.gz" -C "${VPS_BACKEND_PATH}" dist ecosystem.config.js 2>/dev/null \
  || tar -czf "\$DEST/backend-dist.tar.gz" -C "${VPS_BACKEND_PATH}" dist
cp "${VPS_BACKEND_PATH}/ecosystem.config.js" "\$DEST/ecosystem.config.js"
tar -czf "\$DEST/frontend-build.tar.gz" -C "${VPS_FRONTEND_PATH}" .

BE_SHA="\$(cd ${VPS_BACKEND_PATH} && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "\$DEST/manifest.json" <<MANIFEST
{
  "snapshot": "${SNAPSHOT}",
  "rehearsal": ${REHEARSAL},
  "deployed_at": "${DEPLOYED_AT}",
  "backend_commit_pre": "\$BE_SHA",
  "backend_commit_built": "${BACKEND_SHA}",
  "frontend_commit_built": "${FRONTEND_SHA}",
  "frontend_bundle_hash": "${BUNDLE_HASH}",
  "notes": "${DEPLOY_NOTES}"
}
MANIFEST

for f in manifest.json db-snapshot.sql backend-dist.tar.gz frontend-build.tar.gz ecosystem.config.js; do
  [[ -f "\$DEST/\$f" ]] || { echo "Missing backup artifact: \$f"; exit 1; }
done
BYTES=\$(wc -c < "\$DEST/db-snapshot.sql" | tr -d ' ')
[[ "\$BYTES" -gt 1000 ]] || { echo "db-snapshot.sql too small: \$BYTES bytes"; exit 1; }
bash "${VPS_BACKEND_PATH}/scripts/capture-backup-counts.sh" "\$DEST" "${VPS_BACKEND_PATH}/.env" 2>/dev/null \
  || psql "\$(grep -m1 '^DATABASE_URL=' ${VPS_BACKEND_PATH}/.env | cut -d= -f2- | tr -d \"\")" -t -A -c "
    SELECT json_build_object(
      'customer', (SELECT COUNT(*)::int FROM customer),
      'marketing_audience', (SELECT COUNT(*)::int FROM marketing_audience),
      'campaigns', (SELECT COUNT(*)::int FROM marketing_campaigns),
      'queue', (SELECT COUNT(*)::int FROM whatsapp_message_queue),
      'logs', (SELECT COUNT(*)::int FROM whatsapp_message_logs)
    );" > "\$DEST/counts-at-backup.json"
echo "Backup OK — db-snapshot.sql \${BYTES} bytes"
EOS
)

ssh "$VPS_HOST" "$BACKUP_CMD" || fail "VPS backup failed — deployment aborted"

# ── 5. Deploy (skipped in rehearsal) ────────────────────────────────────────
if [[ "$REHEARSAL" == "1" ]]; then
  log "Step 5/8 — Deploy SKIPPED (rehearsal mode)"
else
  log "Step 5/8 — Deploy to VPS"

  ECO_FILE="$BACKEND_ROOT/ecosystem.config.js"
  cp "$ECO_FILE" "${ECO_FILE}.pre-deploy.bak"
  sed -i.bak "s/APP_VERSION: '[^']*'/APP_VERSION: '${VERSION}'/" "$ECO_FILE"
  sed -i.bak "s/DEPLOYED_AT: '[^']*'/DEPLOYED_AT: '${DEPLOYED_AT}'/" "$ECO_FILE"
  rm -f "${ECO_FILE}.bak"

  rsync -avz --delete "$BACKEND_ROOT/dist/" "${VPS_HOST}:${VPS_BACKEND_PATH}/dist/" \
    || { mv "${ECO_FILE}.pre-deploy.bak" "$ECO_FILE"; fail "Backend dist rsync failed"; }
  rsync -avz "$BACKEND_ROOT/ecosystem.config.js" "${VPS_HOST}:${VPS_BACKEND_PATH}/" \
    || { mv "${ECO_FILE}.pre-deploy.bak" "$ECO_FILE"; fail "ecosystem.config.js rsync failed"; }
  rsync -avz --delete "$FRONTEND_ROOT/build/" "${VPS_HOST}:${VPS_FRONTEND_PATH}/" \
    || { mv "${ECO_FILE}.pre-deploy.bak" "$ECO_FILE"; fail "Frontend rsync failed"; }

  ssh "$VPS_HOST" "source ~/.nvm/nvm.sh 2>/dev/null; cd ${VPS_BACKEND_PATH} && pm2 reload ecosystem.config.js --env production" \
    || { mv "${ECO_FILE}.pre-deploy.bak" "$ECO_FILE"; fail "pm2 reload failed"; }

  rm -f "${ECO_FILE}.pre-deploy.bak"
fi

# ── 6. Health verification ────────────────────────────────────────────────────
log "Step 6/8 — Health verification"

if [[ "$REHEARSAL" == "1" ]]; then
  HEALTH="$(ssh "$VPS_HOST" "curl -sf ${HEALTH_URL}" 2>/dev/null)" \
    || fail "Health endpoint unreachable (rehearsal)"
  echo "$HEALTH" | grep -q '"backend_version"' \
    || fail "Health response missing backend_version: $HEALTH"
  log "Rehearsal health OK (current production): $HEALTH"
else
  sleep 8
  HEALTH="$(ssh "$VPS_HOST" "curl -sf ${HEALTH_URL}" 2>/dev/null)" \
    || fail "Health endpoint unreachable"
  echo "$HEALTH" | grep -q "\"backend_version\":\"${VERSION}\"" \
    || fail "Health version mismatch — expected ${VERSION}, got: $HEALTH"
  log "Health OK: $HEALTH"
fi

# ── 7. Git tags (only after health passes; skipped in rehearsal) ──────────────
if [[ "$REHEARSAL" == "1" ]]; then
  log "Step 7/8 — Git tags SKIPPED (rehearsal mode)"
else
  log "Step 7/8 — Create git tags (post-health)"

  git -C "$BACKEND_ROOT" tag -a "$VERSION" -m "Deploy ${VERSION} | ${DEPLOYED_AT} | ${DEPLOY_NOTES:-release}"
  git -C "$FRONTEND_ROOT" tag -a "$VERSION" -m "Deploy ${VERSION} | ${DEPLOYED_AT}"
  log "Tags created: ${VERSION}"
fi

# ── 8. VersionHistory update (only after tags; skipped in rehearsal) ──────────
if [[ "$REHEARSAL" == "1" ]]; then
  log "Step 8/8 — VersionHistory SKIPPED (rehearsal mode)"
else
  log "Step 8/8 — Update VersionHistory.js"

  VH_FILE="$FRONTEND_ROOT/src/pages/settings/VersionHistory.js"
  PAYLOAD="$(mktemp)"
  STATUS_NOTES="${DEPLOY_NOTES:-Release ${VERSION}}"
  trap 'rm -f "$PAYLOAD"' EXIT
  cat > "$PAYLOAD" <<JSON
{
  "version": "${VERSION}",
  "dateTime": "${DEPLOYED_AT}",
  "backendCommit": "${BACKEND_SHA}",
  "frontendCommit": "${FRONTEND_SHA}",
  "frontendBundleHash": "${BUNDLE_HASH}",
  "dbMigrations": [],
  "backupSnapshot": "${SNAPSHOT}",
  "statusNotes": "${STATUS_NOTES}"
}
JSON
  node "$SCRIPT_DIR/update-version-history.js" "$VH_FILE" "$PAYLOAD" \
    || fail "VersionHistory update failed"
fi

if [[ "$REHEARSAL" == "1" ]]; then
  log "REHEARSAL SUCCESS — backup=${SNAPSHOT} build=${BUNDLE_HASH} health=OK (no deploy, no tags, no VH)"
else
  log "SUCCESS — ${VERSION} deployed atomically"
  log "Rollback snapshot: ${VPS_BACKUP_ROOT}/${SNAPSHOT}"
fi
