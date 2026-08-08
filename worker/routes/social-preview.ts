/**
 * The share card, in the Worker.
 *
 * /api/story is what a crawler fetches when someone shares a country brief:
 * it answers bots with og:/twitter: meta tags and redirects everyone else into
 * the SPA. /api/og-story draws the 1200x630 SVG those tags point at.
 *
 * Neither path was routed here, so both fell through to UPSTREAM_API_ORIGIN,
 * which does not resolve. Every share link this fork emitted was dead, and the
 * front end made it worse by building those links against upstream's API host
 * (src/services/runtime.ts) — a working link to a site we do not run.
 *
 * Handlers are called, not rewritten: both are already web-standard
 * `(Request) => Response`, same as worker/routes/agent.ts. They derive the
 * origin they publish from the request Host through api/_first-party-origin.ts,
 * so a card shared from this host sends the reader back to this host.
 */
// @ts-expect-error — JS module, no declaration file
import ogStoryHandler from '../../api/og-story.js';
// @ts-expect-error — JS module, no declaration file
import storyHandler from '../../api/story.js';

type SocialPreviewHandler = (request: Request) => Promise<Response> | Response;

const SOCIAL_PREVIEW_ROUTES: Readonly<Record<string, SocialPreviewHandler>> = {
  '/api/story': (request) => storyHandler(request),
  '/api/og-story': (request) => ogStoryHandler(request),
};

export const SOCIAL_PREVIEW_ROUTE_PATHS: readonly string[] = Object.keys(SOCIAL_PREVIEW_ROUTES);

function matchSocialPreviewRoute(pathname: string): SocialPreviewHandler | undefined {
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return SOCIAL_PREVIEW_ROUTES[normalized];
}

export function isSocialPreviewPathHandledInWorker(pathname: string): boolean {
  return matchSocialPreviewRoute(pathname) !== undefined;
}

export async function handleSocialPreview(request: Request): Promise<Response> {
  const handler = matchSocialPreviewRoute(new URL(request.url).pathname);
  if (!handler) {
    return new Response('Not Found', { status: 404 });
  }
  return handler(request);
}
