import { AIS_SNAPSHOT_PATH, fetchAisSnapshot, type AisRelayEnv } from './ais-snapshot';
import { getRelayBaseUrl } from '../../server/_shared/relay';

/**
 * Answers relay calls that name this Worker, and lets every other URL go out
 * over the network.
 *
 * WS_RELAY_URL names this Worker's own hostname, and a Worker that fetches its
 * own hostname times out instead of re-entering -- HTTP 522, measured
 * 2026-08-04 against a relay that was holding 8,000 live vessels at the time.
 * /ais/snapshot is served here from the Durable Object. Every other path the
 * old Node relay used to serve -- /opensky, /telegram, /rss, /yahoo-chart,
 * /google-flights, /oref, /notam, /wingbits, /aviationstack, /youtube-live --
 * is not ported, so those calls can only time out. Answering 404 immediately
 * is the same empty result the handlers already read from a non-ok relay,
 * minus the ten seconds each one spends waiting for it.
 *
 * selfOrigin is what makes the 404 safe: it fires only when WS_RELAY_URL names
 * this Worker. Point the var at a real relay again and every path goes back
 * out over the network, unchanged.
 */
export function relayFetchViaDurableObject(env: AisRelayEnv, selfOrigin: string) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const target = new URL(url);
    const relayBase = getRelayBaseUrl();
    const relayIsSelf = relayBase !== null && new URL(relayBase).origin === selfOrigin;
    if (!relayIsSelf || target.origin !== selfOrigin) return fetch(url, init);
    if (target.pathname === AIS_SNAPSHOT_PATH) return fetchAisSnapshot(env, target.search);
    return new Response(null, { status: 404 });
  };
}
