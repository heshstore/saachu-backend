#!/usr/bin/env bash
# Verify db-snapshot.sql COPY row counts match counts-at-backup.json manifest.
set -euo pipefail

BACKUP_DIR="${1:?backup directory required}"
SQL="${BACKUP_DIR}/db-snapshot.sql"
MANIFEST="${BACKUP_DIR}/counts-at-backup.json"

[[ -f "$SQL" ]] || { echo "verify-backup-integrity: missing $SQL" >&2; exit 1; }
[[ -f "$MANIFEST" ]] || { echo "verify-backup-integrity: missing $MANIFEST" >&2; exit 1; }

python3 - "$SQL" "$MANIFEST" <<'PY'
import re, json, sys
sql_path, manifest_path = sys.argv[1], sys.argv[2]
counts = {}
current = None
rows = 0
with open(sql_path) as f:
    for line in f:
        m = re.match(r'^COPY public\.(\w+) ', line)
        if m:
            if current:
                counts[current] = rows
            current = m.group(1)
            rows = 0
            continue
        if line.strip() == r'\.':
            if current:
                counts[current] = rows
            current = None
            rows = 0
            continue
        if current is not None:
            rows += 1
expected = json.load(open(manifest_path))
pairs = [
    ('customer', 'customer'),
    ('marketing_audience', 'marketing_audience'),
    ('campaigns', 'marketing_campaigns'),
    ('queue', 'whatsapp_message_queue'),
    ('logs', 'whatsapp_message_logs'),
]
ok = True
for key, table in pairs:
    sql_n = counts.get(table, -1)
    exp_n = int(expected.get(key, -1))
    status = 'OK' if sql_n == exp_n else 'MISMATCH'
    if sql_n != exp_n:
        ok = False
    print(f"verify-backup-integrity: {key} sql={sql_n} manifest={exp_n} {status}")
sys.exit(0 if ok else 1)
PY

echo "verify-backup-integrity: PASSED"
