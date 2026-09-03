import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DIGEST_NEGATIVE_CACHED,
  INSIGHTS_SYNTHESIS_FAILURE_CODES,
  interpretDigestPayload,
} from '../scripts/seed-insights.mjs';

// The failure this file exists to stop: on 2026-08-19 seed-insights.mjs failed
// three retries with `Digest has no items (shape: string)` and reported
// newsInsights as SEED_ERROR for 113 minutes. The string was cachedFetchJson's
// negative sentinel, which the seed reads straight out of Redis without ever
// passing through the one function that knows what it means.

test('the negative sentinel reads as its own state, not as a digest', () => {
  assert.equal(interpretDigestPayload('__WM_NEG__'), DIGEST_NEGATIVE_CACHED);
});

test('a real digest survives, enveloped or bare', () => {
  const digest = { categories: { politics: { items: [{ title: 'x' }] } } };
  assert.deepEqual(interpretDigestPayload(digest), digest);
  assert.deepEqual(
    interpretDigestPayload({ _seed: { fetchedAt: 1 }, data: digest }),
    digest,
  );
});

test('absence and any other scalar both read as nothing', () => {
  // Each of these used to reach the shape check and fail the whole seed. None
  // of them is a digest, and none of them is worth a SEED_ERROR.
  for (const raw of [null, undefined, '', 'some other string', 7, true]) {
    assert.equal(interpretDigestPayload(raw), null, `raw: ${JSON.stringify(raw)}`);
  }
});

test('a negative-cached digest has a failure code of its own', () => {
  // DIGEST_MISSING means the warm path is broken and is ours to fix.
  // Negative-cached means upstream had no items. Reporting one as the other
  // sends the reader to the wrong system.
  assert.notEqual(
    INSIGHTS_SYNTHESIS_FAILURE_CODES.DIGEST_NEGATIVE_CACHED,
    INSIGHTS_SYNTHESIS_FAILURE_CODES.DIGEST_MISSING,
  );
});

test('the sentinel string still matches the one the server writes', () => {
  // seed-insights.mjs cannot import the TypeScript server module, so it carries
  // its own copy. This is the seam that keeps the copy honest: change
  // NEG_SENTINEL in server/_shared/redis.ts and this fails rather than the
  // seeds silently going back to treating a refusal as a digest.
  // Resolved off this file rather than the cwd, so the guard holds whichever
  // directory the runner starts in.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const rel of ['server/_shared/redis.ts', 'scripts/seed-insights.mjs']) {
    const source = readFileSync(join(repoRoot, rel), 'utf8');
    assert.match(source, /const NEG_SENTINEL = '__WM_NEG__';/, rel);
  }
});

// ── retrying a negative build instead of reporting it ────────────────────────
//
// Measured 2026-08-26, in two rounds. Round one: five ticks (01:42, 04:38,
// 05:08, 05:38, 06:08Z) each warmed the digest, got nothing, and read back a
// sentinel — while manual runs at 01:46Z and 05:16Z, MINUTES later, got 233
// and 74 items. Those successes landed inside the 300s per-feed empty window,
// which disproves the first theory (that the per-feed CACHE_TTL_EMPTY_S
// caches had to lapse). Round two: a single 330s-wait retry shipped on that
// theory and failed its first live trial — the retry hit a cold isolate and
// timed out exactly like the first read.
//
// The real mechanism: a COLD build exceeds DIGEST_RESPONSE_TIMEOUT_MS (14s),
// cachedFetchJson arms a 30s error sentinel, and the build's late result is
// discarded; a request ~a minute later rides the now-warm isolate and builds
// in ~12s (measured 07:47Z empty → 07:48Z 12 categories, 11.7s). A build that
// COMPLETES with zero items arms the 120s sentinel instead. So the retry
// ladder is [45s, 135s]: the first clears the 30s error TTL while the isolate
// is still warm; the second clears the 120s completed-empty sentinel. Three
// negatives across ~3 minutes is a real outage and still reports.

test('a negative first read climbs the retry ladder to a digest', async () => {
  const { DIGEST_NEGATIVE_RETRY_WAITS_MS, readDigestRetryingNegative } =
    await import('../scripts/seed-insights.mjs');
  const digest = { categories: { politics: { items: [{ title: 'x' }] } } };
  const reads = [DIGEST_NEGATIVE_CACHED, digest];
  const slept = [];
  const result = await readDigestRetryingNegative(
    async () => reads.shift(),
    { sleep: async (ms) => { slept.push(ms); } },
  );
  assert.deepEqual(result, digest);
  assert.deepEqual(slept, [DIGEST_NEGATIVE_RETRY_WAITS_MS[0]]);
});

