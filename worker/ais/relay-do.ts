import { DurableObject } from 'cloudflare:workers';
import {
  createRelayState,
  cleanupAggregates,
  parseBbox,
  processPositionReport,
  processShipStaticData,
  type RelayState,
} from './vessel-state';
import { buildSnapshotResponse } from './snapshot-contract';
import { buildTransitsResponse } from './transits-contract';
import { computeBackoffMs, MAX_BACKOFF_ATTEMPT } from './backoff';

/** A snapshot is never served against state that has never been swept. */
const CLEANUP_MIN_INTERVAL_MS = 60_000;

/**
 * A non-hibernateable DO with an open outbound WebSocket gets its eviction
 * deferred only until the connection closes AND the normal 70-140s idle window
 * elapses -- and that deferral itself caps out at 15 minutes (Cloudflare's
 * Durable Object Lifecycle docs, "outbound TCP sockets and outbound
 * WebSockets" section). 30s gives a 2-4x safety margin under the lower bound
 * of that window, so this DO's own activity keeps it resident even if the
 * upstream connection briefly went quiet.
 */
const ALARM_INTERVAL_MS = 30_000;

/**
 * The AISStream subscription covers the whole globe; thousands of vessels
 * broadcast every 2-10 seconds. Two full minutes of total silence while the
 * socket still reports OPEN is unambiguous evidence of a stalled connection,
 * not a quiet moment -- distinct from the per-vessel GAP_THRESHOLD (1 hour) in
 * vessel-state.ts, which detects a single dark ship, not a dead feed.
 */
const STALL_THRESHOLD_MS = 120_000;

/**
 * https, not wss. workerd's fetch() rejects the wss: scheme outright --
 * measured, not assumed: `fetch('wss://127.0.0.1:1/x')` fails with "Fetch API
 * cannot load: wss://127.0.0.1:1/x" while the same URL on https gets as far as
 * the network. The Upgrade header, not the scheme, is what makes this a
 * WebSocket handshake.
 */
const AISSTREAM_URL = 'https://stream.aisstream.io/v0/stream';

/** Module scope, not per-message: a TextDecoder is reusable and stateless here. */
const FRAME_DECODER = new TextDecoder();

/**
 * Resolves a WebSocket frame to the JSON text inside it, or null when the frame
 * is neither text nor bytes. Nothing here awaits, because a WebSocket message
 * listener cannot -- which is why connectUpstream() asks for ArrayBuffer rather
 * than accepting the Blob that binary frames now arrive as by default.
 */
function frameToText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return FRAME_DECODER.decode(data);
  if (ArrayBuffer.isView(data)) return FRAME_DECODER.decode(data);
  return null;
}

/**
 * The AIS relay, as one Durable Object.
 *
 * Single-threaded per instance -- unlike the original Node process there is no
 * concurrent access to guard, so all the state below is plain in-memory data
 * with no locks. It does NOT survive eviction; only the reconnect bookkeeping
 * on this.ctx.storage does. Re-populating from live broadcasts takes seconds
 * and costs nothing, while persisting a cache that turns over every 2-10
 * seconds would cost a storage write per message.
 *
 * Parameterized with Cloudflare.Env rather than left bare so `this.env`
 * resolves to the real binding types instead of `unknown`.
 */
