/**
 * One place that answers "which hosts are us, and where do our own pages and
 * functions live".
 *
 * Upstream runs on two hosts: worldmonitor.app serves the pages and
 * api.worldmonitor.app serves the functions. The OAuth grant flow crosses
 * between them, so upstream wrote both hostnames into the code as constants —
 * the consent page posts to the api host, the mint endpoint returns an api-host
 * redirect, and the apex page refuses to navigate anywhere else.
 *
 * This fork runs on ONE host, worldmonitor.sibt.ai. Every one of those
 * constants sends the user to a site we do not run, which ends the grant flow
 * on someone else's domain. Deriving the origins from the request Host fixes
 * that without changing upstream's behaviour: on a worldmonitor.app request the
 * resolvers still return the same two hosts they always did.
 *
 * The Host header is client-controlled, so an unknown host never becomes an
 * origin we publish — it falls back to the upstream apex. Without that, a
 * spoofed `Host: evil.com` would be reflected into a token endpoint or a
 * redirect and point an agent's credentials at an attacker.
 */

/** This fork's only host. */
export const FORK_HOST = 'worldmonitor.sibt.ai';

/** Upstream apex + exactly one DNS label (www, api, tech, finance, …). */
const UPSTREAM_HOST = /^(?:[a-z0-9-]+\.)?worldmonitor\.app$/;

const UPSTREAM_APP_ORIGIN = 'https://worldmonitor.app';
const UPSTREAM_API_ORIGIN = 'https://api.worldmonitor.app';

export function isFirstPartyHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === FORK_HOST || UPSTREAM_HOST.test(normalized);
}

/** True for `https://<a host of ours>`. Anything else — including http — is false. */
export function isFirstPartyOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.port === '' && isFirstPartyHost(url.hostname);
}

function hostOf(req: Request): string {
  return (req.headers.get('host') ?? new URL(req.url).host).toLowerCase();
}

/** The request's own origin, echoed back only when we recognise the host. */
export function resolveFirstPartyOrigin(req: Request): string {
  const host = hostOf(req);
  if (host === FORK_HOST) return `https://${FORK_HOST}`;
  return UPSTREAM_HOST.test(host) ? `https://${host}` : UPSTREAM_APP_ORIGIN;
}

/**
 * Where the pages live for a host: `/mcp-grant`, `/pro`, the dashboard.
 *
 * Takes a bare host for callers that have already read one off the request and
 * no longer hold the Request itself. Anything we do not recognise resolves to
 * the upstream apex, so a spoofed Host never reaches a published link.
 */
export function appOriginForHost(host: string): string {
  return host.toLowerCase() === FORK_HOST ? `https://${FORK_HOST}` : UPSTREAM_APP_ORIGIN;
}

/** Where the pages live: `/mcp-grant`, `/pro`, the dashboard. */
export function resolveAppOrigin(req: Request): string {
  return appOriginForHost(hostOf(req));
}

/** Where the functions live: `/oauth/authorize`, `/oauth/authorize-pro`. */
export function resolveApiOrigin(req: Request): string {
  return hostOf(req) === FORK_HOST ? `https://${FORK_HOST}` : UPSTREAM_API_ORIGIN;
}

/**
 * Where to point a link we hand a reader: share URLs, referral links, the
 * upgrade prompt, "return to the site" on an error page.
 *
 * `WORLDMONITOR_PUBLIC_BASE_URL` wins when set, so one env var pins every link
 * to a canonical host and preview deploys stop minting links on themselves.
 * Otherwise the request's own app origin serves, which on this fork is this
 * fork and on upstream is upstream. Unknown hosts never get published —
 * `resolveAppOrigin` refuses them.
 */
export function resolvePublicBaseUrl(req: Request): string {
  const pinned = process.env.WORLDMONITOR_PUBLIC_BASE_URL;
  if (pinned) return pinned.replace(/\/+$/, '');
  return resolveAppOrigin(req);
}

export interface FirstPartyOrigins {
  readonly app: string;
  readonly api: string;
}

/** Both origins for one request — the pair the consent page needs. */
export function resolveOrigins(req: Request): FirstPartyOrigins {
  return { app: resolveAppOrigin(req), api: resolveApiOrigin(req) };
}

/**
 * The pair upstream used before any of this was request-derived. Callers that
 * cannot see a Request default to it, so behaviour off the fork is unchanged.
 */
export const UPSTREAM_ORIGINS: FirstPartyOrigins = {
  app: UPSTREAM_APP_ORIGIN,
  api: UPSTREAM_API_ORIGIN,
};
