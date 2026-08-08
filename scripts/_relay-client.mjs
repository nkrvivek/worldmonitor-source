// Reaching the AIS relay from a seed container.
//
// Two seeds call the relay now — seed-military-cii.mjs for /ais/snapshot and
// seed-transit-summaries.mjs for /ais/transits — so the base-URL and header
// handling lives here rather than in each.
//
// A container can make this call where a handler inside the Worker cannot. A
// Worker fetching its own hostname does not re-enter itself, it times out:
// measured 2026-08-04, WS_RELAY_URL naming the Worker's own custom domain,
// HTTP 522 while the Durable Object behind the path held 8,000 live vessels.
// A container is a separate network client and the loop does not apply to it.

import { CHROME_UA } from './_seed-utils.mjs';

/**
 * The relay's HTTP origin, or null when WS_RELAY_URL is unset.
 *
 * The name is historical — the value used to be a WebSocket URL — so ws:// and
 * wss:// are rewritten rather than rejected.
 */
export function getRelayBaseUrl() {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '');
}

/**
 * Headers for a relay call, carrying the shared secret when one is set.
 *
 * The secret goes in the header RELAY_AUTH_HEADER names and in Authorization
 * as a bearer token, because isAuthorizedRelayRequest accepts either.
 */
export function getRelayHeaders() {
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
    if (relayHeader !== 'authorization') headers.Authorization = `Bearer ${relaySecret}`;
  }
  return headers;
}