export class AisRelayDO extends DurableObject<Cloudflare.Env> {
  private state: RelayState = createRelayState();
  private sequence = 0;
  private lastCleanupAt = 0;
  private socket: WebSocket | null = null;
  private lastMessageAt = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/snapshot') {
      // Idempotent: connectUpstream() no-ops when a socket is already open.
      // A failure here is expected and non-fatal -- maybeReconnect() and its
      // stored backoff window are the reconnect authority. This call is only
      // an eager first attempt, so a cold DO does not sit disconnected for a
      // full ALARM_INTERVAL_MS before its first connection.
      await this.connectUpstream().catch(() => {});
      // Arm the alarm if this is the first request this instance has served.
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }
      return this.handleSnapshot(url);
    }
    if (url.pathname === '/transits') {
      // Same eager-connect and alarm-arming as /snapshot. The transit counts
      // come from the same live feed, and a cron-driven seed run may well be
      // the first request a cold instance sees.
      await this.connectUpstream().catch(() => {});
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }
      return this.handleTransits();
    }
    return new Response('not found', { status: 404 });
  }

  /**
   * Per-chokepoint crossing counts over the last 24 hours.
   *
   * Does not bump `this.sequence` -- that counter numbers snapshots for the
   * consumer that tracks them, and a transit read is not a snapshot.
   */
  private handleTransits(): Response {
    const now = Date.now();
    if (now - this.lastCleanupAt > CLEANUP_MIN_INTERVAL_MS) {
      cleanupAggregates(this.state, now);
      this.lastCleanupAt = now;
    }
    return Response.json(buildTransitsResponse(this.state, now, this.isSocketOpen()));
  }

  /**
   * Answers even before an upstream connection exists. An empty snapshot with
   * `connected: false` is the honest answer there, not an error: the consumer
   * discards a snapshot whose `disruptions`/`density` are not arrays, so a 500
   * and an empty-but-well-formed body degrade the same way at the caller,
   * while the empty body still carries the status fields that say why.
   */
  private handleSnapshot(url: URL): Response {
    const now = Date.now();
    // Throttled to once a minute, not once per message. The alarm is the
    // primary driver of cleanupAggregates(); this call only guarantees the
    // sweep has run at least once, matching the original script's
    // clean-on-demand behaviour in buildSnapshot().
    if (now - this.lastCleanupAt > CLEANUP_MIN_INTERVAL_MS) {
      cleanupAggregates(this.state, now);
      this.lastCleanupAt = now;
    }

    this.sequence += 1;

    // An unparseable bbox is ignored rather than rejected: it is an optional
    // narrowing filter, and the consumer treats any non-200 as a total relay
    // failure and serves its stale cache instead.
    const bbox = parseBbox(url.searchParams.get('bbox'));

    return Response.json(
      buildSnapshotResponse(
        this.state,
        this.sequence,
        url.searchParams.get('candidates') === 'true',
        url.searchParams.get('tankers') === 'true',
        bbox,
        this.isSocketOpen(),
      ),
    );
  }

  /**
   * One alarm, three jobs: it sweeps the aggregates, it keeps this DO resident
   * (the tick itself is the activity that defers eviction), and it owns
   * reconnecting to the upstream feed.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    cleanupAggregates(this.state, now);
    this.lastCleanupAt = now;

    if (!this.isSocketOpen()) {
      await this.maybeReconnect(now);
    } else if (now - this.lastMessageAt > STALL_THRESHOLD_MS) {
      // Stalled: total silence for two minutes on a socket that still claims
      // OPEN. Force a reconnect rather than waiting indefinitely.
      this.socket?.close(1000, 'stalled');
      this.socket = null;
      await this.maybeReconnect(now);
    }

    // Always reschedule ALARM_INTERVAL_MS out, unconditionally. CounterDO only
    // ever moves its alarm earlier, because it covers N independent per-key
    // deadlines and moving it later would starve the soonest. This alarm has
    // one recurring purpose, so the same cadence every tick is the right rule.
    await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
  }

  /**
   * The backoff window lives in storage, not in a field: a DO can be evicted
   * between a failed connect and the next tick, and an in-memory counter would
   * reset to zero every time -- turning backoff into a tight retry loop
   * against an upstream that is already down.
   */
  private async maybeReconnect(now: number): Promise<void> {
    const reconnectAt = (await this.ctx.storage.get<number>('reconnectAt')) ?? 0;
    if (now < reconnectAt) return;

    const attempt = (await this.ctx.storage.get<number>('attempt')) ?? 0;
    try {
      await this.connectUpstream();
      await this.ctx.storage.put('attempt', 0);
    } catch {
      const nextAttempt = Math.min(attempt + 1, MAX_BACKOFF_ATTEMPT);
      await this.ctx.storage.put('attempt', nextAttempt);
      await this.ctx.storage.put('reconnectAt', now + computeBackoffMs(nextAttempt));
    }
  }

  /**
   * WebSocket.OPEN, not workerd's WebSocket.READY_STATE_OPEN alias: both are 1
   * at runtime, but only the standard name is on the generated type.
   */
  private isSocketOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Connects OUT to AISStream. This is a client connection, so it is fetch()
   * with an Upgrade header and `response.webSocket`, not the WebSocketPair
   * shape a Worker uses when it accepts an inbound connection.
   */
  private async connectUpstream(): Promise<void> {
    if (this.isSocketOpen()) return;

    const apiKey = this.env.AISSTREAM_API_KEY;
    if (!apiKey) throw new Error('AISSTREAM_API_KEY is not configured');

    const resp = await fetch(AISSTREAM_URL, { headers: { Upgrade: 'websocket' } });
    const ws = resp.webSocket;
    if (!ws) throw new Error(`AISStream upgrade failed: ${resp.status}`);
    // Must be set before accept(), and it decides whether this relay carries
    // any data at all. AISStream sends its JSON as binary frames. Since
    // compatibility date 2026-03-17 those arrive as Blob, whose only readers
    // are async, and a WebSocket message listener has nowhere to await them.
    // Asking for ArrayBuffer instead keeps the decode synchronous. Measured in
    // production 2026-08-04 before this line existed: 167 messages received,
    // 167 dropped, 0 vessels.
    ws.binaryType = 'arraybuffer';
    ws.accept();

    // The subscribe frame goes out here, not from an 'open' listener. A client
    // socket taken from `response.webSocket` is already connected -- the 101
    // response IS the handshake -- so no 'open' event ever fires on it, and a
    // listener waiting for one never sends. AISStream sends nothing until it
    // receives a subscription, so the relay sat with a healthy-looking open
    // socket and no data. Measured in production 2026-08-04: connected true,
    // messages 0, droppedMessages 0. The Node relay used the `ws` library,
    // where 'open' does fire, which is how the port inherited the bug.
    this.lastMessageAt = Date.now();
    ws.send(
      JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      }),
    );

    ws.addEventListener('message', (event) => {
      this.lastMessageAt = Date.now();
      this.state.messageCount += 1;
      // AISStream sends its JSON over binary frames, so the ArrayBuffer branch
      // is the one that carries production traffic; the string branch is for
      // any text frame the server chooses to send. Anything else counts as
      // dropped rather than being mishandled.
      const text = frameToText(event.data);
      if (text === null) {
        this.state.droppedMessages += 1;
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        this.state.droppedMessages += 1;
        return;
      }
      this.dispatchUpstreamMessage(data);
    });

    ws.addEventListener('close', () => {
      this.socket = null;
    });

    ws.addEventListener('error', () => {
      this.socket = null;
    });

    this.socket = ws;
  }

  /**
   * Dispatches on message type, mirroring processRawUpstreamMessage in
   * scripts/ais-relay.cjs minus the raw-message browser-client fanout, which
   * is dead code and out of scope. Only the classification dispatch survives
   * the port.
   */
  private dispatchUpstreamMessage(data: unknown): void {
    // JSON.parse happily returns null, a number or a string, none of which
    // carry a MessageType. Reading through them would throw inside a
    // WebSocket event listener, where nothing catches it.
    if (data === null || typeof data !== 'object') return;

    const msg = data as { MessageType?: string };
    if (msg.MessageType === 'PositionReport') {
      processPositionReport(this.state, msg as Parameters<typeof processPositionReport>[1]);
    } else if (msg.MessageType === 'ShipStaticData') {
      processShipStaticData(this.state, msg as Parameters<typeof processShipStaticData>[1]);
    }
  }
}
