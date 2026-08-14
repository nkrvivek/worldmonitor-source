/**
 * Shared-secret check for the relay route, matching what
 * `scripts/ais-relay.cjs` does with `node:crypto`'s `timingSafeEqual`
 * (`safeTokenEquals`, line 6832).
 *
 * The compare is hand-written rather than imported. `wrangler.jsonc` does set
 * `nodejs_compat`, so `node:crypto` would import — but this module then stays
 * free of the Node shim and runs unchanged in a plain environment, which is
 * what the tests need.
 *
 * Constant-time in the sense that matters: the number of character compares
 * never depends on where the first mismatch falls. The length check short-
 * circuits, but length is public information, not secret content, so it opens
 * no side channel on the secret itself.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Matches `getRelaySecretFromRequest` (`scripts/ais-relay.cjs:6839`):
 * configured header first, trimmed and non-empty, falling back to
 * `Authorization: Bearer <token>`. `server/_shared/relay.ts`'s
 * `getRelayHeaders()` builds the client side, so a request from that helper
 * reads here whichever of the two headers it set.
 */
export function getRelaySecretFromRequest(request: Request, headerName: string): string | null {
  const fromHeader = request.headers.get(headerName)?.trim();
  if (fromHeader) return fromHeader;

  const authHeader = request.headers.get('authorization')?.trim();
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice('bearer '.length).trim();
    if (token) return token;
  }
  return null;
}

interface RelayAuthEnv {
  RELAY_SHARED_SECRET?: string;
  RELAY_AUTH_HEADER?: string;
}

/**
 * Matches `isAuthorizedRequest` (`scripts/ais-relay.cjs:6850`) with one
 * deliberate difference: the Worker route always requires
 * `RELAY_SHARED_SECRET`. The original script's `ALLOW_UNAUTHENTICATED_RELAY`
 * bypass is not ported — nothing in this port's scope uses it, and adding it
 * would be new surface, not a port.
 */
export function isAuthorizedRelayRequest(request: Request, env: RelayAuthEnv): boolean {
  const secret = env.RELAY_SHARED_SECRET;
  if (!secret) return false;

  const headerName = (env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
  const provided = getRelaySecretFromRequest(request, headerName);
  if (!provided) return false;

  return timingSafeEqualStrings(provided, secret);
}
