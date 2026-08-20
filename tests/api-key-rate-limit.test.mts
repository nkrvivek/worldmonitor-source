// U3 (#3199) — per-account rate-limit module. Pipeline + UTC math tested in
// isolation with an injected mock pipeline + injected Date (no live Redis).
// Per the plan, Upstash's sliding-window math is NOT re-tested here — only our
// meter/ceiling logic and fail-open posture.
//
// Constants mirrored from the module so a prod drift fails by name rather than
// silently (matches tests/mcp-quota-concurrent.test.mjs discipline).
const STARTER_ALLOWANCE = 1000;
// CEILING_MULTIPLIER is deliberately absent: #4635 made the sold allowance the
// hard limit and deleted the 10x safety ceiling these tests used to assert on.
const API_DAILY_NAMESPACE = 'rl:apikey:day'; // server/_shared/api-key-rate-limit.ts
const API_DAILY_TTL_SECONDS = 172_800; // server/_shared/api-key-rate-limit.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiKeyDailyKey,
  reserveDailyMeter,
  rateLimitHeaders,
  checkBurst,
  ENTERPRISE_API_RATE_LIMIT,
} from '../server/_shared/api-key-rate-limit.ts';
import { dailyMeterShardName } from '../worker/counters/daily-meter.ts';

// A mock pipeline that simulates an INCR/DECR counter, recording every command.
function makePipeline(initial = 0) {
  let count = initial;
  const commands: Array<Array<string | number>>[] = [];
  const pipeline = async (cmds: Array<Array<string | number>>) => {
    commands.push(cmds);
    return cmds.map((cmd) => {
      const verb = cmd[0];
      if (verb === 'INCR') return { result: (count += 1) };
      if (verb === 'DECR') return { result: (count -= 1) };
      return { result: 1 }; // EXPIRE etc.
    });
  };
  return {
    pipeline,
    commands,
    current: () => count,
  };
}

const D = (y: number, mo: number, d: number, h = 12) =>
  new Date(Date.UTC(y, mo, d, h, 0, 0));

describe('#3199 U3 — apiKeyDailyKey (UTC calendar day)', () => {
  it('formats a plain (un-prefixed) UTC-day key', () => {
    assert.equal(apiKeyDailyKey('user_1', D(2026, 5, 30)), 'rl:apikey:day:user_1:2026-06-30');
  });

  it('rolls over at UTC midnight, not before', () => {
    assert.equal(apiKeyDailyKey('u', new Date(Date.UTC(2026, 5, 30, 23, 59, 59))).endsWith('2026-06-30'), true);
    assert.equal(apiKeyDailyKey('u', new Date(Date.UTC(2026, 6, 1, 0, 0, 0))).endsWith('2026-07-01'), true);
  });

  it('returns empty for a missing userId', () => {
    assert.equal(apiKeyDailyKey(''), '');
  });
});

describe('#3199 U3 — reserveDailyMeter', () => {
  it('under the allowance: meters, does not flag, no rollback', async () => {
    const mock = makePipeline(500); // next INCR -> 501, under the 1000 allowance
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: mock.pipeline });
    assert.equal(r.count, 501);
    assert.equal(r.overLimit, false);
    assert.equal(r.metered, true);
    // INCR+EXPIRE issued, no DECR.
    assert.equal(mock.commands.length, 1);
  });

  it('over the sold allowance: flags, and rollback() floors the counter', async () => {
    const mock = makePipeline(STARTER_ALLOWANCE); // 1000 -> INCR 1001
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: mock.pipeline });
    assert.equal(r.count, 1001);
    assert.equal(r.overLimit, true);
    await r.rollback();
    assert.equal(mock.current(), 1000, 'rollback DECRs the over-limit increment');
    // rollback is idempotent
    await r.rollback();
    assert.equal(mock.current(), 1000);
  });

  it('exactly at the allowance is allowed (only strictly-over rejects)', async () => {
    const mock = makePipeline(STARTER_ALLOWANCE - 1); // -> 1000
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: mock.pipeline });
    assert.equal(r.count, 1000);
    assert.equal(r.overLimit, false);
  });

  it('unlimited allowance (-1): never touches Redis, never over-limits', async () => {
    const mock = makePipeline(999999);
    const r = await reserveDailyMeter({ userId: 'ent', allowance: -1, pipeline: mock.pipeline });
    assert.equal(r.metered, false);
    assert.equal(r.overLimit, false);
    assert.equal(mock.commands.length, 0, 'no pipeline call for unlimited');
  });

  it('allowance 0 (misconfig): fails open, never meters or ceilings (no brick)', async () => {
    const mock = makePipeline(0);
    const r = await reserveDailyMeter({ userId: 'u', allowance: 0, pipeline: mock.pipeline });
    assert.equal(r.metered, false);
    assert.equal(r.overLimit, false);
    assert.equal(mock.commands.length, 0, 'allowance 0 must not ceiling-429 request #1');
  });

  it('fail-open when Redis returns empty (outage): metered:false, served', async () => {
    const downPipeline = async () => [];
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: downPipeline });
    assert.equal(r.metered, false);
    assert.equal(r.overLimit, false);
  });

  it('fail-open when the pipeline throws', async () => {
    const throwingPipeline = async () => {
      throw new Error('redis exploded');
    };
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: throwingPipeline });
    assert.equal(r.metered, false);
    assert.equal(r.overLimit, false);
  });

  it('per-account: the metered key is the userId-scoped daily key', async () => {
    const mock = makePipeline(0);
    const date = D(2026, 5, 30);
    await reserveDailyMeter({ userId: 'acct_42', allowance: STARTER_ALLOWANCE, pipeline: mock.pipeline, date });
    const incrCmd = mock.commands[0][0];
    assert.deepEqual(incrCmd, ['INCR', apiKeyDailyKey('acct_42', date)]);
  });

  it('retryAfterSec points at the next UTC midnight', async () => {
    const date = new Date(Date.UTC(2026, 5, 30, 23, 0, 0)); // 1h before midnight
    const r = await reserveDailyMeter({ userId: 'u', allowance: STARTER_ALLOWANCE, pipeline: makePipeline(0).pipeline, date });
    assert.equal(r.retryAfterSec, 3600);
  });
});

