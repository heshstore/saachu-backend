#!/usr/bin/env bash
# Saachu atomic production deployment — fail-fast, no partial deploys.
#
# Flow: Build → Backup → Deploy → Health → Tag → Register → VersionHistory → Success
# Tags, DB registration, and VersionHistory are written ONLY after health passes.
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
# CRA loads .env.local for EVERY build (dev and prod) if it's present on the
# machine running the build, and it takes precedence over .env.production.
# frontend/.env.local is a gitignored local-dev convenience file that points
# at http://localhost:4000 — force the real production API URL as an actual
# shell env var here, since CRA's dotenv loader never overrides a variable
# that's already set in the process environment. This makes the build
# correct regardless of what .env.local happens to contain on any machine.
PROD_FRONTEND_API_URL="${PROD_FRONTEND_API_URL:-https://crmhesh.duckdns.org}"
REHEARSAL="${REHEARSAL:-0}"
VALIDATE_ONLY="${VALIDATE_ONLY:-0}"
VERSION=""
DEPLOY_NOTES=""
DEPLOYED_AT="$(TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M IST')"
REHEARSE_ID="$(date +%Y%m%d-%H%M%S)"

# Phase 1: health check tuning
# 120s was too tight for `pm2 reload`'s graceful drain-then-start — a real,
# healthy v2026.07.15 deploy was marked FAILED (no tags/DB registration) for
# starting ~130s in. Widened with headroom.
HEALTH_MAX_WAIT=240   # seconds
HEALTH_POLL=10        # seconds between retries

log()  { echo "[deploy] $*"; }
fail() { echo "[deploy] FATAL: $*" >&2; exit 1; }

MIGRATIONS=""

usage() {
  cat <<'EOF'
Usage:
  deploy.sh --version v2026.06.12 [--notes "description"] [--migrations "migrate:foo,migrate:bar"] [--validate-only]
  deploy-rehearsal.sh   (sets REHEARSAL=1 — no production deploy, no tags, no DB registration)

--migrations records which DB migration scripts (run separately, before
this deploy) accompany this release, so the deployment_versions record
and any future rollback know what schema state goes with this version.

Atomic order: Build → Backup → Deploy → Health → Tag+Push → Register → Success
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)    VERSION="$2"; shift 2 ;;
    --notes)      DEPLOY_NOTES="$2"; shift 2 ;;
    --migrations) MIGRATIONS="$2"; shift 2 ;;
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
(cd "$FRONTEND_ROOT" && REACT_APP_API_URL="$PROD_FRONTEND_API_URL" npm run build) \
  || fail "Frontend build failed"

[[ -f "$BACKEND_ROOT/dist/main.js" ]] || fail "Backend dist/main.js missing after build"
MAIN_JS="$(ls "$FRONTEND_ROOT/build/static/js/main."*.js 2>/dev/null | head -1)"
[[ -n "$MAIN_JS" ]] || fail "Frontend main.*.js bundle missing after build"
BUNDLE_HASH="$(basename "$MAIN_JS" .js | sed 's/^main\.//')"

# Guard: a localhost API URL baked into the production bundle means .env.local
# (or similar) leaked into this build — this exact bug shipped v2026.07.12-14.
if grep -q "localhost:4000\|127\.0\.0\.1:4000" "$MAIN_JS"; then
  fail "Frontend bundle contains a localhost API URL — build environment is contaminated (check .env.local)"
fi

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

