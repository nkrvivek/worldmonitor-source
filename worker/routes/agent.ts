/**
 * The two agent front doors, in the Worker.
 *
 * /a2a is the A2A JSON-RPC service behind public/.well-known/agent-card.json,
 * and /ask is the NLWeb endpoint. Both are anonymous, quota-free, and named by
 * documents this host already serves -- the agent card points at /a2a, and
 * llms.txt points at /ask -- so leaving them on the UPSTREAM_API_ORIGIN proxy
 * meant every agent that read those documents walked straight into a 530.
 *
 * Handlers are called, not rewritten: each is already a web-standard
 * `(Request) => Response`, same as worker/routes/mcp.ts and
 * worker/routes/oauth.ts. Both used to publish upstream's hostnames in the
 * links they hand back; they now derive those from the request Host through
 * api/_first-party-origin.ts, so an agent answered by this host is told to
 * call this host.
 *
 * CORS lives in the handlers, not here. vercel.json also sets CORS headers on
 * these two paths, which is upstream's belt and braces -- the responses carry
 * their own.
 */
import a2aHandler from '../../api/a2a';
import askHandler from '../../api/ask';

type AgentHandler = (request: Request) => Promise<Response> | Response;

const AGENT_ROUTES: Readonly<Record<string, AgentHandler>> = {
  '/a2a': (request) => a2aHandler(request),
  '/api/a2a': (request) => a2aHandler(request),
  '/ask': (request) => askHandler(request),
  '/api/ask': (request) => askHandler(request),
};

export const AGENT_ROUTE_PATHS: readonly string[] = Object.keys(AGENT_ROUTES);

function matchAgentRoute(pathname: string): AgentHandler | undefined {
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return AGENT_ROUTES[normalized];
}

export function isAgentPathHandledInWorker(pathname: string): boolean {
  return matchAgentRoute(pathname) !== undefined;
}

export async function handleAgent(request: Request): Promise<Response> {
  const handler = matchAgentRoute(new URL(request.url).pathname);
  if (!handler) {
    return new Response('Not Found', { status: 404 });
  }
  return handler(request);
}
