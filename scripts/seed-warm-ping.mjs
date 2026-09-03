#!/usr/bin/env node
// Warms the six request-driven caches behind the gateway's relay allowlist.
//
// Ported to the container rail 2026-08-10. The Railway relay's 8-minute warm
// loop died with the relay; warm-ping.yml took over on a GitHub schedule, but
// GitHub crons skip — measured 2026-08-10: no tick from 00:38Z to 03:01Z, and
// riskScores (45-minute bound) went EMPTY inside the gap. Cloudflare crons
// fire dependably, so this seed carries the cadence and the workflow stays as
// a backup; the warms are idempotent so the overlap is harmless.
//
// The path list mirrors RELAY_WARM_PING_PATHS in server/gateway.ts and the
// curl list in .github/workflows/warm-ping.yml — change one, change all
// three. tests/warm-ping-mirror.test.mjs pins them together.

const RELAY_API_KEY = (process.env.WORLDMONITOR_RELAY_KEY || '').trim();
const API_BASE = process.env.API_BASE_URL || 'https://worldmonitor.sibt.ai';
const TIMEOUT_MS = 60_000;

// name -> [path, method]. The digest is a GET because seed-insights and the
// benchmark read it that way; the variant/lang pair names the exact cache key
// the benchmark starves without (news:digest:v1:full:en).
const WARM_TARGETS = [
  ['service-statuses', '/api/infrastructure/v1/list-service-statuses', 'POST'],
  ['cable-health', '/api/infrastructure/v1/get-cable-health', 'POST'],
  ['temporal-anomalies', '/api/infrastructure/v1/list-temporal-anomalies', 'POST'],
  ['risk-scores', '/api/intelligence/v1/get-risk-scores', 'POST'],
  ['chokepoint-status', '/api/supply-chain/v1/get-chokepoint-status', 'POST'],
  ['feed-digest', '/api/news/v1/list-feed-digest?variant=full&lang=en', 'GET'],
];

async function warm(name, path, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'X-WorldMonitor-Key': RELAY_API_KEY,
        'Content-Type': 'application/json',
      },
      body: method === 'POST' ? '{}' : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`[warm-ping] ${name}: OK`);
    return true;
  } catch (err) {
    console.error(`[warm-ping] ${name}: FAILED (${err?.message || err})`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!RELAY_API_KEY) {
    // The gateway fails closed without the key; a warm that silently no-ops
    // would read as healthy while every cache goes cold.
    console.error('[warm-ping] WORLDMONITOR_RELAY_KEY is not set — nothing to warm.');
    process.exit(1);
  }
  const results = await Promise.all(
    WARM_TARGETS.map(([name, path, method]) => warm(name, path, method)),
  );
  process.exit(results.every(Boolean) ? 0 : 1);
}

main();
