#!/usr/bin/env node
/**
 * Static verification for dynamic warmup redesign.
 * Run: node scripts/verify-warmup-redesign.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'marketing', 'whatsapp-engine');
const results = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function pass(id, msg) { results.push({ id, ok: true, msg }); }
function fail(id, msg) { results.push({ id, ok: false, msg }); }

// 1. T1/T2/T3 independence — no hardcoded telecaller IDs
const engineSrc = read('engine/autonomous-engine.service.ts');
if (!/findAll\(\)/.test(engineSrc) && !/activeNumbers/.test(engineSrc)) {
  fail(1, 'Autonomous engine does not discover numbers dynamically');
} else if (/T1|T2|T3|telecaller.*uuid/i.test(engineSrc)) {
  fail(1, 'Hardcoded telecaller IDs found in autonomous engine');
} else {
  pass(1, 'Numbers discovered via findAll() — no T1/T2/T3 hardcoding');
}

// 2. Dynamic queue release — mature capacity in build, release in sender
const limits = read('shared/number-limits.ts');
const queue = read('queue/queue.service.ts');
const autonomous = read('engine/autonomous-engine.service.ts');
const sender = read('sender/sender.service.ts');
if (limits.includes('MATURE_DAILY_CAPACITY = 150') &&
    limits.includes('RELEASE_ALLOWANCE_BY_LEVEL') &&
    (queue.includes('getMatureDailyCapacity') || autonomous.includes('getMatureDailyCapacity')) &&
    sender.includes('getReleaseAllowance')) {
  pass(2, 'Queue plans at mature capacity; sender enforces release allowance');
} else {
  fail(2, 'Missing mature-capacity queue build or release-allowance sender gate');
}

// 3. Warmup promotion service exists
if (fs.existsSync(path.join(ROOT, 'engine/warmup-progression.service.ts'))) {
  const promo = read('engine/warmup-progression.service.ts');
  if (promo.includes('WARMUP_PROMOTED') && promo.includes('evaluatePromotionsCron')) {
    pass(3, 'Warmup progression service with promotion cron present');
  } else {
    fail(3, 'Warmup progression service incomplete');
  }
} else {
  fail(3, 'warmup-progression.service.ts missing');
}

// 4. No hourly/2h sending control windows
const autoPause = read('engine/engine-auto-pause.service.ts');
const risk = read('ai/risk-ai.service.ts');
const badPatterns = [
  /WINDOW_MS\s*=\s*2\s*\*\s*60/,
  /last 2h/i,
  /oneHourAgo/,
  /3_600_000.*fail/i,
];
const foundShort = badPatterns.some((p) => p.test(autoPause) || p.test(risk));
if (foundShort) {
  fail(4, 'Short-window (hourly/2h) logic still present');
} else {
  pass(4, 'No hourly/2h control windows in auto-pause or risk-ai');
}

// 5. No AUTO_PAUSE
const audit = read('engine/engine-audit.service.ts');
if (/AUTO_PAUSE/.test(audit)) {
  fail(5, 'AUTO_PAUSE still in audit enum');
} else {
  pass(5, 'AUTO_PAUSE removed from audit events');
}

// 6. No health-triggered sending shutdown
if (/shouldPauseNumber[\s\S]*status:\s*WhatsAppNumberStatus\.INACTIVE/.test(risk) ||
    /checkHourlyBlockDetection[\s\S]*is_active:\s*false/.test(risk)) {
  fail(6, 'Risk AI still deactivates numbers on health');
} else {
  pass(6, 'Risk AI does not health-deactivate numbers');
}

// 7. Daily reset preserves warmup stage
const numbers = read('numbers/numbers.service.ts');
if (numbers.includes('daily_sent: 0') && !/warmup_level:\s*1/.test(numbers)) {
  pass(7, 'Daily reset clears daily_sent only (warmup_level not reset)');
} else {
  fail(7, 'Daily reset may reset warmup stage');
}

// 8. Analytics single source — metrics.definitions
if (fs.existsSync(path.join(ROOT, 'analytics/metrics.definitions.ts'))) {
  const dash = read('engine/ai-dashboard.service.ts');
  if (dash.includes('fetchAuthoritativeMetrics')) {
    pass(8, 'Dashboard uses fetchAuthoritativeMetrics (single source of truth)');
  } else {
    fail(8, 'AI dashboard missing authoritative metrics import');
  }
} else {
  fail(8, 'metrics.definitions.ts missing');
}

// 9. Dashboard today-only (IST bounds)
if (dashIncludesIst()) {
  pass(9, 'AI dashboard scopes queries to IST today via getIstDayBounds');
} else {
  fail(9, 'AI dashboard missing IST today scoping');
}

function dashIncludesIst() {
  const dash = read('engine/ai-dashboard.service.ts');
  return dash.includes('getIstDayBounds') && dash.includes('todayIso');
}

// 10. Future T4/T5/T6 — round-robin over sendableNumbers array
if (/sendableNumbers/.test(autonomous) && /numberCursor/.test(autonomous)) {
  pass(10, 'Round-robin over dynamic sendableNumbers supports arbitrary telecaller count');
} else {
  fail(10, 'Queue build not using dynamic number round-robin');
}

// L4 = 150
if (limits.includes('4: 150')) {
  pass('L4', 'L4 mature release allowance is 150');
} else {
  fail('L4', 'L4 allowance is not 150');
}

// Warnings only
if (autoPause.includes('LOW_REPLY_WARNING') || audit.includes('LOW_REPLY_WARNING')) {
  pass('WARN', 'LOW_REPLY_WARNING defined');
} else {
  fail('WARN', 'LOW_REPLY_WARNING missing');
}

console.log('\n=== WhatsApp Engine Warmup Redesign Verification ===\n');
let allOk = true;
for (const r of results) {
  const icon = r.ok ? '✓' : '✗';
  console.log(`${icon} [${r.id}] ${r.msg}`);
  if (!r.ok) allOk = false;
}
console.log(`\n${allOk ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}\n`);
process.exit(allOk ? 0 : 1);
