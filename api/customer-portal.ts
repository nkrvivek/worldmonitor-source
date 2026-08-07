/**
 * Customer portal gateway.
 *
 * Thin auth proxy: validates the Supabase bearer token, then relays to the
 * Convex /relay/customer-portal HTTP action, which creates a user-scoped
 * Stripe billing portal session. Reached through worker/routes/payments.ts.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import {
  beginStandaloneIdempotency,
  completeStandaloneIdempotency,
  getIdempotencyKey,
} from './_idempotency.js';
import { validateBearerToken } from '../server/auth-session';
import { convexSiteUrl, relaySharedSecret } from './_relay-target';

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...cors,
    },
  });
}

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const cors = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
      },
    });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, cors);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return json({ error: 'Unauthorized' }, 401, cors);

  const session = await validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }

  const idempotencyKey = getIdempotencyKey(req);
  const idempotency = idempotencyKey
    ? await beginStandaloneIdempotency({
      request: req,
      pathname: '/api/customer-portal',
      scope: `user:${session.userId}`,
      idempotencyKey,
      corsHeaders: cors,
    })
    : null;
  if (
    idempotency &&
    idempotency.kind !== 'proceed' &&
    idempotency.kind !== 'disabled'
  ) {
    return idempotency.response;
  }

  const siteUrl = convexSiteUrl();
  const sharedSecret = relaySharedSecret();
  if (!siteUrl || !sharedSecret) {
    return completeStandaloneIdempotency(idempotency, json({ error: 'Service unavailable' }, 503, cors));
  }

  try {
    const resp = await fetch(`${siteUrl}/relay/customer-portal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSecret}`,
      },
      body: JSON.stringify({ userId: session.userId }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await resp.json().catch(() => ({})) as { error?: unknown };
    if (!resp.ok) {
      console.error('[customer-portal] Relay error:', resp.status, data);
      return completeStandaloneIdempotency(
        idempotency,
        json({ error: data?.error || 'Customer portal unavailable' }, resp.status === 404 ? 404 : 502, cors),
      );
    }

    return completeStandaloneIdempotency(idempotency, json(data, 200, cors));
  } catch (err) {
    console.error('[customer-portal] Relay failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/customer-portal', step: 'relay' }, ctx });
    return completeStandaloneIdempotency(idempotency, json({ error: 'Customer portal unavailable' }, 502, cors));
  }
}
