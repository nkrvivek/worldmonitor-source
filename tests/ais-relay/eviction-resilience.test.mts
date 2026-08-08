import { describe, it, expect } from 'vitest';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { AisRelayDO } from '../../worker/ais/relay-do';

describe('AisRelayDO eviction resilience', () => {
  it('answers a snapshot request the same way after a simulated eviction', async () => {
    const stub = env.AIS_RELAY.get(env.AIS_RELAY.idFromName('eviction-test'));
    // The .json() is not decoration: an unread response body holds the DO's
    // output stream open, and evictDurableObject then waits on it forever
    // (measured — the test hangs to its timeout instead of failing).
    await (await stub.fetch(new Request('https://relay.internal/snapshot'))).json();

    // Force-close any open WebSocket and evict the instance, simulating the
    // 70-140s idle eviction the alarm cadence is designed to defer.
    await evictDurableObject(stub, { webSockets: 'close' });

    const after = (await (
      await stub.fetch(new Request('https://relay.internal/snapshot'))
    ).json()) as { status: { connected: boolean }; sequence: number };
    // A fresh instance starts with connected: false and re-establishes on its
    // next alarm tick — the deliberate "state does not persist" divergence
    // from CounterDO, not a bug. The assertion here is narrower and
    // load-bearing: the DO must still answer with a well-formed snapshot, not
    // throw or hang, immediately after an eviction.
    expect(after.status.connected).toBe(false);
    expect(typeof after.sequence).toBe('number');
  });

  it('keeps the reconnect backoff across an eviction, because it lives in storage', async () => {
    const stub = env.AIS_RELAY.get(env.AIS_RELAY.idFromName('eviction-backoff'));
    await runInDurableObject(stub, async (instance: AisRelayDO) => {
      // No API key in the test env, so the connect fails and the alarm writes
      // the first backoff window.
      await instance.alarm();
    });

    await evictDurableObject(stub, { webSockets: 'close' });

    await runInDurableObject(stub, async (_instance: AisRelayDO, state) => {
      // An in-memory attempt counter would read 0 on the fresh instance,
      // turning backoff into a tight retry loop against an upstream that is
      // already down.
      expect(await state.storage.get<number>('attempt')).toBe(1);
    });
  });
});