# Phase 4: Re-verify all 5 backup artifacts exist before proceeding
BACKUP_VALIDATE_CMD=$(cat <<EOS
set -euo pipefail
DEST="${VPS_BACKUP_ROOT}/${SNAPSHOT}"
MISSING=()
for f in manifest.json db-snapshot.sql backend-dist.tar.gz frontend-build.tar.gz ecosystem.config.js; do
  [[ -f "\$DEST/\$f" ]] || MISSING+=("\$f")
done
if [[ \${#MISSING[@]} -gt 0 ]]; then
  echo "BACKUP VALIDATION FAILED — missing: \${MISSING[*]}"
  exit 1
fi
BYTES=\$(wc -c < "\$DEST/db-snapshot.sql" | tr -d ' ')
[[ "\$BYTES" -gt 1000 ]] || { echo "BACKUP VALIDATION FAILED — db-snapshot.sql too small: \$BYTES bytes"; exit 1; }
echo "BACKUP VALIDATED — all 5 artifacts present, db dump \${BYTES} bytes"
EOS
)
log "Phase 4: Validating all 5 backup artifacts..."
ssh "$VPS_HOST" "$BACKUP_VALIDATE_CMD" || fail "Backup artifact validation failed — cannot mark deployment successful"
BACKUP_VALIDATED=true

# ── 5. Deploy (skipped in rehearsal) ────────────────────────────────────────
if [[ "$REHEARSAL" == "1" ]]; then
  log "Step 5/8 — Deploy SKIPPED (rehearsal mode)"
else
  log "Step 5/8 — Deploy to VPS"

  ECO_FILE="$BACKEND_ROOT/ecosystem.config.js"
  cp "$ECO_FILE" "${ECO_FILE}.pre-deploy.bak"

  # Restore ecosystem.config.js if the script exits for ANY reason (including
  # health-check failure in Step 6) before we've confirmed the deploy is good.
  # Without this, a failed deploy leaves the local file stamped with the new
  # version but uncommitted — a dirty tree that blocks the next deploy's
  # pre-flight check (this exact bug bit the v2026.07.15 attempt).
  restore_eco_on_failure() {
    if [[ -f "${ECO_FILE}.pre-deploy.bak" ]]; then
      mv "${ECO_FILE}.pre-deploy.bak" "$ECO_FILE"
      log "Restored ecosystem.config.js (deploy did not complete successfully)"
    fi
  }
  trap restore_eco_on_failure EXIT

  sed -i.bak "s/APP_VERSION: '[^']*'/APP_VERSION: '${VERSION}'/" "$ECO_FILE"
  sed -i.bak "s/DEPLOYED_AT: '[^']*'/DEPLOYED_AT: '${DEPLOYED_AT}'/" "$ECO_FILE"
  rm -f "${ECO_FILE}.bak"

  rsync -avz --delete "$BACKEND_ROOT/dist/" "${VPS_HOST}:${VPS_BACKEND_PATH}/dist/" \
    || fail "Backend dist rsync failed"
  rsync -avz "$BACKEND_ROOT/ecosystem.config.js" "${VPS_HOST}:${VPS_BACKEND_PATH}/" \
    || fail "ecosystem.config.js rsync failed"
  rsync -avz --delete "$FRONTEND_ROOT/build/" "${VPS_HOST}:${VPS_FRONTEND_PATH}/" \
    || fail "Frontend rsync failed"

  # Sync register-deployment.js to VPS — required for deployment registration
  rsync -az "$SCRIPT_DIR/register-deployment.js" \
    "${VPS_HOST}:${VPS_BACKEND_PATH}/scripts/" \
    || fail "Could not sync register-deployment.js to VPS — deployment aborted"

  ssh "$VPS_HOST" "source ~/.nvm/nvm.sh 2>/dev/null; cd ${VPS_BACKEND_PATH} && pm2 reload ecosystem.config.js --env production" \
    || fail "pm2 reload failed"
fi

# ── 6. Health verification (Phase 1: retry loop, 120s timeout) ───────────────
log "Step 6/8 — Health verification (max ${HEALTH_MAX_WAIT}s, polling every ${HEALTH_POLL}s)"

if [[ "$REHEARSAL" == "1" ]]; then
  HEALTH="$(ssh "$VPS_HOST" "curl -sf ${HEALTH_URL}" 2>/dev/null)" \
    || fail "Health endpoint unreachable (rehearsal)"
  echo "$HEALTH" | grep -q '"backend_version"' \
    || fail "Health response missing backend_version: $HEALTH"
  log "Rehearsal health OK (current production): $HEALTH"
else
  HEALTH=""
  ELAPSED=0
  HEALTH_PASSED=false
  while [[ $ELAPSED -lt $HEALTH_MAX_WAIT ]]; do
    HEALTH="$(ssh "$VPS_HOST" "curl -sf --max-time 5 ${HEALTH_URL}" 2>/dev/null)" || true
    if echo "$HEALTH" | grep -q "\"backend_version\":\"${VERSION}\""; then
      HEALTH_PASSED=true
      break
    fi
    CURRENT_VER="$(echo "$HEALTH" | grep -o '"backend_version":"[^"]*"' | head -1 || echo '(no response)')"
    log "  Waiting... ${ELAPSED}s elapsed — got ${CURRENT_VER}, want \"backend_version\":\"${VERSION}\""
    sleep $HEALTH_POLL
    ELAPSED=$((ELAPSED + HEALTH_POLL))
  done

  if [[ "$HEALTH_PASSED" != "true" ]]; then
    fail "Health check failed after ${HEALTH_MAX_WAIT}s — backend did not report ${VERSION}. Last response: ${HEALTH}"
  fi
  log "Health OK after ${ELAPSED}s: $HEALTH"

  # Health confirmed — the version bump in ecosystem.config.js is now the
  # intended, permanent state. Disarm the restore-on-failure trap and drop
  # the backup; Step 7 will commit this file as-is.
  trap - EXIT
  rm -f "${ECO_FILE}.pre-deploy.bak"
fi

# ── 7. Git tags — create, push (hard-fail), verify on remote ─────────────────
if [[ "$REHEARSAL" == "1" ]]; then
  log "Step 7/8 — Git tags SKIPPED (rehearsal mode)"
  GIT_TAGGED=false
else
  log "Step 7/8 — Commit version bump, create, push, and verify git tags (post-health)"

  # ecosystem.config.js was stamped with APP_VERSION/DEPLOYED_AT in Step 5. Commit
  # it now so the tag below points at a commit that matches what's actually live,
  # and so the working tree is clean again for the next deploy's pre-flight check.
  if ! git -C "$BACKEND_ROOT" diff --quiet -- ecosystem.config.js; then
    git -C "$BACKEND_ROOT" add ecosystem.config.js
    git -C "$BACKEND_ROOT" commit -m "chore(deploy): bump to ${VERSION}" --quiet \
      || fail "Failed to commit ecosystem.config.js version bump"
    git -C "$BACKEND_ROOT" push origin HEAD \
      || fail "Failed to push version-bump commit"
    BACKEND_SHA="$(git -C "$BACKEND_ROOT" rev-parse --short HEAD)"
    log "Committed + pushed version bump: ${BACKEND_SHA}"
  fi

  git -C "$BACKEND_ROOT"  tag -a "$VERSION" -m "Deploy ${VERSION} | ${DEPLOYED_AT} | ${DEPLOY_NOTES:-release}" \
    || fail "Backend git tag creation failed"
  git -C "$FRONTEND_ROOT" tag -a "$VERSION" -m "Deploy ${VERSION} | ${DEPLOYED_AT}" \
    || fail "Frontend git tag creation failed"
  log "Tags created locally: ${VERSION}"

  # Phase 2: hard-fail push — rollback_available=true requires remote presence
  git -C "$BACKEND_ROOT"  push origin "$VERSION" \
    || fail "Backend git tag push failed — rollback_available cannot be confirmed"
  git -C "$FRONTEND_ROOT" push origin "$VERSION" \
    || fail "Frontend git tag push failed — rollback_available cannot be confirmed"
  log "Tags pushed to remote: ${VERSION}"

  # Phase 2: confirm tags landed on remote before setting GIT_TAGGED
  BACKEND_REMOTE_TAG="$(git -C "$BACKEND_ROOT"  ls-remote --tags origin "refs/tags/${VERSION}" 2>/dev/null || echo '')"
  FRONTEND_REMOTE_TAG="$(git -C "$FRONTEND_ROOT" ls-remote --tags origin "refs/tags/${VERSION}" 2>/dev/null || echo '')"
  [[ -n "$BACKEND_REMOTE_TAG"  ]] || fail "Backend tag ${VERSION} not confirmed on remote after push"
  [[ -n "$FRONTEND_REMOTE_TAG" ]] || fail "Frontend tag ${VERSION} not confirmed on remote after push"
  log "✓ Remote tags verified: ${VERSION}"

  GIT_TAGGED=true
fi

# ── 8. DB registration lifecycle: PENDING → RELEASED + verify ────────────────
#    Phase 4: every attempt is tracked; failure after PENDING → marks FAILED.
# ─────────────────────────────────────────────────────────────────────────────
trap_deploy_cleanup() {
  if [[ "${DEPLOYMENT_REGISTERED:-false}" == "true" && "${DEPLOYMENT_SUCCESS:-false}" == "false" ]]; then
    log "Deployment failed post-registration — marking FAILED in DB..."
    ssh "$VPS_HOST" \
      "source ~/.nvm/nvm.sh 2>/dev/null && node \"${VPS_BACKEND_PATH}/scripts/register-deployment.js\" --action update-status --env-file \"${VPS_BACKEND_PATH}/.env\" --version \"${VERSION}\" --status FAILED" \
      2>/dev/null || log "Warning: could not mark deployment as FAILED in DB"
  fi
}

if [[ "$REHEARSAL" == "1" ]]; then
  log "Step 8/8 — Registration SKIPPED (rehearsal mode)"
else
  log "Step 8/8 — Register deployment: PENDING → RELEASED + verify"

  DEPLOYMENT_REGISTERED=false
  DEPLOYMENT_SUCCESS=false
  trap trap_deploy_cleanup EXIT

  # Phase 1 + Phase 4: insert PENDING — hard fail; no silent loss
  PENDING_CMD=$(cat <<EOS
source ~/.nvm/nvm.sh 2>/dev/null
node "${VPS_BACKEND_PATH}/scripts/register-deployment.js" \
  --action register-pending \
  --env-file "${VPS_BACKEND_PATH}/.env" \
  --version "${VERSION}" \
  --deployed-at "${DEPLOYED_AT}" \
  --backend-commit "${BACKEND_SHA}" \
  --frontend-commit "${FRONTEND_SHA}" \
  --bundle-hash "${BUNDLE_HASH}" \
  --backup-snapshot "${SNAPSHOT}" \
  --backup-root "${VPS_BACKUP_ROOT}" \
  --rollback-code "${VERSION}" \
  --notes "${DEPLOY_NOTES:-Release ${VERSION}}" \
  --rollback-available "false" \
  --migration-ids "${MIGRATIONS}" \
  --created-by "deploy.sh"
EOS
)
  ssh "$VPS_HOST" "$PENDING_CMD" \
    || fail "Deployment registration (PENDING) failed — cannot continue without tracking record"
  DEPLOYMENT_REGISTERED=true
  log "✓ PENDING record created: ${VERSION}"

  # Phase 2: rollback_available only when remote tags AND backup both verified
  ROLLBACK_AVAILABLE="false"
  if [[ "${GIT_TAGGED:-false}" == "true" && "${BACKUP_VALIDATED:-false}" == "true" ]]; then
    ROLLBACK_AVAILABLE="true"
  fi

  # Phase 1 + Phase 3: update PENDING → RELEASED; register-deployment.js verifies response
  RELEASE_CMD=$(cat <<EOS
source ~/.nvm/nvm.sh 2>/dev/null
node "${VPS_BACKEND_PATH}/scripts/register-deployment.js" \
  --action update-status \
  --env-file "${VPS_BACKEND_PATH}/.env" \
  --version "${VERSION}" \
  --status RELEASED \
  --rollback-available "${ROLLBACK_AVAILABLE}"
EOS
)
  ssh "$VPS_HOST" "$RELEASE_CMD" \
    || fail "Deployment status update (PENDING → RELEASED) and verification failed"
  DEPLOYMENT_SUCCESS=true
  log "✓ Deployment RELEASED: ${VERSION} | rollback_available: ${ROLLBACK_AVAILABLE}"

  # Note: VersionHistory.js no longer holds a static VERSIONS array — the
  # Settings → Version History page reads from the deployment_versions API
  # (registered above), which is the sole source of truth.
fi

if [[ "$REHEARSAL" == "1" ]]; then
  log "REHEARSAL SUCCESS — backup=${SNAPSHOT} build=${BUNDLE_HASH} health=OK (no deploy, no tags, no registration)"
else
  log "SUCCESS — ${VERSION} deployed atomically"
  log "  Rollback snapshot: ${VPS_BACKUP_ROOT}/${SNAPSHOT}"
  log "  Git tag verified:  ${GIT_TAGGED}"
  log "  Rollback ready:    ${ROLLBACK_AVAILABLE}"
  log "  Migrations:        ${MIGRATIONS:-none recorded}"
fi
