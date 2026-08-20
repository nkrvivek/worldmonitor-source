import { describe, it, expect } from 'vitest';
import {
  RUN_RECORD_KEY_PREFIX,
  writeStartFailureRecord,
} from '../../worker/seeds/run-record';

const creds = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example',
  UPSTASH_REDIS_REST_TOKEN: 'tok',
};

describe('writeStartFailureRecord', () => {
  it('writes a CONTAINER_START_FAILED record naming the script and the reason', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = await writeStartFailureRecord(
      creds,
      'scripts/seed-supply-chain-trade.mjs',
      new Error('no container instance available'),
      async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response('{}', { status: 200 });
      },
    );

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://redis.example');

    const body = JSON.parse(String(call.init.body));
    expect(body[0]).toBe('SET');
    expect(body[1]).toBe(`${RUN_RECORD_KEY_PREFIX}scripts/seed-supply-chain-trade.mjs`);
    expect(body[3]).toBe('EX');

    const record = JSON.parse(body[2]);
    expect(record.status).toBe('CONTAINER_START_FAILED');
    expect(record.script).toBe('scripts/seed-supply-chain-trade.mjs');
    expect(record.reason).toBe('no container instance available');
    expect(record.code).toBeNull();
    expect(typeof record.fetchedAt).toBe('number');
  });

  it('reports false rather than throwing when Redis rejects the write', async () => {
    const ok = await writeStartFailureRecord(
      creds,
      'scripts/seed-supply-chain-trade.mjs',
      new Error('boom'),
      async () => new Response('nope', { status: 500 }),
    );

    expect(ok).toBe(false);
  });

  it('reports false rather than throwing when the credentials are missing', async () => {
    let called = false;
    const ok = await writeStartFailureRecord(
      {},
      'scripts/seed-supply-chain-trade.mjs',
      new Error('boom'),
      async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    );

    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  it('reports false rather than throwing when fetch itself rejects', async () => {
    const ok = await writeStartFailureRecord(
      creds,
      'scripts/seed-supply-chain-trade.mjs',
      new Error('boom'),
      async () => {
        throw new Error('network down');
      },
    );

    expect(ok).toBe(false);
  });
});