// Fake DO stub for the CounterDO path (#cf-ratelimit-do task 6b). Records
// which shard name idFromName() was asked for and the exact request body
// fetch() received, then replies with a canned CounterResponse — same style
// as makePipeline() above, no live Durable Object involved.
function makeCounterBinding(canned: {
  op: 'daily';
  allowed: boolean;
  metered: boolean;
  count: number;
  overCeiling: boolean;
}) {
  const idsRequested: string[] = [];
  const requestBodies: unknown[] = [];
  const binding = {
    idFromName(name: string) {
      idsRequested.push(name);
      return { name };
    },
    get(_id: unknown) {
      return {
        async fetch(request: Request) {
          requestBodies.push(JSON.parse(await request.text()));
          return new Response(JSON.stringify(canned), { status: 200 });
        },
      };
    },
  };
  return { binding, idsRequested, requestBodies };
}

describe('#3199 U3 — reserveDailyMeter (CounterDO path, #cf-ratelimit-do task 6b)', () => {
  it('targets the shard from dailyMeterShardName and posts the daily op verbatim', async () => {
    const { binding, idsRequested, requestBodies } = makeCounterBinding({
      op: 'daily', allowed: true, metered: true, count: 42, overCeiling: false,
    });
    const r = await reserveDailyMeter({
      userId: 'acct_9',
      allowance: STARTER_ALLOWANCE,
      pipeline: async () => { throw new Error('must not touch Redis when a counter binding is passed'); },
      counter: binding,
    });
    assert.deepEqual(idsRequested, [dailyMeterShardName(API_DAILY_NAMESPACE, 'acct_9')],
      'writer must ask for the same shard the reader computes, never a hand-built string');
    assert.deepEqual(requestBodies, [{
      op: 'daily',
      namespace: API_DAILY_NAMESPACE,
      userId: 'acct_9',
      allowance: STARTER_ALLOWANCE,
      ttlSeconds: API_DAILY_TTL_SECONDS,
      posture: 'allow',
    }]);
    assert.equal(r.count, 42);
    assert.equal(r.metered, true);
    assert.equal(r.overLimit, false);
  });

  it('the cap rides on count vs the SOLD allowance, not on the DO\'s own overCeiling', async () => {
    // #4635 made the sold allowance the hard limit and dropped the 10x safety
    // ceiling, renaming MeterResult.overCeiling to overLimit. The DO still
    // reports its own `overCeiling` on the wire (count > allowance *
    // ceilingMultiplier, worker/counters/daily-meter.ts), so the canned
    // response below keeps that field — but this leg must NOT forward it.
    //
    // The canned values are the exact shape that catches the bug: 1001 is one
    // over the sold allowance of 1000, while the DO's 10x band (10_000) is
    // untouched, so it answers overCeiling:false. A writer that mapped
    // `overLimit: response.overCeiling` would let this account serve 10x its
    // plan through the DO backend while the Redis leg rejected it at 1x.
    // posture:'allow' also means allowed stays true either way, so `allowed`
    // can never be the cap signal.
    const { binding } = makeCounterBinding({
      op: 'daily', allowed: true, metered: true, count: STARTER_ALLOWANCE + 1, overCeiling: false,
    });
    const r = await reserveDailyMeter({
      userId: 'acct_over',
      allowance: STARTER_ALLOWANCE,
      pipeline: async () => { throw new Error('must not touch Redis'); },
      counter: binding,
    });
    assert.equal(r.count, STARTER_ALLOWANCE + 1);
    assert.equal(r.overLimit, true);
    assert.equal(r.metered, true);
  });

  it('rollback() posts a daily-rollback op to the same shard, and is idempotent', async () => {
    const rollbackBodies: unknown[] = [];
    const idsRequested: string[] = [];
    const binding = {
      idFromName(name: string) {
        idsRequested.push(name);
        return { name };
      },
      get(_id: unknown) {
        return {
          async fetch(request: Request) {
            const body = JSON.parse(await request.text());
            if (body.op === 'daily-rollback') {
              rollbackBodies.push(body);
              return new Response(JSON.stringify({ op: 'daily-rollback', ok: true }), { status: 200 });
            }
            return new Response(
              JSON.stringify({ op: 'daily', allowed: true, metered: true, count: 10_001, overCeiling: true }),
              { status: 200 },
            );
          },
        };
      },
    };
    const r = await reserveDailyMeter({
      userId: 'acct_rb',
      allowance: STARTER_ALLOWANCE,
      pipeline: async () => { throw new Error('must not touch Redis'); },
      counter: binding,
    });
    await r.rollback();
    await r.rollback(); // idempotent — second call must not double-POST
    assert.equal(rollbackBodies.length, 1);
    assert.deepEqual(rollbackBodies[0], {
      op: 'daily-rollback',
      namespace: API_DAILY_NAMESPACE,
      userId: 'acct_rb',
    });
    assert.equal(idsRequested.every((n) => n === dailyMeterShardName(API_DAILY_NAMESPACE, 'acct_rb')), true,
      'the daily call and the rollback call must land on the same DO instance');
  });

  it('fails open (metered:false, overLimit:false) when the DO stub throws', async () => {
    const binding = {
      idFromName(name: string) { return { name }; },
      get(_id: unknown) {
        return {
          async fetch(): Promise<Response> {
            throw new Error('DO unreachable');
          },
        };
      },
    };
    const r = await reserveDailyMeter({
      userId: 'acct_down',
      allowance: STARTER_ALLOWANCE,
      pipeline: async () => { throw new Error('must not touch Redis'); },
      counter: binding,
    });
    assert.equal(r.metered, false);
    assert.equal(r.overLimit, false);
    assert.equal(r.count, 0);
  });
});

