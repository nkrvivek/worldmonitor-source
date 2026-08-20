/**
 * The first-party /api endpoints that are not sebuf RPCs.
 *
 * worker/routes/domains.ts covers the 35 generated domain prefixes. Anything
 * else under /api falls through to the UPSTREAM_API_ORIGIN proxy, which points
 * at a host this fork does not control -- so every path here returned 404 on
 * the live site while its handler sat in the repo, unreachable. See
 * docs/architecture/api-routing-gap.md for the measurement.
 *
 * Handlers are called, not rewritten, the same way worker/routes/agent.ts and
 * worker/routes/mcp.ts call theirs: each default export is already a
 * web-standard `(Request, ctx?) => Response`.
 *
 * Some handlers call `ctx.waitUntil` without guarding it (api/reverse-geocode.js
 * caches the lookup that way), so the dispatcher always passes a ctx. The
 * Worker's own `ctx` is optional in the fetch signature -- production always
 * supplies one, the plain-Node tests do not -- and a no-op stand-in keeps a
 * missing one from throwing where the real one would have cached.
 *
 * Two surfaces in api/ are deliberately absent:
 *
 *   api/discord/oauth/{start,callback}.ts -- the Discord notification channel
 *     is being taken out, so routing it now would ship a surface we intend to
 *     drop.
 *   api/widget-agent.ts -- it proxies to https://proxy.worldmonitor.app, a
 *     relay host this fork does not run. Routing it turns a 404 into a failed
 *     proxy, which is not an improvement.
 */
import type { GatewayCtx } from '../../server/gateway';
import chatAnalystHandler from '../../api/chat-analyst';
import invalidateUserApiKeyCacheHandler from '../../api/invalidate-user-api-key-cache';
import latestBriefHandler from '../../api/latest-brief';
import mcpProxyHandler from '../../api/mcp-proxy';
import notificationChannelsHandler from '../../api/notification-channels';
import notifyHandler from '../../api/notify';
import referralMeHandler from '../../api/referral/me';
import fetchAgentSkillsHandler from '../../api/skills/fetch-agentskills';
import slackOauthCallbackHandler from '../../api/slack/oauth/callback';
import slackOauthStartHandler from '../../api/slack/oauth/start';
import symbolSearchHandler from '../../api/symbol-search';
import userPrefsHandler from '../../api/user-prefs';
import mcpQuotaHandler from '../../api/user/mcp-quota';
import mcpRevokeHandler from '../../api/user/mcp-revoke';
// @ts-expect-error — JS module, no declaration file
import downloadHandler from '../../api/download.js';
// @ts-expect-error — JS module, no declaration file
import fwdstartHandler from '../../api/fwdstart.js';
// @ts-expect-error — JS module, no declaration file
import gpsjamHandler from '../../api/gpsjam.js';
// @ts-expect-error — JS module, no declaration file
import openskyHandler from '../../api/opensky.js';
// @ts-expect-error — JS module, no declaration file
import orefAlertsHandler from '../../api/oref-alerts.js';
// @ts-expect-error — JS module, no declaration file
import reverseGeocodeHandler from '../../api/reverse-geocode.js';
// @ts-expect-error — JS module, no declaration file
import rssProxyHandler from '../../api/rss-proxy.js';
// @ts-expect-error — JS module, no declaration file
import telegramFeedHandler from '../../api/telegram-feed.js';
// @ts-expect-error — JS module, no declaration file
import hormuzTrackerHandler from '../../api/supply-chain/hormuz-tracker.js';
// @ts-expect-error — JS module, no declaration file
import versionHandler from '../../api/version.js';
// @ts-expect-error — JS module, no declaration file
import youtubeLiveHandler from '../../api/youtube/live.js';

// ctx is required here, not optional: handlePlainApi resolves it once, so a
// handler that declares it required (api/notification-channels.ts does) needs
// no per-route guard.
type PlainApiHandler = (request: Request, ctx: GatewayCtx) => Promise<Response> | Response;

const PLAIN_API_ROUTES: Readonly<Record<string, PlainApiHandler>> = {
  '/api/chat-analyst': (request) => chatAnalystHandler(request),
  '/api/invalidate-user-api-key-cache': (request) => invalidateUserApiKeyCacheHandler(request),
  '/api/latest-brief': (request) => latestBriefHandler(request),
  '/api/mcp-proxy': (request) => mcpProxyHandler(request),
  '/api/notification-channels': (request, ctx) => notificationChannelsHandler(request, ctx),
  '/api/notify': (request) => notifyHandler(request),
  '/api/referral/me': (request, ctx) => referralMeHandler(request, ctx),
  '/api/skills/fetch-agentskills': (request) => fetchAgentSkillsHandler(request),
  '/api/slack/oauth/callback': (request, ctx) => slackOauthCallbackHandler(request, ctx),
  '/api/slack/oauth/start': (request) => slackOauthStartHandler(request),
  '/api/symbol-search': (request) => symbolSearchHandler(request),
  '/api/user-prefs': (request) => userPrefsHandler(request),
  '/api/user/mcp-quota': (request) => mcpQuotaHandler(request),
  '/api/user/mcp-revoke': (request) => mcpRevokeHandler(request),
  '/api/download': (request, ctx) => downloadHandler(request, ctx),
  '/api/fwdstart': (request, ctx) => fwdstartHandler(request, ctx),
  '/api/gpsjam': (request, ctx) => gpsjamHandler(request, ctx),
  '/api/opensky': (request, ctx) => openskyHandler(request, ctx),
  '/api/oref-alerts': (request, ctx) => orefAlertsHandler(request, ctx),
  '/api/reverse-geocode': (request, ctx) => reverseGeocodeHandler(request, ctx),
  '/api/rss-proxy': (request, ctx) => rssProxyHandler(request, ctx),
  '/api/telegram-feed': (request, ctx) => telegramFeedHandler(request, ctx),
  '/api/supply-chain/hormuz-tracker': (request, ctx) => hormuzTrackerHandler(request, ctx),
  '/api/version': (request, ctx) => versionHandler(request, ctx),
  '/api/youtube/live': (request, ctx) => youtubeLiveHandler(request, ctx),
};

export const PLAIN_API_ROUTE_PATHS: readonly string[] = Object.keys(PLAIN_API_ROUTES);

const NOOP_CTX: GatewayCtx = { waitUntil: () => {} };

function matchPlainApiRoute(pathname: string): PlainApiHandler | undefined {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return PLAIN_API_ROUTES[normalized];
}

export function isPlainApiPathHandledInWorker(pathname: string): boolean {
  return matchPlainApiRoute(pathname) !== undefined;
}

export async function handlePlainApi(request: Request, ctx?: GatewayCtx): Promise<Response> {
  const handler = matchPlainApiRoute(new URL(request.url).pathname);
  if (!handler) {
    return new Response('Not Found', { status: 404 });
  }
  return handler(request, ctx ?? NOOP_CTX);
}
