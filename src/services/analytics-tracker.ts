/**
 * The dashboard's own event tracker.
 *
 * It stands in for the hosted Umami script the upstream project loads from
 * abacus.worldmonitor.app. That script never ran here — its tracker compares
 * the current hostname against a fixed allowlist and disables itself on
 * anything outside it — so this host recorded nothing at all.
 *
 * The replacement keeps the same `window.umami` surface the facade already
 * talks to: `track(name, data)` and `identify(data)`, each returning the
 * delivery promise. Everything the facade builds on top — the queue, the
 * bounded retries, the identity snapshot, the delivery gate — carries over
 * untouched. What changes is where the event goes and how it gets there: a
 * POST to this site's own /api/send instead of a third-party script fetch.
 *
 * Deliberately no script tag. The tracker is a few dozen lines, so shipping it
 * inside the bundle costs less than the request that would fetch it, and there
 * is no separate origin left to be slow, blocked, or down.
 *
 * Requests go through `window.fetch` on purpose: the collector gate in
 * analytics-collector-transport.ts wraps that function to serialize writes and
 * read their receipts, and a call that bypasses it is a write nobody observes.
 */

/**
 * Same path on our own origin, not an absolute URL. The gate compares the
 * fetch target against this exact string, so both sides must name it the same
 * way — see classifyCollectorRequest.
 */
export const ANALYTICS_COLLECTOR_PATH = '/api/send';

export const ANALYTICS_HEALTH_PATH = '/api/analytics-health';

/** Survives soft navigation within one tab, dies with the tab. */
const SESSION_STORAGE_KEY = 'wm-analytics-session';

type TrackerPayload = Record<string, unknown>;

let sessionId = '';
let visitId = '';

function randomId(): string {
  const cryptoApi = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `wm-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Reuses the tab's existing id so a session is one visit, not one page. Private
 * modes and storage-blocking extensions throw on access rather than returning
 * null, hence the catch — a session that lives only in memory still counts.
 */
function loadSessionId(): string {
  try {
    const stored = window.sessionStorage?.getItem(SESSION_STORAGE_KEY);
    if (stored) return stored;
    const minted = randomId();
    window.sessionStorage?.setItem(SESSION_STORAGE_KEY, minted);
    return minted;
  } catch {
    return randomId();
  }
}

/**
 * The path without its query string. Search parameters on this site carry
 * share tokens and checkout ids, and none of them belong in an event store.
 */
function currentPath(): string {
  try {
    return window.location?.pathname ?? '';
  } catch {
    return '';
  }
}

function currentHostname(): string {
  try {
    return window.location?.hostname ?? '';
  } catch {
    return '';
  }
}

function screenSize(): string {
  const target = window.screen;
  if (!target || typeof target.width !== 'number') return '';
  return `${target.width}x${target.height}`;
}

function basePayload(): TrackerPayload {
  return {
    id: sessionId,
    visitId,
    hostname: currentHostname(),
    url: currentPath(),
    referrer: typeof document !== 'undefined' ? (document.referrer ?? '') : '',
    language: typeof navigator !== 'undefined' ? (navigator.language ?? '') : '',
    screen: screenSize(),
  };
}

/**
 * Adopts the ids the collector answers with. The server is free to mint its
 * own when the ones it got fail validation, and the next write should carry
 * what it settled on rather than arguing.
 */
function adoptReceipt(receipt: unknown): void {
  if (typeof receipt !== 'object' || receipt === null) return;
  const { sessionId: nextSession, visitId: nextVisit } = receipt as {
    sessionId?: unknown;
    visitId?: unknown;
  };
  if (typeof nextSession === 'string' && nextSession !== '') sessionId = nextSession;
  if (typeof nextVisit === 'string' && nextVisit !== '') visitId = nextVisit;
}

function send(type: 'event' | 'identify', payload: TrackerPayload): Promise<unknown> {
  return window.fetch(ANALYTICS_COLLECTOR_PATH, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, payload: { ...basePayload(), ...payload } }),
  }).then(async (response) => {
    // The gate reads the receipt off its own clone and classifies the write.
    // Reading it again here only updates the ids for the next call, so a body
    // that will not parse is not a failure worth surfacing.
    try {
      adoptReceipt(await response.clone().json());
    } catch {
      // Leave the ids as they were.
    }
    return response;
  });
}

/**
 * Installs `window.umami`. Returns false when the host has no window or when
 * something already claimed the global — a browser extension, or a second call
 * after a soft navigation — because overwriting either would drop writes the
 * existing tracker has in flight.
 */
export function installLocalTracker(): boolean {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return false;
  if (window.umami) return true;

  sessionId = loadSessionId();
  visitId = randomId();

  window.umami = {
    track: (event: string, data?: Record<string, unknown>) =>
      send('event', data === undefined ? { name: event } : { name: event, data }),
    identify: (data: Record<string, unknown>) => send('identify', { data }),
  };
  return true;
}

/** Test-only: drop the installed tracker and the ids it was carrying. */
export function resetLocalTrackerForTesting(): void {
  sessionId = '';
  visitId = '';
  if (typeof window !== 'undefined') delete window.umami;
}