describe('#3199 U3 — burst limiter fail-open + headers', () => {
  it('checkBurst fails open (ok:true) when Upstash is not configured', async () => {
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      const r = await checkBurst(60, 'acct_1');
      assert.deepEqual(r, { ok: true });
    } finally {
      if (prevUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = prevUrl;
      if (prevToken !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = prevToken;
    }
  });

  it('rateLimitHeaders emits the standard X-RateLimit-* + Retry-After set', () => {
    const h = rateLimitHeaders({ limit: 60, remaining: 0, resetMs: 1_900_000_000_000, retryAfterSec: 42 });
    assert.equal(h['X-RateLimit-Limit'], '60');
    assert.equal(h['X-RateLimit-Remaining'], '0');
    assert.equal(h['X-RateLimit-Reset'], '1900000000000');
    assert.equal(h['Retry-After'], '42');
  });

  it('rateLimitHeaders emits IETF RateLimit fields with a delta-seconds reset', () => {
    const now = Date.now();
    const h = rateLimitHeaders({ limit: 60, remaining: 7, resetMs: now + 30_000, retryAfterSec: 30, windowSec: 60 });
    // RateLimit-Policy advertises the quota + window (structured-field syntax).
    assert.equal(h['RateLimit-Policy'], '"default";q=60;w=60');
    assert.equal(h['RateLimit-Limit'], '60');
    assert.equal(h['RateLimit-Remaining'], '7');
    // IETF reset is DELTA-seconds (~30), not the epoch-ms carried by X-RateLimit-Reset.
    const resetSec = Number(h['RateLimit-Reset']);
    assert.ok(resetSec >= 29 && resetSec <= 31, `RateLimit-Reset should be ~30s, got ${resetSec}`);
    assert.equal(h.RateLimit, `"default";r=7;t=${resetSec}`);
  });

  it('rateLimitHeaders defaults the advertised window to 60s', () => {
    const h = rateLimitHeaders({ limit: 600, remaining: 0, resetMs: Date.now() + 1000, retryAfterSec: 1 });
    assert.equal(h['RateLimit-Policy'], '"default";q=600;w=60');
  });

  it('Retry-After floors at 1 second', () => {
    assert.equal(rateLimitHeaders({ limit: 60, remaining: 0, resetMs: 0, retryAfterSec: 0 })['Retry-After'], '1');
  });

  it('enterprise per-minute constant matches the catalog (1000)', () => {
    assert.equal(ENTERPRISE_API_RATE_LIMIT, 1000);
  });
});
