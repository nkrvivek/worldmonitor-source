import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mapWithConcurrency } from '../server/worldmonitor/news/v1/list-feed-digest';
import { VARIANT_FEEDS, INTEL_SOURCES } from '../server/worldmonitor/news/v1/_feeds';

const DIGEST_SRC = readFileSync(
  new URL('../server/worldmonitor/news/v1/list-feed-digest.ts', import.meta.url),
  'utf8',
);

// The full digest is the corpus seed-insights clusters. Production 2026-08-13:
// 118 of these were marked 'timeout' on every build, so the same tail of the
// list never reached the corpus and the brief had nothing corroborated to lead
// with. The count is here so a feed list that outgrows what the deadline can
// serve is a failing test rather than a silent truncation.
function fullDigestFeedCount(): number {
  const byCategory = VARIANT_FEEDS.full ?? {};
  const categoryFeeds = Object.values(byCategory).reduce((sum, feeds) => sum + feeds.length, 0);
  return categoryFeeds + INTEL_SOURCES.length;
}

describe('digest feed collection concurrency', () => {
  it('refills a slot when one frees, not at a batch boundary', async () => {
    const limit = 4;
    const started: number[] = [];
    let releaseStraggler: (() => void) | undefined;
    const stragglerHeld = new Promise<void>((resolve) => {
      releaseStraggler = resolve;
    });

    const run = mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      limit,
      async (index) => {
        started.push(index);
        if (index === 0) await stragglerHeld;
        return index;
      },
    );

    // Let every slot that can run without the straggler drain.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(
      started.includes(limit),
      `item ${limit} must start while item 0 is still in flight; started: ${started.join(',')}`,
    );

    releaseStraggler?.();
    const settled = await run;
    assert.equal(settled.length, 12);
    assert.equal(settled.filter((r) => r?.status === 'fulfilled').length, 12);
  });

  it('leaves a hole rather than a result for work that never ran', async () => {
    let stop = false;
    const settled = await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      2,
      async (index) => {
        if (index >= 3) stop = true;
        return index;
      },
      () => stop,
    );

    assert.equal(settled.length, 10);
    assert.ok(
      settled.some((entry) => entry === undefined),
      'a stopped run must leave holes so the caller can mark those feeds timeout',
    );
  });

  it('records a rejection instead of dropping the item', async () => {
    const settled = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('feed exploded');
      return n;
    });

    assert.equal(settled[1]?.status, 'rejected');
    assert.equal(settled[0]?.status, 'fulfilled');
    assert.equal(settled[2]?.status, 'fulfilled');
  });

  it('collects feeds through the pool, never fixed slices', () => {
    assert.match(
      DIGEST_SRC,
      /const settled = await mapWithConcurrency\(\s*allEntries,\s*FEED_CONCURRENCY,/,
      'buildDigest must collect feeds through the concurrency pool',
    );
    assert.doesNotMatch(
      DIGEST_SRC,
      /allEntries\.slice\(/,
      'slicing allEntries reintroduces the batch barrier that truncated the feed list',
    );
  });

  it('states how many feeds one build has to reach', () => {
    const feeds = fullDigestFeedCount();
    assert.ok(feeds > 200, `full digest feed count collapsed to ${feeds}`);
    assert.ok(
      feeds < 400,
      `full digest now asks for ${feeds} feeds in one build; the deadline was sized for ~222`,
    );
  });
});
