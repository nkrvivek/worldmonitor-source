#!/usr/bin/env node

// Pre-assembled chokepoint transit summaries.
//
// Ported from seedTransitSummaries() and seedChokepointTransits() in the old
// Node relay (scripts/ais-relay.cjs, lines 8086 and 8012). The relay held the
// 24-hour crossing counts in memory and wrote them straight to Redis; now the
// counting and the writing sit on opposite sides of the network. AisRelayDO
// holds the crossings and serves them at /ais/transits, and this script does
// the reading and the writing.
//
// Three inputs:
//   supply_chain:portwatch:v1      per-chokepoint daily history and WoW change
//   supply_chain:corridorrisk:v1   risk fields, from scripts/seed-corridor-risk.mjs
//   <relay>/ais/transits           the last 24 hours of crossings
//
// Four outputs:
//   supply_chain:transit-summaries:v1              the compact summary, read on
//                                                  every get-chokepoint-status call
//   supply_chain:transit-summaries:history:v1:<id> 13 history keys, read only on
//                                                  card expand
//   supply_chain:chokepoint_transits:v1            raw counts by geofence name
//
// The split is deliberate: combined, the payload reached ~500KB and blew the
// edge read budget (docs/archive/plans/chokepoint-rpc-payload-split.md).

import { loadEnvFile, runSeed, getRedisCredentials } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { getRelayBaseUrl, getRelayHeaders } from './_relay-client.mjs';
import { detectTrafficAnomaly } from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'supply_chain:transit-summaries:v1';
export const HISTORY_KEY_PREFIX = 'supply_chain:transit-summaries:history:v1:';
export const TRANSITS_KEY = 'supply_chain:chokepoint_transits:v1';
const PORTWATCH_KEY = 'supply_chain:portwatch:v1';
const CORRIDOR_RISK_KEY = 'supply_chain:corridorrisk:v1';
const TTL = 3600; // 1h — 6x the interval, so ~5 missed runs before the key expires
const RELAY_TIMEOUT_MS = 15_000;

// Threat levels for anomaly detection. Must stay in sync with CHOKEPOINTS[].threatLevel
// in server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts. Only war_zone and
// critical trigger an anomaly signal.
export const CHOKEPOINT_THREAT_LEVELS = {
  suez: 'high', malacca_strait: 'normal', hormuz_strait: 'war_zone',
  bab_el_mandeb: 'critical', panama: 'normal', taiwan_strait: 'elevated',
  cape_of_good_hope: 'normal', gibraltar: 'normal', bosphorus: 'elevated',
  korea_strait: 'normal', dover_strait: 'normal', kerch_strait: 'war_zone',
  lombok_strait: 'normal',
};

// Relay geofence name -> canonical chokepoint id. South China Sea and Black Sea
// are area geofences, not chokepoints, and map to nothing — but they still reach
// supply_chain:chokepoint_transits:v1, which is keyed by geofence name and covers
// all 15. That is what the relay wrote and what its consumers read.
export const RELAY_NAME_TO_ID = {
  'Suez Canal': 'suez', 'Malacca Strait': 'malacca_strait',
  'Strait of Hormuz': 'hormuz_strait', 'Bab el-Mandeb Strait': 'bab_el_mandeb',
  'Panama Canal': 'panama', 'Taiwan Strait': 'taiwan_strait',
  'Cape of Good Hope': 'cape_of_good_hope', 'Gibraltar Strait': 'gibraltar',
  'Bosporus Strait': 'bosphorus', 'Korea Strait': 'korea_strait',
  'Dover Strait': 'dover_strait', 'Kerch Strait': 'kerch_strait',
  'Lombok Strait': 'lombok_strait',
  'South China Sea': null, 'Black Sea': null,
};

const ID_TO_RELAY_NAME = Object.fromEntries(
  Object.entries(RELAY_NAME_TO_ID).filter(([, id]) => id).map(([name, id]) => [id, name]),
);

async function redisGet(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? unwrapEnvelope(JSON.parse(data.result)).data : null;
}

