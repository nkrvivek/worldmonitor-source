// FLEET GUARD: a seeded key's staleness gate must OUTLIVE the cron that refreshes it.
//
// The sibling guard, tests/seed-ttl-outlives-staleness-fleet.test.mjs, compares a
// data TTL against `maxStaleMin` and says so in its own header: "The margin is
// measured against the CRON, and this test only sees maxStaleMin. When a cron
// changes, nothing here notices."
//
// That blind spot has now cost the same bug four times. seed-economy moved from
// */15 to daily and kept a 1h TTL. seed-commodity-quotes and seed-market-quotes
// moved from */5 to '11,41' and kept `CACHE_TTL = 1800` plus `maxStaleMin: 30` —
// both exactly one cron interval, so a tick one minute late reported EMPTY (crit)
// on a seeder that had succeeded 31 minutes earlier. Measured 2026-08-19:
//
//   commodityQuotes: status=EMPTY records=0 age=31m max=30m
//   goldExtended:    status=EMPTY records=0 age=31m max=30m
//
// A gate equal to the cadence is not a tighter alarm. It is an alarm that fires in
// the tail of every cycle on a healthy fleet, and an alarm that always fires is one
// nobody reads.
//
// The invariant:
//
//   maxStaleMin  >=  MIN_RATIO * cronCadenceMinutes
//
// The crons now live in worker/seeds/registry.ts, in this repo, so this test can
// read them. Under Railway they were remote config and could not be checked at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_RATIO = 1.5;
const MAX_ABSOLUTE_DRIFT_MIN = 60;

/** The smallest gate a cron of this cadence may carry without alarming on a healthy run. */
function floorFor(cadence) {
  return Math.min(MIN_RATIO * cadence, cadence + MAX_ABSOLUTE_DRIFT_MIN);
}

// The floor is "half again the cadence, or one hour, whichever is less". Two models of
// drift are in use here and both are right. Fast rails drift in proportion, and the
// repo writes 1.5x at health.js earthquakes and radiationWatch:
// "the old 30 flagged it every hour from :55 to :25 — a guaranteed flap, not a signal.
// 90 = same 1.5x-cadence headroom forecasts uses." Slow rails drift by a fixed amount
// instead. tests/seed-freshness-monitor.test.mjs pins shippingRates at 420 and asserts
// it in those words: "health must allow one hour of headroom beyond the six-hour cron".
// macroSignals writes the same shape at a day: "1560min = 26h = interval + 2h drift".
// Half again a daily cadence would be 36 hours, which is not a tighter alarm, only a
// later one. So the floor takes whichever of the two is smaller, and 60 is the smallest
// fixed headroom the repo actually chose anywhere.
//
// This deliberately does not police the gap above the floor. seed-supply-chain-trade
// runs gate >= TTL on purpose (tests/trade-policy-tariffs.test.mjs: "tighter would fire
// STALE_SEED before the data has even expired"), and that decision stays its own.
//
// At 1.0 the alarm is guaranteed. Above the floor a genuinely missed tick still alarms,
// which is the point. This test polices the floor, not the choice made above it.

/**
 * Minutes between consecutive fires of a 5-field cron, for the minute-field
 * patterns the seed registry uses. Returns null for anything else rather than
 * guessing — an unparsed cron is reported, never silently treated as safe.
 */
function cadenceMinutes(cron) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;   // calendar cron, reported as a skip

  const widestGap = (field, wheel) => {
    if (field === '*') return 1;
    const step = field.match(/^\*\/(\d+)$/);
    if (step) return Number(step[1]);
    if (!/^\d+(,\d+)*$/.test(field)) return null;
    const fires = [...new Set(field.split(',').map(Number))].sort((a, b) => a - b);
    if (fires.length === 1) return wheel;
    let widest = wheel - fires[fires.length - 1] + fires[0];   // the wrap-around gap
    for (let i = 1; i < fires.length; i += 1) widest = Math.max(widest, fires[i] - fires[i - 1]);
    return widest;
  };

  const minuteGap = widestGap(min, 60);
  if (minuteGap === null) return null;
  if (hour === '*') return minuteGap;

  // Fires only within named hours: the gap between hours dominates.
  const hourGap = widestGap(hour, 24);
  return hourGap === null ? null : hourGap * 60;
}

function readRegistryJobs() {
  const src = readFileSync(join(ROOT, 'worker', 'seeds', 'registry.ts'), 'utf8');
  const start = src.indexOf('export const SEED_JOBS');
  assert.ok(start > 0, 'SEED_JOBS not found in worker/seeds/registry.ts — this guard reads nothing');

  const jobs = [];
  for (const m of src.slice(start).matchAll(/cron:\s*'([^']+)'\s*,\s*scripts:\s*\[([\s\S]*?)\]/g)) {
    const scripts = [...m[2].matchAll(/'(scripts\/[^']+\.mjs)'/g)].map((s) => s[1]);
    if (scripts.length) jobs.push({ cron: m[1], scripts });
  }
  return jobs;
}

