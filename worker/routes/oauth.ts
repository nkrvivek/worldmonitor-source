/**
 * The OAuth grant flow, in the Worker.
 *
 * Slice 1 (worker/routes/mcp.ts) put the MCP front door and its discovery
 * documents on this host. A client reads those documents, learns where to
 * authenticate, and then walks this flow — register, authorize, token. Every
 * one of these paths still resolved against UPSTREAM_API_ORIGIN, which does not
 * resolve, so the walk ended in a 530 and `tools/call` stayed unauthenticated.
 *
 * The two /api/internal endpoints are the Pro bridge: the /mcp-grant page reads
 * the client metadata from one and mints the signed grant with the other. They
 * carry no vercel.json rewrite because they are already /api paths upstream.
 *
 * Handlers are called, not rewritten -- each is already a web-standard
 * `(Request) => Response`, same as worker/routes/mcp.ts. The upstream host
 * constants they carried are gone: api/_first-party-origin.ts derives both the
 * page origin and the functions origin from the request Host, so this host
 * links to itself instead of to a site we do not run.
 */
import authorizeHandler from '../../api/oauth/authorize.js';
import authorizeProHandler from '../../api/oauth/authorize-pro';
import registerHandler from '../../api/oauth/register.js';
import tokenHandler from '../../api/oauth/token';
import agentAuthHandler from '../../api/agent-auth';
import mcpGrantContextHandler from '../../api/internal/mcp-grant-context';
import mcpGrantMintHandler from '../../api/internal/mcp-grant-mint';

type OauthHandler = (request: Request) => Promise<Response> | Response;

const OAUTH_ROUTES: Readonly<Record<string, OauthHandler>> = {
  '/oauth/register': (request) => registerHandler(request),
  '/oauth/authorize': (request) => authorizeHandler(request),
  '/oauth/authorize-pro': (request) => authorizeProHandler(request),
  '/oauth/token': (request) => tokenHandler(request),
  // The 401 challenge an agent hits first. It names the discovery documents,
  // so it has to answer from the same host that serves them.
  '/agent/auth': (request) => agentAuthHandler(request),
  '/api/internal/mcp-grant-context': (request) => mcpGrantContextHandler(request),
  '/api/internal/mcp-grant-mint': (request) => mcpGrantMintHandler(request),
};

export const OAUTH_ROUTE_PATHS: readonly string[] = Object.keys(OAUTH_ROUTES);

function matchOauthRoute(pathname: string): OauthHandler | undefined {
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return OAUTH_ROUTES[normalized];
}

export function isOauthPathHandledInWorker(pathname: string): boolean {
  return matchOauthRoute(pathname) !== undefined;
}

export async function handleOauth(request: Request): Promise<Response> {
  const handler = matchOauthRoute(new URL(request.url).pathname);
  if (!handler) {
    return new Response('Not Found', { status: 404 });
  }
  return handler(request);
}
