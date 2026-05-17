/* eslint-disable no-console */
/**
 * CRM Phase 21 — Lead Ref Sequence Separation
 *
 * Separates LD (operational CRM) and TRK (tracking/analytics) into independent
 * PostgreSQL sequences with year-qualified formats:
 *
 *   LD-YYYY-NNNNNN   — operational leads with contact identity
 *   TRK-YYYY-NNNNNN  — tracking, analytics-only, and no-identity records
 *
 * What this script does:
 *   1. Creates lead_ref_ld_seq and lead_ref_trk_seq PostgreSQL sequences
 *   2. Renumbers ALL tracking records to TRK-YYYY-NNNNNN (ordered by created_at)
 *      — fixes old TRK-{id} format (no year) from Phase 20.1 backfill
 *      — fixes any tracking records that incorrectly received LD-* prefix at runtime
 *   3. Sets LD sequence start to max(existing LD number) + 1 — existing LD refs unchanged
 *   4. Backfills any remaining NULL lead_refs using the correct sequence per record type
 *   5. Validates: no NULLs, no duplicates, all TRK have year format, no wrong prefix
 *
 * Idempotent — safe to re-run. Each run rebuilds TRK numbering from scratch in order,
 * which is stable (same created_at ordering always produces the same ref assignment).
 *
 * Prerequisite: migrate-crm-phase20-1-startup-cleanup.js must have run first
 *               (creates the lead_ref column and unique index).
 *
 * Usage:
 *   node scripts/migrate-crm-phase21-lead-ref-sequences.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

function sslOption(url) {
  if (!url) return undefined;
  if (/neon\.tech|aiven\.io|supabase\.co|render\.com|sslmode=require|ssl=true/i.test(url))
    return { rejectUnauthorized: false };
  return undefined;
}

async function run(client, label, sql, params = []) {
  try {
    const result = await client.query(sql, params);
    const rowCount = result.rowCount ?? result.rows?.length ?? 0;
    if (rowCount > 0) console.log(`  ✓ ${label} — ${rowCount} row(s) affected`);
    else              console.log(`  · ${label} — no-op`);
    return rowCount;
  } catch (e) {
    console.error(`  ✗ ${label} FAILED: ${e.message}`);
    throw e;
  }
}

/**
 * Mirrors hasOperationalIdentity() from crm.constants.ts exactly.
 * Returns true when the record should be classified as TRK (not operational).
 * A lead is tracking when it has no reachable contact OR has a non-operational quality tier.
 */
