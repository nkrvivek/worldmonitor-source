import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { fetchInputData } from '../scripts/seed-correlation.mjs';

// Seeds write `{_seed, data}` in contract mode. seed-correlation reads its nine
// inputs through its own pipeline call rather than the shared redisGet, so it
// missed the unwrap the shared reader does, and every extraction below it
// (`.events`, `.quotes`, `.earthquakes`) looked at the envelope instead of the
// payload. Measured on the live database on 2026-08-03: six of the nine keys
// were present and the run still logged `flights=0 protests=0 outages=0
// quakes=0 markets=0` and wrote no cards.

const CREDENTIALS = { url: 'https://redis.example', token: 'not-a-real-token' };

function pipelineResponse(values: unknown[]): Response {
  return new Response(
    JSON.stringify(values.map((v) => ({ result: v == null ? null : JSON.stringify(v) }))),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** One entry per INPUT_KEYS slot, with `overrides` filled in by index. */
function slots(overrides: Record<number, unknown>): unknown[] {
  return Array.from({ length: 9 }, (_, i) => overrides[i] ?? null);
}

describe('seed-correlation input reads', () => {
  it('returns the payload for an enveloped value, not the envelope', async () => {
    const envelope = {
      _seed: { fetchedAt: 1_700_000_000_000, recordCount: 2, state: 'fresh' },
      data: { events: [{ id: 'a' }, { id: 'b' }] },
    };

    const data = await fetchInputData({
      credentials: CREDENTIALS,
      fetchImpl: async () => pipelineResponse(slots({ 2: envelope })),
    });

    assert.deepEqual(data['unrest:events:v1'], { events: [{ id: 'a' }, { id: 'b' }] });
  });

  it('passes a legacy bare value through unchanged', async () => {
    const bare = { quotes: [{ symbol: 'BTC' }] };

    const data = await fetchInputData({
      credentials: CREDENTIALS,
      fetchImpl: async () => pipelineResponse(slots({ 7: bare })),
    });

    assert.deepEqual(data['market:crypto:v1'], bare);
  });

  it('leaves a missing key out of the result', async () => {
    const data = await fetchInputData({
      credentials: CREDENTIALS,
      fetchImpl: async () => pipelineResponse(slots({})),
    });

    assert.deepEqual(Object.keys(data), []);
  });

  it('skips a value that is not JSON rather than throwing', async () => {
    const body = JSON.stringify([{ result: 'not json' }, ...Array(8).fill({ result: null })]);

    const data = await fetchInputData({
      credentials: CREDENTIALS,
      fetchImpl: async () =>
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    assert.deepEqual(Object.keys(data), []);
  });

  it('throws when Redis answers with an error status', async () => {
    await assert.rejects(
      fetchInputData({
        credentials: CREDENTIALS,
        fetchImpl: async () => new Response('nope', { status: 500 }),
      }),
      /HTTP 500/,
    );
  });
});
