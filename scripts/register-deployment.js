#!/usr/bin/env node
/**
 * Deployment lifecycle manager for deployment_versions table.
 *
 * Actions:
 *   register-pending  — insert PENDING record immediately after health passes
 *   update-status     — PATCH to RELEASED or FAILED; verifies response fields
 *   register          — (legacy/direct) insert RELEASED record in one step
 *
 * Called by deploy.sh ON VPS via SSH.
 * Reads JWT_SECRET from .env to derive the deploy secret (zero-config).
 *
 * Usage:
 *   node register-deployment.js --action register-pending \
 *     --env-file /root/Saachu-app/.env \
 *     --version v2026.06.12 --deployed-at "2026-06-12 10:30 IST" \
 *     --backend-commit abc1234 --frontend-commit def5678 \
 *     --bundle-hash 1a2b3c4d --backup-snapshot pre-v2026.06.12 \
 *     --backup-root /root/backups --rollback-code v2026.06.12 \
 *     --notes "Release notes" --created-by "deploy.sh"
 *
 *   node register-deployment.js --action update-status \
 *     --env-file /root/Saachu-app/.env \
 *     --version v2026.06.12 --status RELEASED --rollback-available true
 *
 * Exit codes: 0 = success/idempotent, 1 = fatal error
 */
'use strict';

const { createHash } = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length - 1; i += 2) {
    const key = args[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = args[i + 1];
  }
  return out;
}

// ── .env file reader ──────────────────────────────────────────────────────────

function readEnvFile(filePath) {
  const env = {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[m[1]] = val;
    }
  } catch {
    // .env not readable — caller handles empty object
  }
  return env;
}

// ── Secret derivation (must match DeploymentVersionsController) ───────────────

function resolveDeploySecret(env) {
  if (env.DEPLOY_REGISTRATION_SECRET) return env.DEPLOY_REGISTRATION_SECRET;
  if (process.env.DEPLOY_REGISTRATION_SECRET) return process.env.DEPLOY_REGISTRATION_SECRET;
  const jwtSecret = env.JWT_SECRET || process.env.JWT_SECRET || '';
  if (!jwtSecret) return '';
  return createHash('sha256')
    .update(jwtSecret + ':deploy-registration')
    .digest('hex')
    .substring(0, 32);
}

// ── Integrity hash (must match DeploymentVersionsService.computeHash) ─────────