test('a second negative still gets the longer second retry', async () => {
  const { DIGEST_NEGATIVE_RETRY_WAITS_MS, readDigestRetryingNegative } =
    await import('../scripts/seed-insights.mjs');
  const digest = { categories: { politics: { items: [{ title: 'x' }] } } };
  const reads = [DIGEST_NEGATIVE_CACHED, DIGEST_NEGATIVE_CACHED, digest];
  const slept = [];
  const result = await readDigestRetryingNegative(
    async () => reads.shift(),
    { sleep: async (ms) => { slept.push(ms); } },
  );
  assert.deepEqual(result, digest);
  assert.deepEqual(slept, DIGEST_NEGATIVE_RETRY_WAITS_MS);
});

test('negatives past the end of the ladder read as negative-cached', async () => {
  const { DIGEST_NEGATIVE_RETRY_WAITS_MS, readDigestRetryingNegative } =
    await import('../scripts/seed-insights.mjs');
  let calls = 0;
  const result = await readDigestRetryingNegative(
    async () => { calls += 1; return DIGEST_NEGATIVE_CACHED; },
    { sleep: async () => {} },
  );
  assert.equal(result, DIGEST_NEGATIVE_CACHED);
  assert.equal(calls, 1 + DIGEST_NEGATIVE_RETRY_WAITS_MS.length,
    'one read per rung plus the first, never a loop');
});

test('a first read that succeeds never sleeps', async () => {
  const { readDigestRetryingNegative } = await import('../scripts/seed-insights.mjs');
  const digest = { categories: {} };
  const slept = [];
  const result = await readDigestRetryingNegative(
    async () => digest,
    { sleep: async (ms) => { slept.push(ms); } },
  );
  assert.equal(result, digest);
  assert.deepEqual(slept, []);
});

test('the ladder is sized against the sentinels it must outlive', async () => {
  const { DIGEST_NEGATIVE_RETRY_WAITS_MS } = await import('../scripts/seed-insights.mjs');
  const [first, ...rest] = DIGEST_NEGATIVE_RETRY_WAITS_MS;
  // First rung: past the 30s fetch-error sentinel, but soon enough that the
  // isolate the failed build warmed is still warm.
  assert.ok(first > 30_000 && first < 120_000);
  // Full ladder: past the 120s completed-empty sentinel.
  const total = DIGEST_NEGATIVE_RETRY_WAITS_MS.reduce((a, b) => a + b, 0);
  assert.ok(total > 120_000);
  assert.ok(rest.length >= 1, 'one rung cannot clear both sentinel kinds');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const redis = readFileSync(join(repoRoot, 'server/_shared/redis.ts'), 'utf8');
  assert.match(redis, /const FETCH_ERROR_NEGATIVE_TTL_SECONDS = 30;/,
    'the 30s the first rung is sized against moved — re-derive the ladder');
  const gateway = readFileSync(
    join(repoRoot, 'server/worldmonitor/news/v1/list-feed-digest.ts'), 'utf8');
  assert.match(gateway, /const DIGEST_RESPONSE_TIMEOUT_MS = 14_000;/,
    'the cold-build timeout the ladder works around moved — re-derive');
});

test('fetchInsights routes the en digest through the retry', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(repoRoot, 'scripts/seed-insights.mjs'), 'utf8');
  assert.match(source, /readDigestRetryingNegative\(\s*\(\)\s*=>\s*readOrWarmDigest\('en'\)/);
});

// ── the fetch deadline must leave room for the retry wait ──
//
// Measured 2026-08-26: the first shipped retry never ran. runSeed's fetch
// phase defaults to lockTtlMs (120s) + 120s margin = 240s, and the 330s wait
// blew that deadline: "news:insights fetch phase exceeded 240000ms deadline".
// The wait cannot shrink below the 300s per-feed empty caches, so the lock
// and deadline grow instead.

test('the insights lock outlives the whole ladder plus a full fetch budget', async () => {
  const { INSIGHTS_LOCK_TTL_MS, DIGEST_NEGATIVE_RETRY_WAITS_MS } =
    await import('../scripts/seed-insights.mjs');
  // ladder + the old 240s full-fetch budget: digest polls around every rung
  // plus LLM synthesis must all fit before the lock lapses.
  const total = DIGEST_NEGATIVE_RETRY_WAITS_MS.reduce((a, b) => a + b, 0);
  assert.ok(INSIGHTS_LOCK_TTL_MS >= total + 240_000);
});

test('runSeed for insights is given the raised lock TTL', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(repoRoot, 'scripts/seed-insights.mjs'), 'utf8');
  assert.match(source, /lockTtlMs:\s*INSIGHTS_LOCK_TTL_MS/,
    'the raised TTL must reach runSeed, not just be exported');
});
