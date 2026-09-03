// The negative-cache sentinel must never reach a seed script as data.
//
// `cachedFetchJson` in server/_shared/redis.ts writes the string '__WM_NEG__'
// when a builder returns nothing, so the next callers back off instead of
// re-running it. That is a server-side convention, and the server is the only
// reader that knows it. Seed scripts read the same keys through Redis
// directly, so the sentinel arrived as an ordinary truthy string.
//
// Measured 2026-08-19 in seed-insights: the sentinel sailed past `if (!digest)`
// and died three retries later on `Digest has no items (shape: string)`, which
// reported newsInsights as SEED_ERROR for 113 minutes and turned the Seed
// Freshness Monitor red. The real state was "upstream news had no items".
// seed-insights was fixed at its own call site. Every other seed reading a
// server-warmed key through `redisGet` had the same hole.
//
// A seed cannot act on a sentinel, so the shared reader reports it as absent.
// A caller that needs the distinction reads the raw value itself, which is what
// seed-insights does.

import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { readSeedSnapshot, verifySeedKey } = await import('../scripts/_seed-utils.mjs');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch(upstashResult) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ result: upstashResult == null ? null : JSON.stringify(upstashResult) }),
  });
}

test('readSeedSnapshot reads the negative-cache sentinel as absent, not as data', async () => {
  mockFetch('__WM_NEG__');
  assert.equal(await readSeedSnapshot('news:digest:v1'), null);
});

test('verifySeedKey reads the negative-cache sentinel as absent', async () => {
  mockFetch('__WM_NEG__');
  assert.equal(await verifySeedKey('news:digest:v1'), null);
});

test('a sentinel wrapped in a seed envelope is still absent', async () => {
  mockFetch({
    _seed: { fetchedAt: 1, recordCount: 0, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' },
    data: '__WM_NEG__',
  });
  assert.equal(await readSeedSnapshot('news:digest:v1'), null);
});

test('a string that merely contains the sentinel is real data', async () => {
  mockFetch('__WM_NEG__ was here');
  assert.equal(await readSeedSnapshot('news:digest:v1'), '__WM_NEG__ was here');
});

test('an ordinary payload is untouched', async () => {
  mockFetch({ items: [{ id: 1 }] });
  assert.deepEqual(await readSeedSnapshot('news:digest:v1'), { items: [{ id: 1 }] });
});

test('the sentinel literal matches the server that writes it', () => {
  // Three copies of one string across a .ts module and two .mjs scripts that
  // cannot import it. Pin them together so a rename on the writer side cannot
  // quietly turn a refusal back into a digest.
  const server = readFileSync('server/_shared/redis.ts', 'utf8');
  assert.match(server, /const NEG_SENTINEL = '__WM_NEG__';/);
  const seedUtils = readFileSync('scripts/_seed-utils.mjs', 'utf8');
  assert.match(seedUtils, /const NEG_SENTINEL = '__WM_NEG__';/);
});