function computeIntegrityHash(dto) {
  const payload = [
    dto.version           || '',
    dto.backend_commit    || '',
    dto.frontend_commit   || '',
    dto.bundle_hash       || '',
    dto.backup_snapshot   || '',
    dto.rollback_code     || '',
    (dto.migration_ids    || []).slice().sort().join(','),
    dto.deployment_status || '',
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpRequest(method, url, data, secret) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || 80,
      path:     parsed.pathname,
      method,
      headers: {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(body),
        'X-Deploy-Secret': secret,
      },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

// ── Backup manifest builder (runs ON VPS — direct filesystem access) ──────────

function buildBackupManifest(backupRoot, snapshot) {
  if (!backupRoot || !snapshot) return null;
  const snapshotDir = path.join(backupRoot, snapshot);
  const result = {
    snapshot_dir:          snapshotDir,
    checked_at:            new Date().toISOString(),
    manifest_exists:       false,
    db_snapshot_exists:    false,
    backend_dist_exists:   false,
    frontend_build_exists: false,
    ecosystem_exists:      false,
    all_artifacts_present: false,
  };
  try {
    result.manifest_exists       = fs.existsSync(path.join(snapshotDir, 'manifest.json'));
    result.db_snapshot_exists    = fs.existsSync(path.join(snapshotDir, 'db-snapshot.sql'));
    result.backend_dist_exists   = fs.existsSync(path.join(snapshotDir, 'backend-dist.tar.gz'));
    result.frontend_build_exists = fs.existsSync(path.join(snapshotDir, 'frontend-build.tar.gz'));
    result.ecosystem_exists      = fs.existsSync(path.join(snapshotDir, 'ecosystem.config.js'));
    result.all_artifacts_present = (
      result.manifest_exists &&
      result.db_snapshot_exists &&
      result.backend_dist_exists &&
      result.frontend_build_exists &&
      result.ecosystem_exists
    );
    if (result.manifest_exists) {
      try {
        result.manifest_content = JSON.parse(
          fs.readFileSync(path.join(snapshotDir, 'manifest.json'), 'utf8'),
        );
      } catch {}
    }
  } catch {
    // Non-fatal — manifest is incomplete but registration still proceeds
  }
  return result;
}

// ── Action: register (PENDING or RELEASED) ────────────────────────────────────

async function actionRegister(args, secret, pending) {
  const version = args.version;
  if (!version) { console.error('FATAL: --version is required'); process.exit(1); }

  const migrationIds = args.migrationIds
    ? args.migrationIds.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const status = pending ? 'PENDING' : 'RELEASED';
  const _parsedAt = new Date(args.deployedAt);
  const deployedAt = args.deployedAt && !Number.isNaN(_parsedAt.getTime())
    ? _parsedAt.toISOString()
    : new Date().toISOString();
  const dto = {
    version,
    deployed_at:        deployedAt,
    backend_commit:     args.backendCommit  || null,
    frontend_commit:    args.frontendCommit || null,
    bundle_hash:        args.bundleHash     || null,
    backup_snapshot:    args.backupSnapshot || null,
    rollback_code:      args.rollbackCode   || version,
    migration_ids:      migrationIds,
    deployment_status:  status,
    created_by:         args.createdBy      || 'deploy.sh',
    notes:              args.notes          || null,
    rollback_available: args.rollbackAvailable === 'true',
    backup_manifest:    buildBackupManifest(
      args.backupRoot || '/root/backups',
      args.backupSnapshot || null,
    ),
  };

  const hash = computeIntegrityHash(dto);
  console.log(`[register-deployment] Integrity hash (${status}): ${hash.substring(0, 16)}...`);

  const apiUrl = 'http://127.0.0.1:4000/deployment-versions/register';
  try {
    const result = await httpRequest('POST', apiUrl, dto, secret);
    console.log(`✓ Deployment registered as ${status}: ${version} (id: ${result.id})`);
    console.log(`  rollback_available: ${result.rollback_available}`);
    console.log(`  integrity_hash:     ${(result.integrity_hash || '').substring(0, 16)}...`);
  } catch (err) {
    if (err.message && err.message.includes('HTTP 409')) {
      console.warn(`[register-deployment] Version ${version} already registered — skipping (idempotent)`);
      process.exit(0);
    }
    console.error(`FATAL: Deployment registration failed: ${err.message}`);
    process.exit(1);
  }
}

// ── Action: update-status (PENDING → RELEASED | FAILED) ──────────────────────

async function actionUpdateStatus(args, secret) {
  const version = args.version;
  if (!version) { console.error('FATAL: --version is required'); process.exit(1); }

  const status = args.status;
  if (!status) { console.error('FATAL: --status is required'); process.exit(1); }

  const body = { status };
  if (args.rollbackAvailable !== undefined) {
    body.rollback_available = args.rollbackAvailable === 'true';
  }

  const apiUrl = `http://127.0.0.1:4000/deployment-versions/${encodeURIComponent(version)}/status`;
  let result;
  try {
    result = await httpRequest('PATCH', apiUrl, body, secret);
  } catch (err) {
    console.error(`FATAL: Status update to ${status} failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`✓ Status updated: ${version} → ${result.deployment_status}`);

  // Phase 3: verify critical fields in RELEASED response
  if (status === 'RELEASED') {
    let failed = false;
    if (!result.integrity_hash) {
      console.error('Verification FAILED: integrity_hash missing from DB response');
      failed = true;
    }
    if (!result.deployed_at) {
      console.error('Verification FAILED: deployed_at missing from DB response');
      failed = true;
    }
    if (result.deployment_status !== 'RELEASED') {
      console.error(`Verification FAILED: deployment_status="${result.deployment_status}", expected "RELEASED"`);
      failed = true;
    }
    if (body.rollback_available === true && !result.rollback_available) {
      console.error('Verification FAILED: rollback_available is false in DB response');
      failed = true;
    }
    if (failed) {
      console.error('FATAL: Deployment record verification failed after RELEASED update');
      process.exit(1);
    }
    console.log(`✓ Deployment record verified:`);
    console.log(`  deployment_status:  ${result.deployment_status}`);
    console.log(`  integrity_hash:     ${result.integrity_hash.substring(0, 16)}...`);
    console.log(`  rollback_available: ${result.rollback_available}`);
    console.log(`  deployed_at:        ${result.deployed_at}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const action = args.action || 'register';

  const envFile = args.envFile || '/root/Saachu-app/.env';
  const env = readEnvFile(envFile);

  const secret = resolveDeploySecret(env);
  if (!secret) {
    console.error('FATAL: Cannot derive deploy secret — JWT_SECRET not in .env and DEPLOY_REGISTRATION_SECRET not set');
    process.exit(1);
  }

  switch (action) {
    case 'register':
      await actionRegister(args, secret, false);
      break;
    case 'register-pending':
      await actionRegister(args, secret, true);
      break;
    case 'update-status':
      await actionUpdateStatus(args, secret);
      break;
    default:
      console.error(`FATAL: Unknown action: "${action}". Valid: register, register-pending, update-status`);
      process.exit(1);
  }
}

main();
