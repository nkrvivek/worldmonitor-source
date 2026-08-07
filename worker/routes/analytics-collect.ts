/**
 * First-party analytics collector.
 *
 * The dashboard used to send its events to a hosted Umami install at
 * abacus.worldmonitor.app. That host belongs to the upstream project, its
 * tracker self-disabled on any hostname outside its own allowlist, and on this
 * host it collected nothing at all. This route replaces it: two endpoints, one
 * Analytics Engine dataset, no third-party script and no database.
 *
 *   POST /api/send             one event or one identity write
 *   POST /api/analytics-health the client's own delivery-health report
 *
 * The response shape is not free to change. src/services/analytics-collector-
 * transport.ts reads `cache`, `sessionId` and `visitId` off every 2xx body and
 * treats a write whose receipt is missing any of the three as undelivered, so
 * every success answer here carries all three as non-empty strings.
 *
 * Session and visit ids come from the client and are echoed back. The client
 * keeps the session id in sessionStorage and mints a visit id per page load,
 * which is all the continuity a page-view count needs. Nothing here reads or
 * sets a cookie, and no address is stored: the only per-request field kept is
 * the country Cloudflare already attached.
 */
import { callCounter } from '../counters/protocol';
import type { Env } from '../index';

export const ANALYTICS_COLLECT_PATH = '/api/send';
export const ANALYTICS_HEALTH_PATH = '/api/analytics-health';

/** Rejects a body before parsing it. A tracker event is a few hundred bytes. */
const MAX_BODY_BYTES = 8_192;

/** Per-address ceiling. Generous for a real tab, cheap against a loop. */
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Analytics Engine caps one blob set at 5,120 bytes across all blobs. */
const MAX_BLOB_CHARS = 256;
const MAX_DATA_CHARS = 1_024;

export function isAnalyticsPathHandledInWorker(pathname: string): boolean {
  return pathname === ANALYTICS_COLLECT_PATH || pathname === ANALYTICS_HEALTH_PATH;
}

/** Duck-typed Durable Object stub, same local declaration the other routes use
 *  so this file stays loadable under plain Node in tests. */
interface CounterStub {
  fetch(request: Request): Promise<Response>;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { allow: 'POST' } });
}

/** Trims a value to one blob's budget and never returns undefined. */
function blob(value: unknown, limit = MAX_BLOB_CHARS): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit);
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Workers always has crypto.randomUUID; this keeps the plain-Node test path
  // from depending on it.
  return `wm-${Math.abs(Date.now()).toString(36)}`;
}

/** A client id is echoed straight back, so it must not carry arbitrary text. */
function safeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

/**
 * A miss here drops the request. Storage trouble does not: analytics are worth
 * less than the events they would lose, so an unavailable counter lets the
 * write through rather than failing closed the way an entitlement check would.
 */
async function withinRateLimit(env: Env, address: string): Promise<boolean> {
  const counter = env.COUNTER;
  if (!counter) return true;
  try {
    const shard = counter.get(counter.idFromName('analytics:collect')) as CounterStub;
    const result = await callCounter(shard, {
      op: 'sliding',
      key: `analytics:${address}`,
      limit: RATE_LIMIT_MAX,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
    return result.op !== 'sliding' || result.success;
  } catch {
    return true;
  }
}

type ParsedBody = { type: string; payload: Record<string, unknown> };

async function readBody(request: Request): Promise<ParsedBody | null> {
  const text = await request.text();
  if (text.length === 0 || text.length > MAX_BODY_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { type, payload } = parsed as { type?: unknown; payload?: unknown };
  if (type !== 'event' && type !== 'identify') return null;
  if (typeof payload !== 'object' || payload === null) return null;
  return { type, payload: payload as Record<string, unknown> };
}

function writeDataPoint(env: Env, point: {
  index: string;
  blobs: string[];
  doubles: number[];
}): void {
  const dataset = env.WM_ANALYTICS;
  if (!dataset) return;
  try {
    dataset.writeDataPoint({
      indexes: [point.index.slice(0, 96)],
      blobs: point.blobs,
      doubles: point.doubles,
    });
  } catch {
    // A dataset write is fire-and-forget by design. Losing one point must
    // never turn into a 500 the client then retries.
  }
}

export async function handleAnalyticsCollect(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();

  const url = new URL(request.url);
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await withinRateLimit(env, address))) {
    return jsonResponse({ error: 'rate limited' }, 429);
  }

  const country = blob(request.headers.get('cf-ipcountry') ?? '', 8);

  if (url.pathname === ANALYTICS_HEALTH_PATH) {
    return handleHealthReport(request, env, country);
  }

  const body = await readBody(request);
  if (!body) return jsonResponse({ error: 'bad request' }, 400);

  const { type, payload } = body;
  const sessionId = safeId(payload.id) ?? newId();
  const visitId = safeId(payload.visitId) ?? newId();
  const data = payload.data;

  writeDataPoint(env, {
    index: type === 'event' ? blob(payload.name, 64) || 'unnamed' : 'identify',
    blobs: [
      type,
      blob(payload.name, 64),
      blob(payload.hostname, 64),
      blob(payload.url),
      blob(payload.referrer),
      blob(payload.language, 16),
      blob(payload.screen, 16),
      country,
      sessionId,
      visitId,
      data == null ? '' : JSON.stringify(data).slice(0, MAX_DATA_CHARS),
    ],
    doubles: [1],
  });

  // The receipt the client transport requires. `cache` is Umami's name for the
  // token that stands in for a session on later writes; the ray id serves the
  // same purpose here and makes one write traceable in Cloudflare's own logs.
  return jsonResponse({
    cache: request.headers.get('cf-ray') ?? newId(),
    sessionId,
    visitId,
  }, 200);
}

/**
 * The client reports its own delivery failures here — how many writes it made
 * in the last minute, how many failed, and how. Without this the only record of
 * a broken collector lives in a browser console nobody reads.
 */
async function handleHealthReport(request: Request, env: Env, country: string): Promise<Response> {
  const text = await request.text();
  if (text.length === 0 || text.length > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'bad request' }, 400);
  }
  let report: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    report = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'bad request' }, 400);
  }

  writeDataPoint(env, {
    index: 'collector-health',
    blobs: [
      'health',
      blob(report.cohort, 32),
      blob(report.failureKind, 32),
      '',
      '',
      '',
      '',
      country,
      '',
      '',
      '',
    ],
    doubles: [
      typeof report.writes === 'number' ? report.writes : 0,
      typeof report.failures === 'number' ? report.failures : 0,
    ],
  });

  return jsonResponse({ ok: true }, 200);
}
