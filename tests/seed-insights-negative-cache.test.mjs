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