/**
 * The relay's 24-hour crossing counts, keyed by geofence name.
 *
 * Throws rather than returning empty counts. A dead feed and a genuinely quiet
 * strait both count zero crossings; publishing the first as the second wipes
 * every todayTotal on the panel. Throwing leaves the last good values in place
 * and lets the next run correct them — which is why the response carries
 * `connected` and `vessels` at all (worker/ais/transits-contract.ts).
 *
 * A deploy is the ordinary case: the crossings live in Durable Object memory,
 * so a new version starts at zero and needs 24 hours to refill the window.
 * Refusing through that window is the point, not a side effect.
 *
 * The throw is a signal about ONE of three inputs, not about the run. See
 * fetchRelayTransitsOrNull below for who catches it and why.
 */
export async function fetchRelayTransits() {
  const base = getRelayBaseUrl();
  if (!base) throw new Error('WS_RELAY_URL not set — cannot read chokepoint crossings');

  const resp = await fetch(`${base}/ais/transits`, {
    headers: getRelayHeaders(),
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`relay /ais/transits HTTP ${resp.status}`);

  const data = await resp.json();
  if (!data?.transits || typeof data.transits !== 'object') {
    throw new Error('relay /ais/transits returned no transits object');
  }
  // Two ways the feed can be dead, and only one of them shows in `connected`.
  // Measured 2026-08-06, hours after the Durable Object took over the counting:
  // connected true, vessels 0, messages 0, every fence at total 0. The socket
  // was open and AISStream had sent nothing over it. The seed published those
  // zeros and wiped every todayTotal on the panel. A live feed tracks thousands
  // of vessels, so zero is a dead feed rather than a quiet ocean — and a
  // response with no vessel count at all cannot say either way, which is the
  // same reason to refuse.
  if (data.connected !== true || !data.vessels) {
    throw new Error(
      `relay AIS feed is not delivering (connected=${data.connected}, `
      + `${data.vessels ?? 0} vessels tracked) — `
      + 'refusing to publish zero crossings over the last good counts',
    );
  }
  return data.transits;
}

/**
 * The same read, degraded to null when the relay cannot answer.
 *
 * Measured 2026-08-07: AISStream had been down since 2026-08-05, so
 * fetchRelayTransits threw on every tick. It sat inside the Promise.all in
 * fetchAll, so the throw aborted the whole run and the key went unwritten for
 * 2h19m against a 10-minute cron — taking with it the five risk fields, which
 * come from supply_chain:corridorrisk:v1 over plain HTTP and never touch AIS.
 * A dead vessel feed cost us the war-risk data it has nothing to do with, and
 * health reported STALE_SEED, which reads as a broken cron.
 *
 * So the relay's failure now costs the relay's fields and nothing else. The
 * counts fall to zero, and zero counts render as nothing: the panel gates its
 * vessel span on `todayTotal > 0` and the raw-counts key is preserved rather
 * than overwritten (skipWhenEmpty on TRANSITS_KEY below). The counts gate
 * themselves — no flag stands in for them.
 */
export async function fetchRelayTransitsOrNull() {
  try {
    return await fetchRelayTransits();
  } catch (err) {
    console.warn(`  relay transits unavailable — publishing without them: ${err.message || err}`);
    return null;
  }
}

/**
 * One summary row per canonical chokepoint, plus the history each row's key holds.
 *
 * Every one of the 13 gets a row whether PortWatch covered it or not — the panel
 * renders 13 cards and `dataAvailable` is how a card says it has no history.
 * declareRecords counts that flag, so the envelope's recordCount states what
 * PortWatch covered and api/health.js sees a shortfall rather than a full house.
 *
 * `dataAvailable` means PortWatch and only PortWatch. It gates the history chart
 * and feeds coveredCount in get-chokepoint-status.ts, both of which are about
 * PortWatch history; widening it to cover the relay would report a full house of
 * chokepoints as uncovered every time the AIS feed blinks. `transits` may be
 * null — a dead relay zeroes the four count fields and touches nothing else.
 *
 * `transitCountsAvailable` is the relay's own flag, and the reason the two are
 * separate. It is false for every row when the relay did not answer, so a reader
 * can tell a zero count from an absent one. Per run, not per chokepoint: a live
 * relay that saw nothing cross a quiet strait publishes a real zero and keeps
 * this true.
 */
export function buildSummaries(portwatch, corridorRisk, transits, now) {
  const summaries = {};
  const historyById = {};

  for (const [cpId, threatLevel] of Object.entries(CHOKEPOINT_THREAT_LEVELS)) {
    const cpData = portwatch?.[cpId];
    const history = cpData?.history ?? [];
    const relayName = ID_TO_RELAY_NAME[cpId];
    const transit = relayName ? transits?.[relayName] : null;
    const cr = corridorRisk?.[cpId];

    summaries[cpId] = {
      todayTotal: transit?.total ?? 0,
      todayTanker: transit?.tanker ?? 0,
      todayCargo: transit?.cargo ?? 0,
      todayOther: transit?.other ?? 0,
      wowChangePct: cpData?.wowChangePct ?? 0,
      riskLevel: cr?.riskLevel ?? '',
      incidentCount7d: cr?.incidentCount7d ?? 0,
      disruptionPct: cr?.disruptionPct ?? 0,
      riskSummary: cr?.riskSummary ?? '',
      riskReportAction: cr?.riskReportAction ?? '',
      anomaly: detectTrafficAnomaly(history, threatLevel),
      dataAvailable: Boolean(cpData),
      transitCountsAvailable: transits !== null && transits !== undefined,
    };

    historyById[cpId] = { chokepointId: cpId, history, fetchedAt: now };
  }

  // Field names here must not collide with what publishTransform strips, or the
  // extraKey leak guard in _seed-utils.mjs aborts the run. `historyById` and
  // `relayTransits` are named apart from the `history` and `transits` fields the
  // extra keys publish for exactly that reason.
  return { summaries, historyById, relayTransits: transits ?? {}, fetchedAt: now };
}

export async function fetchAll() {
  const { url, token } = getRedisCredentials();

  const [portwatch, corridorRisk, transits] = await Promise.all([
    redisGet(url, token, PORTWATCH_KEY),
    redisGet(url, token, CORRIDOR_RISK_KEY).catch(() => null),
    fetchRelayTransitsOrNull(),
  ]);

  if (!portwatch || typeof portwatch !== 'object' || Object.keys(portwatch).length === 0) {
    throw new Error(`${PORTWATCH_KEY} absent or empty — its seeder has not written it yet`);
  }
  if (!corridorRisk || Object.keys(corridorRisk).length === 0) {
    // Five of the ten fields come from this key. The row is still worth writing
    // without it — todayTotal and the anomaly do not depend on it — but a reader
    // seeing empty riskLevel everywhere should be able to find out why here.
    console.warn(`  ${CORRIDOR_RISK_KEY} absent — risk fields will be empty this run`);
  }

  return buildSummaries(portwatch, corridorRisk, transits, Date.now());
}

/** The canonical key carries the summaries alone. History and raw counts go to their own keys. */
export function publishTransform(data) {
  return { summaries: data.summaries, fetchedAt: data.fetchedAt };
}

export function validateFn(data) {
  return Boolean(data?.summaries && Object.keys(data.summaries).length > 0);
}

/**
 * Chokepoints PortWatch covered, not the always-13 row count.
 *
 * Receives the PUBLISHED payload, so it counts `dataAvailable` rather than
 * reading a field of its own.
 */
export function declareRecords(published) {
  const summaries = published?.summaries;
  if (!summaries || typeof summaries !== 'object') return 0;
  return Object.values(summaries).filter((s) => s.dataAvailable).length;
}

const HISTORY_EXTRA_KEYS = Object.keys(CHOKEPOINT_THREAT_LEVELS).map((cpId) => ({
  key: `${HISTORY_KEY_PREFIX}${cpId}`,
  transform: (data) => data.historyById[cpId],
  declareRecords: (payload) => payload.history.length,
}));

export const EXTRA_KEYS = [
  ...HISTORY_EXTRA_KEYS,
  {
    key: TRANSITS_KEY,
    transform: (data) => ({ transits: data.relayTransits, fetchedAt: data.fetchedAt }),
    declareRecords: (payload) => Object.keys(payload.transits).length,
    metaKey: 'seed-meta:supply_chain:chokepoint_transits',
    // A dead relay gives an empty transits object. Its consumers read raw
    // counts by geofence name, and nothing else writes this key, so an empty
    // write would erase the last good counts with no way back. Skip the write
    // and extend the TTL instead — the canonical summaries still publish.
    skipWhenEmpty: true,
  },
];

const isMain = process.argv[1]?.endsWith('seed-transit-summaries.mjs');

if (isMain) {
  runSeed('supply_chain', 'transit-summaries', CANONICAL_KEY, fetchAll, {
    validateFn,
    publishTransform,
    ttlSeconds: TTL,
    sourceVersion: 'transit-summaries',
    recordCount: declareRecords,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 30,
    extraKeys: EXTRA_KEYS,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