function readHealthGates() {
  const health = readFileSync(join(ROOT, 'api', 'health.js'), 'utf8');
  const gates = {};
  for (const m of health.matchAll(/key:\s*'(seed-meta:[^']+)'\s*,\s*maxStaleMin:\s*([\d_]+)/g)) {
    const gate = Number(m[2].replace(/_/g, ''));
    gates[m[1]] = Math.max(gates[m[1]] ?? 0, gate);   // strictest wins is wrong here; the loosest is what classifies
  }
  return gates;
}

function audit() {
  const gates = readHealthGates();
  const checked = [];
  const violations = [];
  const unparsedCrons = [];

  for (const job of readRegistryJobs()) {
    const cadence = cadenceMinutes(job.cron);
    if (cadence === null) { unparsedCrons.push(job.cron); continue; }


    for (const rel of job.scripts) {
      const path = join(ROOT, rel);
      if (!existsSync(path)) continue;                 // registry lists it, tree does not have it
      const src = readFileSync(path, 'utf8');
      const file = rel.replace(/^scripts\//, '');

      // (a) the gate the seeder declares for its own canonical key
      const own = src.match(/^\s*maxStaleMin:\s*(\d+)\s*,/m);
      if (own) {
        const gate = Number(own[1]);
        checked.push({ id: file, cron: job.cron, cadence, gate });
        if (gate < floorFor(cadence)) violations.push({ id: file, cron: job.cron, cadence, gate });
      }

      // (b) every extra seed-meta key it names, judged by health.js's own table
      for (const m of src.matchAll(/^\s*metaKey:\s*'(seed-meta:[^']+)'/gm)) {
        const gate = gates[m[1]];
        if (gate === undefined) continue;              // not health-monitored
        const id = `${file}::${m[1]}`;
        checked.push({ id, cron: job.cron, cadence, gate });
        if (gate < floorFor(cadence)) violations.push({ id, cron: job.cron, cadence, gate });
      }
    }
  }

  return { checked, violations, unparsedCrons };
}

test('no seeder is judged stale faster than its own cron can refresh it', () => {
  const { violations } = audit();
  const lines = violations.map(
    (v) => `  ${v.id}: cron '${v.cron}' fires every ${v.cadence}min, gate maxStaleMin=${v.gate} (needs >= ${floorFor(v.cadence)})`,
  );
  assert.equal(
    violations.length,
    0,
    `${violations.length} seeder(s) alarm on a healthy run:\n${lines.join('\n')}\n\n` +
      'Raise maxStaleMin above the floor, or slow the cron down. ' +
      'Do not silence it in the freshness baseline: the baseline hides a symptom, this is the cause.',
  );
});

test('the audit still reads the registry — coverage cannot rot', () => {
  const { checked, unparsedCrons } = audit();
  // A rename in registry.ts or a change of quoting style would leave this test
  // passing over an empty list. Floor set below the count measured 2026-08-19 (34).
  assert.ok(checked.length >= 18, `only ${checked.length} script/key pairs resolved; the registry parse has rotted`);

  // Skips are listed, never silent. Only calendar crons (a day-of-month, month or
  // day-of-week field) may be skipped; a minute/hour cron this guard cannot read is
  // a hole in the coverage and fails here.
  const unreadable = unparsedCrons.filter((c) => {
    const [, , dom, mon, dow] = c.trim().split(/\s+/);
    return dom === '*' && mon === '*' && dow === '*';
  });
  assert.deepEqual(unreadable, [], `minute/hour crons this guard cannot read: ${unreadable.join(' | ')}`);
});

test('the floor follows the cheaper of the two drift models', () => {
  assert.equal(floorFor(30), 45);       // fast rail: proportional
  assert.equal(floorFor(60), 90);
  assert.equal(floorFor(360), 420);     // 6-hourly: the fixed 1h allowance is cheaper, and 420 is what shipping carries
  assert.equal(floorFor(1440), 1500);   // daily: fxYoy's 25h clears it; macroSignals' 26h clears it with room
});

test('cadenceMinutes reads the widest gap, not the average', () => {
  assert.equal(cadenceMinutes('*/5 * * * *'), 5);
  assert.equal(cadenceMinutes('*/15 * * * *'), 15);
  assert.equal(cadenceMinutes('11,41 * * * *'), 30);
  assert.equal(cadenceMinutes('5,20,35,50 * * * *'), 15);
  assert.equal(cadenceMinutes('7 * * * *'), 60);
  assert.equal(cadenceMinutes('20 */6 * * *'), 360);
  assert.equal(cadenceMinutes('0 9 * * *'), 1440);
  // 0 and 5 look like a 5-minute cadence on average and are really a 55-minute wait.
  assert.equal(cadenceMinutes('0,5 * * * *'), 55);
  assert.equal(cadenceMinutes('0 9 * * 1'), null);   // calendar cron, reported as a skip
});
