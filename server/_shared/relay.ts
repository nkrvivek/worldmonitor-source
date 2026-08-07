import { CHROME_UA } from './constants';

/**
 * How a handler reaches the relay. The default is a plain network fetch, which
 * is right everywhere except inside the Worker that now serves the relay
 * itself: there the URL names the Worker's own hostname, and a Worker fetching
 * its own hostname times out rather than re-entering (HTTP 522, measured
 * 2026-08-04). worker/routes/maritime.ts swaps in a fetcher that calls the
 * Durable Object directly.
 */
type RelayFetch = (url: string, init: RequestInit) => Promise<Response>;

let relayFetchImpl: RelayFetch | null = null;

/** Pass null to restore the plain network fetch. Tests rely on that. */
export function setRelayFetch(impl: RelayFetch | null): void {
  relayFetchImpl = impl;
}

export function relayFetch(url: string, init: RequestInit): Promise<Response> {
  return relayFetchImpl ? relayFetchImpl(url, init) : fetch(url, init);
}

export function getRelayBaseUrl(): string | null {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '');
}

export function getRelayHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
    ...extra,
  };
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (!relaySecret) return headers;
  const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
  headers[relayHeader] = relaySecret;
  // Only add a separate Authorization: Bearer header when relayHeader is not 'authorization'.
  // If RELAY_AUTH_HEADER=Authorization, both keys normalize to the same HTTP header and
  // Undici merges them into "secret, Bearer secret", which breaks the relay's direct-compare check.
  if (relayHeader !== 'authorization') {
    headers.Authorization = `Bearer ${relaySecret}`;
  }
  return headers;
}
