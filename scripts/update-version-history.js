#!/usr/bin/env node
/**
 * Prepend a deployment entry to VersionHistory.js (called only after successful deploy).
 * Usage: node update-version-history.js <vh-file> <json-payload-file>
 */
const fs = require('fs');

const vhFile = process.argv[2];
const payloadFile = process.argv[3];
if (!vhFile || !payloadFile) {
  console.error('Usage: node update-version-history.js <VersionHistory.js> <payload.json>');
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
const required = ['version', 'dateTime', 'backendCommit', 'frontendCommit', 'frontendBundleHash', 'statusNotes'];
for (const k of required) {
  if (!payload[k]) {
    console.error(`Missing required field: ${k}`);
    process.exit(1);
  }
}

const src = fs.readFileSync(vhFile, 'utf8');
if (src.includes(`version:        '${payload.version}'`) || src.includes(`version: '${payload.version}'`)) {
  console.error(`Version ${payload.version} already in VersionHistory.js`);
  process.exit(1);
}

const migrations = Array.isArray(payload.dbMigrations) ? payload.dbMigrations : [];
const migLines = migrations.length
  ? `dbMigrations:   ${JSON.stringify(migrations)},`
  : `dbMigrations:   [],`;

const entry = `  {
    version:        '${payload.version}',
    dateTime:       '${payload.dateTime}',
    backendCommit:  '${payload.backendCommit}',
    frontendCommit: '${payload.frontendCommit}',
    frontendBundleHash: '${payload.frontendBundleHash}',
    ${migLines}
    backupSnapshot: '${payload.backupSnapshot || 'pre-' + payload.version}',
    recoverable:    true,
    recoveryNote:   '${(payload.recoveryNote || 'deploy.sh atomic deploy — git tag + VPS backup verified').replace(/'/g, "\\'")}',
    rollback: {
      codeTag:  '${payload.version}',
      dbBranch: '${payload.backupSnapshot || 'pre-' + payload.version}',
    },
    statusNotes: '${payload.statusNotes.replace(/'/g, "\\'")}',
  },`;

const updated = src.replace(
  /const VERSIONS = \[\n/,
  `const VERSIONS = [\n${entry}\n`,
);

if (updated === src) {
  console.error('Could not find VERSIONS array anchor in VersionHistory.js');
  process.exit(1);
}

fs.writeFileSync(vhFile, updated);
console.log(`VersionHistory.js updated — prepended ${payload.version}`);
