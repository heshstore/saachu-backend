#!/usr/bin/env bash
# Deployment rehearsal — validates build + backup + health logic without production deploy.
# No version bump. No VersionHistory update. No git tags. No rsync/pm2 reload.
#
# Usage: ./scripts/deploy-rehearsal.sh
#        SKIP_GIT_CLEAN=1 ./scripts/deploy-rehearsal.sh   # when working tree dirty during dev
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export REHEARSAL=1
export SKIP_GIT_CLEAN="${SKIP_GIT_CLEAN:-1}"

exec "$SCRIPT_DIR/deploy.sh" --rehearsal "$@"
