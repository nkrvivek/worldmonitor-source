#!/usr/bin/env node

// Satellite TLEs — CelesTrak NORAD elements for the tracked imaging and
// reconnaissance birds.
//
// Ported 2026-08-19 from seedSatelliteTLEs in scripts/ais-relay.cjs (:1890-2010).
// The relay was retired to Cloudflare and only /ais/snapshot moved across, so
// this loop stopped running and the `satellites` health row went EMPTY. Source
// needs no credential.
//
// The relay retried 20 minutes after a failure; a cron rail cannot, so a failed
// run waits for the next 2h slot. The 6h TTL covers that: it outlives two
// missed cycles, and the 240-min health gate warns before the data expires.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { SAT_GROUPS, buildSatelliteList } from './lib/satellite-tle.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:satellites:tle:v1';
// 6h against a 2h cron and a 240-min health gate. ttlSeconds > maxStaleMin * 60
// is the invariant: a merely-late run must report STALE_SEED (warn), never
// EMPTY (crit).
const CACHE_TTL = 21_600;
const MAX_BYTES = 2 * 1024 * 1024;

async function fetchGroup(group) {
  const resp = await fetch(
    `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`,
    { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(15_000) },
  );
  if (!resp.ok) throw new Error(`CelesTrak ${group}: HTTP ${resp.status}`);
  const text = await resp.text();
  if (text.length > MAX_BYTES) throw new Error(`CelesTrak ${group}: payload > 2MB`);
  return text;
}

async function fetchSatellites() {
  const texts = [];
  for (const group of SAT_GROUPS) {
    try {
      texts.push(await fetchGroup(group));
    } catch (err) {
      // One bad group is not a bad run: the other group still carries names.
      console.warn(`  skipping group ${group}:`, err?.message || err);
    }
  }
  const satellites = buildSatelliteList(texts);
  console.log(`  parsed ${satellites.length} tracked TLEs from ${texts.length}/${SAT_GROUPS.length} groups`);
  return { satellites, fetchedAt: Date.now() };
}

// Zero matches means CelesTrak changed its format or served an error body, not
// that the birds stopped flying. Keep last-good instead of blanking the panel.
function validate(payload) {
  return Array.isArray(payload?.satellites) && payload.satellites.length > 0;
}

export function declareRecords(payload) {
  return Array.isArray(payload?.satellites) ? payload.satellites.length : 0;
}

if (process.argv[1]?.endsWith('seed-satellites.mjs')) {
  runSeed('intelligence', 'satellites', CANONICAL_KEY, fetchSatellites, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'celestrak',
    recordCount: declareRecords,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 240,
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
