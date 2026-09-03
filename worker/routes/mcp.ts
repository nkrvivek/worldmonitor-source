/**
 * The MCP front door, in the Worker.
 *
 * Upstream serves these paths on Vercel: vercel.json rewrites /mcp and the
 * .well-known documents to files under api/. On this host those rewrites
 * resolve against UPSTREAM_API_ORIGIN, which does not resolve, so every one of
 * them answered 530 and no MCP client could connect.
 *
 * Each handler is already a web-standard `(Request, ctx?) => Response`, same as
 * worker/routes/payments.ts, so this is a call and not a rewrite -- no handler
 * body moves. api/mcp/downstream.ts does the rest: its
 * createMcpToolExecutionContext sends downstream tool fetches to
 * `inbound.origin` for any host that is not worldmonitor.app, so on this host
 * the tools already call our own /api routes.
 *
 * The OAuth grant endpoints (/oauth/token, /oauth/authorize, ...) followed in
 * worker/routes/oauth.ts, once api/_first-party-origin.ts replaced upstream's
 * apex + api.worldmonitor.app two-host split with origins derived from the
 * request Host.
 */
import type { GatewayCtx } from '../../server/gateway';
import mcpHandler from '../../api/mcp/handler';
import httpMessageSignaturesHandler from '../../api/http-message-signatures-directory';
import oauthAuthorizationServerHandler from '../../api/oauth-authorization-server';
import oauthProtectedResourceHandler from '../../api/oauth-protected-resource';

type McpRoute = {
  readonly path: string;
  readonly handler: (request: Request, ctx?: GatewayCtx) => Promise<Response> | Response;
};

const MCP_ROUTES: readonly McpRoute[] = [
  // Four paths, one handler: /mcp is the address clients are given, /api/mcp is
  // where the file lives, and the two .well-known spellings are what a client
  // probes when it was handed a bare origin.
  { path: '/mcp', handler: (request, ctx) => mcpHandler(request, ctx) },
  { path: '/api/mcp', handler: (request, ctx) => mcpHandler(request, ctx) },
  { path: '/.well-known/mcp', handler: (request, ctx) => mcpHandler(request, ctx) },
  { path: '/.well-known/mcp.json', handler: (request, ctx) => mcpHandler(request, ctx) },
  // Discovery. A client that gets a 401 from /mcp reads these to learn where to
  // authenticate; they derive every URL they publish from the request Host, so
  // they name this host once api/_agent-metadata.ts knows it.
  {
    path: '/.well-known/oauth-protected-resource',
    handler: (request) => oauthProtectedResourceHandler(request),
  },
  {
    path: '/.well-known/oauth-authorization-server',
    handler: (request) => oauthAuthorizationServerHandler(request),
  },
  {
    path: '/.well-known/http-message-signatures-directory',
    handler: (request) => httpMessageSignaturesHandler(request),
  },
];

export const MCP_ROUTE_PATHS: readonly string[] = MCP_ROUTES.map((route) => route.path);

function matchMcpRoute(pathname: string): McpRoute | undefined {
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return MCP_ROUTES.find((route) => route.path === normalized);
}

export function isMcpPathHandledInWorker(pathname: string): boolean {
  return matchMcpRoute(pathname) !== undefined;
}

export async function handleMcpRpc(request: Request, ctx?: GatewayCtx): Promise<Response> {
  const route = matchMcpRoute(new URL(request.url).pathname);
  if (!route) {
    return new Response('Not Found', { status: 404 });
  }
  return route.handler(request, ctx);
}
