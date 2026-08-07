/**
 * Every payments endpoint the Worker answers, in one table.
 *
 * All four were 404 until now. They are among the /api/* handlers still
 * pointed at UPSTREAM_API_ORIGIN, and that host — vercel-origin.worldmonitor.app
 * — does not resolve, so nobody could read a price or buy anything. The Stripe
 * port (docs/architecture/payments-stripe-port-and-pricing.md, step 6) is
 * finished behind these four paths; this is the branch that makes it reachable.
 *
 * /api/product-catalog is on the list even though the spec's step 6 calls it
 * "already ported". Ported meant its Stripe rewrite had landed, not that
 * anything routed it: `git grep product-catalog -- worker/ vercel.json` was
 * empty, so the pricing page still served the static fallback.
 *
 * Each handler is already a web-standard `(Request, ctx?) => Response`, same as
 * api/bootstrap.js, so this is a call and not a rewrite — no handler body moves.
 *
 * Exact paths, not prefixes. The domain table matches on prefix because each
 * domain owns a whole `/api/<domain>/v1/` namespace; these four are single
 * endpoints, and a prefix match on '/api/me/' would swallow every future
 * account route into the entitlement handler.
 */
import type { GatewayCtx } from '../../server/gateway';

// @ts-expect-error — JS module, no declaration file
import productCatalogHandler from '../../api/product-catalog.js';
import createCheckoutHandler from '../../api/create-checkout';
import customerPortalHandler from '../../api/customer-portal';
import entitlementHandler from '../../api/me/entitlement';

type PaymentRoute = {
  readonly path: string;
  readonly handler: (request: Request, ctx?: GatewayCtx) => Promise<Response>;
};

const PAYMENT_ROUTES: readonly PaymentRoute[] = [
  { path: '/api/product-catalog', handler: (request) => productCatalogHandler(request) },
  { path: '/api/create-checkout', handler: createCheckoutHandler },
  { path: '/api/customer-portal', handler: customerPortalHandler },
  { path: '/api/me/entitlement', handler: (request) => entitlementHandler(request) },
];

/** Every path in the table, for tests and for anything auditing coverage. */
export const PAYMENT_ROUTE_PATHS: readonly string[] = PAYMENT_ROUTES.map((route) => route.path);

/**
 * A trailing slash counts, for the same reason it does in the bootstrap route:
 * worker/index.ts strips one only further down the chain, after this branch has
 * already had its say.
 */
function matchPaymentRoute(pathname: string): PaymentRoute | undefined {
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return PAYMENT_ROUTES.find((route) => route.path === normalized);
}

export function isPaymentPathHandledInWorker(pathname: string): boolean {
  return matchPaymentRoute(pathname) !== undefined;
}

export async function handlePaymentRpc(request: Request, ctx?: GatewayCtx): Promise<Response> {
  const route = matchPaymentRoute(new URL(request.url).pathname);
  if (!route) {
    // isPaymentPathHandledInWorker gates every caller, so this is unreachable
    // unless the two fall out of step.
    return new Response('Not Found', { status: 404 });
  }
  return route.handler(request, ctx);
}
