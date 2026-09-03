import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { AisRelayDO } from '../../worker/ais/relay-do';

// Every test that must not see another test's sequence number takes its own
// named instance. `singleton` is the name the production route uses, so the
// read-only tests share it deliberately.
function stub(name = 'singleton') {
  return env.AIS_RELAY.get(env.AIS_RELAY.idFromName(name));
}

describe('AisRelayDO snapshot path', () => {
  it('answers with an honest empty snapshot before any upstream connection', async () => {
    const response = await stub().fetch(new Request('https://relay.internal/snapshot'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: { connected: boolean; vessels: number };
      disruptions: unknown[];
      density: unknown[];
    };
    expect(body.status.connected).toBe(false);
    expect(body.status.vessels).toBe(0);
    expect(Array.isArray(body.disruptions)).toBe(true);
    expect(Array.isArray(body.density)).toBe(true);
  });

  it('omits candidateReports and tankerReports by default', async () => {
    const response = await stub().fetch(new Request('https://relay.internal/snapshot'));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.candidateReports).toBeUndefined();
    expect(body.tankerReports).toBeUndefined();
  });

  it('includes candidateReports when ?candidates=true', async () => {
    const response = await stub().fetch(new Request('https://relay.internal/snapshot?candidates=true'));
    const body = (await response.json()) as Record<string, unknown>;
    expect(Array.isArray(body.candidateReports)).toBe(true);
  });

  it('includes tankerReports when ?tankers=true, and accepts a bbox alongside', async () => {
    const response = await stub().fetch(
      new Request('https://relay.internal/snapshot?tankers=true&bbox=0,0,5,5'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Array.isArray(body.tankerReports)).toBe(true);
  });

  it('still answers 200 when the bbox is unparseable, ignoring it', async () => {
    const response = await stub().fetch(
      new Request('https://relay.internal/snapshot?tankers=true&bbox=not-a-box'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Array.isArray(body.tankerReports)).toBe(true);
  });

  it('increments sequence on each call', async () => {
    const target = stub('sequence-test');
    const first = (await (await target.fetch(new Request('https://relay.internal/snapshot'))).json()) as {
      sequence: number;
    };
    const second = (await (await target.fetch(new Request('https://relay.internal/snapshot'))).json()) as {
      sequence: number;
    };
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });

  it('404s any path other than /snapshot', async () => {
    const response = await stub('not-found-test').fetch(new Request('https://relay.internal/nope'));
    expect(response.status).toBe(404);
  });
});

describe('AisRelayDO alarm', () => {
  it('reschedules itself roughly ALARM_INTERVAL_MS in the future on every tick', async () => {
    await runInDurableObject(stub('alarm-reschedule'), async (instance: AisRelayDO, state) => {
      await instance.alarm();
      const alarmTime = await state.storage.getAlarm();
      expect(alarmTime).not.toBeNull();
      const delta = (alarmTime as number) - Date.now();
      // Generous slack for test-runner jitter; the point is "soon", not
      // "immediately" and not "never".
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThanOrEqual(30_000 + 5_000);
    });
  });

  it("always reschedules later, never lets the alarm go unset — the opposite of CounterDO's earliest-wins rule", async () => {
    await runInDurableObject(stub('alarm-always-reschedules'), async (instance: AisRelayDO, state) => {
      await state.storage.setAlarm(Date.now() + 1_000);
      await instance.alarm();
      const alarmTime = await state.storage.getAlarm();
      // CounterDO would never move this later than the 1_000ms it was already
      // set to. AisRelayDO always does, because its alarm has one recurring
      // purpose, not N independent deadlines.
      expect(alarmTime as number).toBeGreaterThan(Date.now() + 1_000 - 100);
    });
  });

  it('records an attempt and a reconnectAt when the upstream connect fails', async () => {
    await runInDurableObject(stub('alarm-backoff'), async (instance: AisRelayDO, state) => {
      const before = Date.now();
      await instance.alarm();
      // connectUpstream is a throwing stub until Task 6, so this is the
      // failure path every time.
      expect(await state.storage.get<number>('attempt')).toBe(1);
      expect(await state.storage.get<number>('reconnectAt')).toBeGreaterThanOrEqual(before);
    });
  });

  it('does not retry the connection before reconnectAt has passed', async () => {
    await runInDurableObject(stub('alarm-backoff-honoured'), async (instance: AisRelayDO, state) => {
      await state.storage.put('attempt', 5);
      await state.storage.put('reconnectAt', Date.now() + 600_000);
      await instance.alarm();
      // Untouched: the tick still ran (and still rescheduled itself), but it
      // left the backoff window alone instead of burning an attempt.
      expect(await state.storage.get<number>('attempt')).toBe(5);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});

/**
 * A real connect() reaches out to stream.aisstream.io, which no unit test
 * should do. These exercise the dispatch layer directly instead — the part of
 * Task 6 that is ported logic rather than platform plumbing — plus the
 * pre-connection contract that survives from Task 4.
 */
describe('AisRelayDO upstream message handling', () => {
  type Dispatcher = { dispatchUpstreamMessage(data: unknown): void };

  function positionReport(mmsi: string, lat: number, lon: number) {
    return {
      MessageType: 'PositionReport',
      MetaData: { MMSI: mmsi, ShipName: 'TEST VESSEL' },
      Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: 12, Cog: 90, TrueHeading: 90 } },
    };
  }

  it('reports connected: false until a socket actually opens', async () => {
    const response = await stub('pre-connect-status').fetch(
      new Request('https://relay.internal/snapshot'),
    );
    const body = (await response.json()) as { status: { connected: boolean } };
    expect(body.status.connected).toBe(false);
  });

  /**
   * The bug this guards: the subscribe frame used to be sent from an 'open'
   * listener, which never fires on a client socket taken from
   * `response.webSocket` -- that socket is already connected. AISStream then
   * sends nothing, because it sends nothing until it is subscribed. The relay
   * looked healthy (connected true) and carried no data.
   */
  it('sends the AISStream subscription as soon as the socket is accepted', async () => {
    await runInDurableObject(stub('subscribe-frame'), async (instance: AisRelayDO) => {
      const sent: string[] = [];
      let accepted = false;
      const fakeSocket = {
        readyState: 1,
        accept() {
          accepted = true;
        },
        send(payload: string) {
          sent.push(payload);
        },
        // Deliberately inert: nothing in this test dispatches an 'open' event,
        // which is the whole point.
        addEventListener() {},
        close() {},
      };

      const patched = instance as unknown as {
        env: { AISSTREAM_API_KEY?: string };
        connectUpstream(): Promise<void>;
      };
      const realFetch = globalThis.fetch;
      const realKey = patched.env.AISSTREAM_API_KEY;
      patched.env.AISSTREAM_API_KEY = 'test-key';
      globalThis.fetch = (async () => ({ webSocket: fakeSocket })) as unknown as typeof fetch;
      try {
        await patched.connectUpstream();
      } finally {
        globalThis.fetch = realFetch;
        patched.env.AISSTREAM_API_KEY = realKey;
      }

      expect(accepted).toBe(true);
      expect(sent).toHaveLength(1);
      const subscription = JSON.parse(sent[0] ?? '{}') as {
        APIKey: string;
        FilterMessageTypes: string[];
      };
      expect(subscription.APIKey).toBe('test-key');
      expect(subscription.FilterMessageTypes).toEqual(['PositionReport', 'ShipStaticData']);
    });
  });

  /**
   * The bug this guards: the message handler parsed string frames only and
   * counted everything else as dropped. AISStream sends its JSON over binary
   * frames, so in production every single message was dropped -- 5,276
   * received, 5,276 dropped, 0 vessels, measured 2026-08-04.
   */
  it('parses a binary PositionReport frame instead of dropping it', async () => {
    const target = stub('binary-frame');
    await runInDurableObject(target, async (instance: AisRelayDO) => {
      let onMessage: ((event: { data: unknown }) => void) | null = null;
      let binaryType: string | undefined;
      const fakeSocket = {
        readyState: 1,
        set binaryType(value: string) {
          binaryType = value;
        },
        get binaryType() {
          return binaryType ?? '';
        },
        accept() {
          // The relay must have asked for ArrayBuffer before this point;
          // afterwards the setting is ignored by the runtime.
          expect(binaryType).toBe('arraybuffer');
        },
        send() {},
        addEventListener(type: string, listener: (event: { data: unknown }) => void) {
          if (type === 'message') onMessage = listener;
        },
        close() {},
      };

      const patched = instance as unknown as {
        env: { AISSTREAM_API_KEY?: string };
        connectUpstream(): Promise<void>;
      };
      const realFetch = globalThis.fetch;
      const realKey = patched.env.AISSTREAM_API_KEY;
      patched.env.AISSTREAM_API_KEY = 'test-key';
      globalThis.fetch = (async () => ({ webSocket: fakeSocket })) as unknown as typeof fetch;
      try {
        await patched.connectUpstream();
      } finally {
        globalThis.fetch = realFetch;
        patched.env.AISSTREAM_API_KEY = realKey;
      }

      expect(onMessage).not.toBeNull();
      // Exactly how the frame arrives on the wire: UTF-8 bytes, not a string.
      const encoded = new TextEncoder().encode(JSON.stringify(positionReport('366777222', 3, 4)));
      onMessage!({ data: encoded.buffer });
    });

    const body = (await (
      await target.fetch(new Request('https://relay.internal/snapshot'))
    ).json()) as { status: { vessels: number; droppedMessages: number } };
    expect(body.status.vessels).toBe(1);
    expect(body.status.droppedMessages).toBe(0);
  });

  it('feeds a PositionReport into the vessel state', async () => {
    const target = stub('dispatch-position');
    await runInDurableObject(target, async (instance: AisRelayDO) => {
      (instance as unknown as Dispatcher).dispatchUpstreamMessage(positionReport('366123456', 26.5, 56.3));
    });
    const body = (await (
      await target.fetch(new Request('https://relay.internal/snapshot'))
    ).json()) as { status: { vessels: number } };
    expect(body.status.vessels).toBe(1);
  });

  it('ignores a message type the relay does not subscribe to', async () => {
    const target = stub('dispatch-unknown');
    await runInDurableObject(target, async (instance: AisRelayDO) => {
      const dispatch = instance as unknown as Dispatcher;
      dispatch.dispatchUpstreamMessage({ MessageType: 'AidsToNavigationReport', MetaData: { MMSI: '1' } });
      dispatch.dispatchUpstreamMessage({ nonsense: true });
      dispatch.dispatchUpstreamMessage(null);
    });
    const body = (await (
      await target.fetch(new Request('https://relay.internal/snapshot'))
    ).json()) as { status: { vessels: number } };
    expect(body.status.vessels).toBe(0);
  });

  it('applies ShipStaticData so a later position report carries the ship type', async () => {
    const target = stub('dispatch-static');
    await runInDurableObject(target, async (instance: AisRelayDO) => {
      const dispatch = instance as unknown as Dispatcher;
      dispatch.dispatchUpstreamMessage({
        MessageType: 'ShipStaticData',
        MetaData: { MMSI: '366999111', ShipName: 'TEST TANKER' },
        // 80-89 is the tanker band; classifyVesselType maps it to 'tanker'.
        Message: { ShipStaticData: { Type: 80, Name: 'TEST TANKER' } },
      });
      dispatch.dispatchUpstreamMessage(positionReport('366999111', 1, 1));
    });
    const body = (await (
      await target.fetch(new Request('https://relay.internal/snapshot?tankers=true'))
    ).json()) as { tankerReports: Array<{ mmsi: string }> };
    expect(body.tankerReports.map((r) => r.mmsi)).toContain('366999111');
  });
});
