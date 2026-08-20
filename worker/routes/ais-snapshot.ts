import { isAuthorizedRelayRequest } from '../ais/auth';

export const AIS_SNAPSHOT_PATH = '/ais/snapshot';
export const AIS_TRANSITS_PATH = '/ais/transits';

export interface AisRelayEnv {
  RELAY_SHARED_SECRET?: string;
  RELAY_AUTH_HEADER?: string;
  AIS_RELAY?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

/**
 * One instance serves the whole relay: there is exactly one AISStream
 * subscription and one upstream connection, so a fixed name is right here.
 * CounterDO shards per key because its keys are independent; these are not.
 */
const RELAY_INSTANCE_NAME = 'singleton';

/**
 * The public path is /ais/snapshot, the DO answers its own /snapshot, and the
 * query string carries the filters, so it moves across unchanged. The
 * hostname is a placeholder — a DO stub routes by binding, not by host.
 */
export async function handleAisSnapshot(request: Request, env: AisRelayEnv): Promise<Response> {
  if (!isAuthorizedRelayRequest(request, env)) {
    return new Response(null, { status: 401 });
  }

  return fetchAisSnapshot(env, new URL(request.url).search);
}

/**
 * The same DO call without the authorization check, for callers already inside
 * this Worker. handleAisSnapshot is the public door and checks the shared
 * secret; a handler running in this isolate has already passed the gateway's
 * own checks and has no secret to present.
 *
 * This exists because the alternative does not work: a Worker that fetches its
 * own hostname does not re-enter itself, it times out. Measured 2026-08-04,
 * with WS_RELAY_URL naming this Worker's custom domain -- the maritime handler
 * logged "relay https://worldmonitor.sibt.ai/ais/snapshot returned HTTP 522"
 * while the Durable Object behind that path was holding 8,000 live vessels.
 */
export async function fetchAisSnapshot(env: AisRelayEnv, search: string): Promise<Response> {
  if (!env.AIS_RELAY) {
    return new Response('AIS_RELAY binding not configured', { status: 500 });
  }

  const stub = env.AIS_RELAY.get(env.AIS_RELAY.idFromName(RELAY_INSTANCE_NAME));
  const forwardUrl = new URL('https://relay.internal/snapshot');
  forwardUrl.search = search;
  return stub.fetch(new Request(forwardUrl.toString()));
}

/**
 * Per-chokepoint crossing counts over the last 24 hours, at /ais/transits.
 *
 * Behind the same shared secret as the snapshot, and for the same reason: the
 * DO holds live vessel movements and neither path is public data. The caller
 * is scripts/seed-transit-summaries.mjs, running in a seed container. A
 * container can make this call where a handler in this isolate cannot -- it is
 * a separate network client, so the 522 described above does not apply to it,
 * and it already receives RELAY_SHARED_SECRET and RELAY_AUTH_HEADER through
 * the SEED_ENV_NAMES allowlist.
 *
 * No internal sibling to fetchAisSnapshot: nothing inside this Worker reads
 * transit counts. Add one when something does.
 */
export async function handleAisTransits(request: Request, env: AisRelayEnv): Promise<Response> {
  if (!isAuthorizedRelayRequest(request, env)) {
    return new Response(null, { status: 401 });
  }

  if (!env.AIS_RELAY) {
    return new Response('AIS_RELAY binding not configured', { status: 500 });
  }

  const stub = env.AIS_RELAY.get(env.AIS_RELAY.idFromName(RELAY_INSTANCE_NAME));
  return stub.fetch(new Request('https://relay.internal/transits'));
}
