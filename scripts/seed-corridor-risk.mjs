#!/usr/bin/env node

// Corridor risk scores per chokepoint, from corridorrisk.io.
//
// Ported from seedCorridorRisk() in the old Node relay (scripts/ais-relay.cjs
// line 5510). It ran there only because that is where the loop lived — the
// fetch never touched the AIS stream. Five of the ten fields in every
// supply_chain:transit-summaries:v1 row come from this key and nothing else
// fills them, so seed-transit-summaries.mjs reads what this writes.

import { loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'supply_chain:corridorrisk:v1';
const BASE_URL = 'https://corridorrisk.io/api/corridors';
const TTL = 14_400; // 4h — hourly cron, so three failed runs before the key expires
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Upstream corridor name (lowercased, substring) -> canonical chokepoint id.
// Two corridors map onto a neighbouring chokepoint: the Red Sea corridor scores
// Bab el-Mandeb, and the Black Sea corridor scores the Bosphorus. Order matters
// — the first pattern a name contains wins.
const NAME_MAP = [
  { pattern: 'hormuz', id: 'hormuz_strait' },
  { pattern: 'bab-el-mandeb', id: 'bab_el_mandeb' },
  { pattern: 'red sea', id: 'bab_el_mandeb' },
  { pattern: 'suez', id: 'suez' },
  { pattern: 'south china sea', id: 'taiwan_strait' },
  { pattern: 'black sea', id: 'bosphorus' },
];

function riskLevelFor(score) {
  if (score >= 70) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 30) return 'elevated';
  return 'normal';
}

export function mapCorridors(corridors) {
  const result = {};
  for (const corridor of corridors) {
    const name = String(corridor?.name || '').toLowerCase();
    const mapping = NAME_MAP.find((m) => name.includes(m.pattern));
    if (!mapping) continue;
    const score = Number(corridor.score ?? 0);
    result[mapping.id] = {
      riskLevel: riskLevelFor(score),
      riskScore: score,
      incidentCount7d: Number(corridor.incident_count_7d ?? 0),
      eventCount7d: Number(corridor.event_count_7d ?? 0),
      disruptionPct: Number(corridor.disruption_pct ?? 0),
      vesselCount: Number(corridor.vessel_count ?? 0),
      riskSummary: String(corridor.risk_summary || '').slice(0, 200),
      riskReportAction: String(corridor.risk_report?.action || '').slice(0, 500),
    };
  }
  return result;
}

export async function fetchAll() {
  const resp = await fetch(BASE_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
      Referer: 'https://corridorrisk.io/dashboard.html',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`corridorrisk.io HTTP ${resp.status} — ${body.slice(0, 200)}`);
  }

  // The site sits behind Cloudflare. A challenge page answers 200 with HTML,
  // so the status code alone does not say the fetch worked.
  const text = await resp.text();
  if (text.trimStart().startsWith('<')) {
    throw new Error(`corridorrisk.io returned HTML, not JSON (Cloudflare challenge?) — ${text.slice(0, 150)}`);
  }

  const corridors = JSON.parse(text);
  if (!Array.isArray(corridors) || corridors.length === 0) {
    throw new Error('corridorrisk.io returned no corridors');
  }

  const result = mapCorridors(corridors);
  if (Object.keys(result).length === 0) {
    throw new Error(`corridorrisk.io returned ${corridors.length} corridors, none matching a known chokepoint`);
  }
  return result;
}

export function validateFn(data) {
  return data && typeof data === 'object' && Object.keys(data).length > 0;
}

export function declareRecords(data) {
  return data && typeof data === 'object' ? Object.keys(data).length : 0;
}

const isMain = process.argv[1]?.endsWith('seed-corridor-risk.mjs');

if (isMain) {
  runSeed('supply_chain', 'corridorrisk', CANONICAL_KEY, fetchAll, {
    validateFn,
    ttlSeconds: TTL,
    sourceVersion: 'corridor-risk',
    recordCount: (data) => Object.keys(data).length,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 120,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