function isTrackingRecord(row) {
  const phone = (row.phone ?? '').trim();
  const email = (row.email ?? '').trim();
  const hasContact = !!(phone && phone.toLowerCase() !== 'unknown') || !!email;
  const quality = row.lead_quality;
  const NON_OPERATIONAL = ['TRACKING_ONLY', 'JUNK', 'DUPLICATE'];
  const isNonOperational = !!(quality && NON_OPERATIONAL.includes(quality));
  // Tracking = lacks contact OR has non-operational quality
  return !hasContact || isNonOperational;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL missing'); process.exit(1); }
  const client = new Client({ connectionString: url, ssl: sslOption(url) });
  await client.connect();
  console.log('Connected. Running CRM Phase 21 lead_ref sequence separation…\n');

  try {
    // ── STEP 1: Create sequences ──────────────────────────────────────────────
    console.log('STEP 1 — Create sequences');

    await run(client, 'CREATE SEQUENCE lead_ref_ld_seq', `
      CREATE SEQUENCE IF NOT EXISTS lead_ref_ld_seq
        START 1 INCREMENT 1 NO MAXVALUE NO CYCLE
    `);
    await run(client, 'CREATE SEQUENCE lead_ref_trk_seq', `
      CREATE SEQUENCE IF NOT EXISTS lead_ref_trk_seq
        START 1 INCREMENT 1 NO MAXVALUE NO CYCLE
    `);

    // ── STEP 2: Classify all leads ────────────────────────────────────────────
    console.log('\nSTEP 2 — Classify existing records');

    const { rows: allLeads } = await client.query(`
      SELECT id, lead_ref, lead_quality, phone, email, created_at
      FROM leads
      ORDER BY created_at ASC, id ASC
    `);

    const trkLeads = allLeads.filter(r => isTrackingRecord(r));
    const ldLeads  = allLeads.filter(r => !isTrackingRecord(r));

    console.log(`  · Total: ${allLeads.length} leads`);
    console.log(`  · Operational (LD): ${ldLeads.length}`);
    console.log(`  · Tracking (TRK):   ${trkLeads.length}`);

    const wrongPrefix = trkLeads.filter(r => r.lead_ref && r.lead_ref.startsWith('LD-'));
    const oldTrkFormat = trkLeads.filter(r => r.lead_ref && /^TRK-\d{6}$/.test(r.lead_ref));

    if (wrongPrefix.length > 0) {
      console.log(`  ⚠ ${wrongPrefix.length} tracking records have wrong LD-* prefix — will fix`);
    }
    if (oldTrkFormat.length > 0) {
      console.log(`  ⚠ ${oldTrkFormat.length} TRK records have old (no-year) format — will fix`);
    }

    // ── STEP 3: Renumber all TRK records in a transaction ────────────────────
    // Uses created_at ASC ordering so TRK-YYYY-000001 is the earliest tracking record.
    // Clears all TRK refs first to avoid transient unique constraint conflicts.
    console.log('\nSTEP 3 — Renumber TRK records (TRK-YYYY-NNNNNN)');

    if (trkLeads.length === 0) {
      console.log('  · No tracking records found — skipping');
    } else {
      // Reset TRK sequence to 1 for deterministic idempotent renumber
      await client.query(`ALTER SEQUENCE lead_ref_trk_seq RESTART WITH 1`);

      await client.query('BEGIN');
      try {
        // Phase A: clear all TRK lead_refs (unique index is partial WHERE NOT NULL — safe)
        const trkIds = trkLeads.map(r => r.id);
        await client.query(
          `UPDATE leads SET lead_ref = NULL WHERE id = ANY($1::int[])`,
          [trkIds],
        );

        // Phase B: assign new TRK-YYYY-NNNNNN in created_at ASC order
        let assigned = 0;
        for (const row of trkLeads) {
          const year = new Date(row.created_at).getFullYear();
          const { rows: [{ nextval }] } = await client.query(
            `SELECT nextval('lead_ref_trk_seq') AS nextval`,
          );
          const newRef = `TRK-${year}-${String(nextval).padStart(6, '0')}`;
          await client.query(
            `UPDATE leads SET lead_ref = $1 WHERE id = $2`,
            [newRef, row.id],
          );
          assigned++;
        }

        await client.query('COMMIT');
        console.log(`  ✓ Assigned ${assigned} TRK refs (TRK-YYYY-NNNNNN format)`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }

    // ── STEP 4: Set LD sequence start to avoid collisions ────────────────────
    // Existing LD-* refs are NOT renumbered — they keep their current values.
    // Sequence is set to max(existing LD counter) so future refs don't collide.
    // LD-YYYY-NNNNNN: NNNNNN starts at position 9 (1-indexed).
    console.log('\nSTEP 4 — Set LD sequence start value');

    const { rows: [{ max_ld_num }] } = await client.query(`
      SELECT COALESCE(
        MAX(CAST(SUBSTRING(lead_ref FROM 9) AS int)),
        0
      ) AS max_ld_num
      FROM leads
      WHERE lead_ref ~ '^LD-[0-9]{4}-[0-9]{6}$'
    `);

    const maxLd = Number(max_ld_num);
    if (maxLd > 0) {
      // setval(seq, val, true) means "val was already used; next nextval() = val+1"
      await client.query(`SELECT setval('lead_ref_ld_seq', $1, true)`, [maxLd]);
      console.log(`  ✓ LD sequence set — last used: ${maxLd}, next: ${maxLd + 1}`);
    } else {
      console.log('  · No existing LD refs found — LD sequence starts at 1');
    }

    // ── STEP 5: Backfill NULL lead_refs ───────────────────────────────────────
    console.log('\nSTEP 5 — Backfill NULL lead_refs');

    const { rows: nullLeads } = await client.query(`
      SELECT id, lead_quality, phone, email, created_at
      FROM leads
      WHERE lead_ref IS NULL
      ORDER BY created_at ASC, id ASC
    `);

    if (nullLeads.length === 0) {
      console.log('  · No NULL lead_refs — no-op');
    } else {
      let backfilled = 0;
      for (const row of nullLeads) {
        const year    = new Date(row.created_at).getFullYear();
        const isTrk   = isTrackingRecord(row);
        const seqName = isTrk ? 'lead_ref_trk_seq' : 'lead_ref_ld_seq';
        const prefix  = isTrk ? 'TRK' : 'LD';
        const { rows: [{ nextval }] } = await client.query(
          `SELECT nextval('${seqName}') AS nextval`,
        );
        const newRef = `${prefix}-${year}-${String(nextval).padStart(6, '0')}`;
        await client.query(`UPDATE leads SET lead_ref = $1 WHERE id = $2`, [newRef, row.id]);
        backfilled++;
      }
      console.log(`  ✓ Backfilled ${backfilled} NULL lead_refs`);
    }

    // ── STEP 6: Validate ──────────────────────────────────────────────────────
    console.log('\nSTEP 6 — Validation');

    const { rows: [{ null_count }] } = await client.query(
      `SELECT COUNT(*) AS null_count FROM leads WHERE lead_ref IS NULL`,
    );
    if (Number(null_count) > 0) {
      throw new Error(`Validation FAILED: ${null_count} leads still have NULL lead_ref`);
    }
    console.log('  ✓ No NULL lead_refs');

    const { rows: [{ dup_count }] } = await client.query(`
      SELECT COUNT(*) AS dup_count FROM (
        SELECT lead_ref FROM leads GROUP BY lead_ref HAVING COUNT(*) > 1
      ) sub
    `);
    if (Number(dup_count) > 0) {
      throw new Error(`Validation FAILED: ${dup_count} duplicate lead_refs found`);
    }
    console.log('  ✓ No duplicate lead_refs');

    const { rows: [{ old_trk_count }] } = await client.query(`
      SELECT COUNT(*) AS old_trk_count
      FROM leads WHERE lead_ref ~ '^TRK-[0-9]{6}$'
    `);
    if (Number(old_trk_count) > 0) {
      throw new Error(`Validation FAILED: ${old_trk_count} TRK records still have old no-year format`);
    }
    console.log('  ✓ All TRK refs have year format (TRK-YYYY-NNNNNN)');

    const { rows: [{ wrong_px }] } = await client.query(`
      SELECT COUNT(*) AS wrong_px
      FROM leads
      WHERE (
        lead_quality IN ('TRACKING_ONLY', 'JUNK', 'DUPLICATE')
        OR (
          (phone IS NULL OR TRIM(phone) = '' OR LOWER(TRIM(phone)) = 'unknown')
          AND (email IS NULL OR TRIM(email) = '')
        )
      )
      AND lead_ref NOT LIKE 'TRK-%'
    `);
    if (Number(wrong_px) > 0) {
      throw new Error(`Validation FAILED: ${wrong_px} tracking leads have non-TRK prefix`);
    }
    console.log('  ✓ All tracking leads have TRK-* prefix');

    const { rows: [ldSeq] } = await client.query(
      `SELECT last_value, is_called FROM lead_ref_ld_seq`,
    );
    const { rows: [trkSeq] } = await client.query(
      `SELECT last_value, is_called FROM lead_ref_trk_seq`,
    );

    const { rows: [{ ld_total }] } = await client.query(
      `SELECT COUNT(*) AS ld_total FROM leads WHERE lead_ref LIKE 'LD-%'`,
    );
    const { rows: [{ trk_total }] } = await client.query(
      `SELECT COUNT(*) AS trk_total FROM leads WHERE lead_ref LIKE 'TRK-%'`,
    );

    console.log(`\n  Summary:`);
    console.log(`    LD  records : ${ld_total}  (sequence last_value=${ldSeq.last_value}, is_called=${ldSeq.is_called})`);
    console.log(`    TRK records : ${trk_total}  (sequence last_value=${trkSeq.last_value}, is_called=${trkSeq.is_called})`);
    console.log(`    Next LD ref : LD-${new Date().getFullYear()}-${String(Number(ldSeq.last_value) + (ldSeq.is_called ? 1 : 0)).padStart(6, '0')}`);
    console.log(`    Next TRK ref: TRK-${new Date().getFullYear()}-${String(Number(trkSeq.last_value) + 1).padStart(6, '0')}`);

    console.log('\n✅ Phase 21 lead_ref sequence separation complete.');
    console.log('   Deploy updated lead.service.ts (sequence-backed generator) before re-enabling webhooks.');

  } finally {
    await client.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
