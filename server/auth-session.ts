/**
 * Server-side session validation for the gateway.
 *
 * Validates Supabase-issued bearer tokens with local JWT verification
 * (jose + cached JWKS). No Convex round-trip needed to prove identity.
 * Requires SUPABASE_JWT_ISSUER.
 *
 * This module must NOT import anything from `src/` -- it runs in the
 * Cloudflare Worker runtime, not the browser.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

// Absorb minor issuer/edge clock skew without turning expiration into a broad
// grace period. jose's operators are asymmetric at the bound: `exp` is accepted
// strictly less than five seconds late (rejected at exactly five — jose tests
// `exp <= now - tolerance`), while `nbf` is accepted up to and including five
// seconds early. Either way the replay window widens by at most this bound.
const JWT_CLOCK_TOLERANCE_SECONDS = 5;

/**
 * The audience Supabase stamps on every access token. It is the fixed string
 * `authenticated`, not the app name, and it cannot be configured — so it is a
 * constant here rather than an env var, and convex/auth.config.ts carries the
 * same value as its `applicationID`.
 */
const SUPABASE_JWT_AUDIENCE = 'authenticated';

export function getJwtVerifyOptions() {
  return {
    // Read lazily (not from a module-scope const) for the same reason as
    // getJWKS(): both halves of issuer handling must read the env at the same
    // time. A module evaluated before SUPABASE_JWT_ISSUER is set would
    // otherwise pin issuer '' here — and jose skips the issuer VALUE check
    // entirely on a falsy issuer — while the lazily-built JWKS still resolves.
    issuer: process.env.SUPABASE_JWT_ISSUER ?? '',
    audience: SUPABASE_JWT_AUDIENCE,
    // Supabase signs with ES256 today. RS256 stays allowed because a project
    // may hold RSA signing keys instead, and a key rotation must not lock
    // every user out. HS256 is deliberately absent: the JWKS publishes public
    // keys, so admitting a symmetric algorithm would open the classic
    // algorithm-confusion forgery.
    algorithms: ['ES256', 'RS256'],
    clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
    // The bounded tolerance above is only a bound if expiry is evaluated at
    // all: jose skips the whole `exp` check (tolerance included) when the
    // claim is absent. Supabase always mints `exp`, so requiring it rejects
    // nothing real — it makes the stated bound enforced rather than assumed.
    requiredClaims: ['exp'],
  };
}

// Module-scope JWKS resolver -- cached across warm invocations.
// jose handles key rotation and caching internally.
// Exported so server/_shared/auth-session.ts can reuse the same singleton
// (avoids duplicate JWKS HTTP fetches on cold start).
// Reads SUPABASE_JWT_ISSUER lazily (not from a module-scope const) so that
// tests that set the env var after import still get a valid JWKS.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
export function getJWKS() {
  if (!_jwks) {
    const issuer = process.env.SUPABASE_JWT_ISSUER;
    if (issuer) {
      // Append to the issuer, never resolve against it. The issuer carries a
      // path (`https://<ref>.supabase.co/auth/v1`), and `new URL('/.well-known
      // /jwks.json', issuer)` would drop that path — the leading slash resets
      // it — leaving a URL that 404s while looking correct.
      _jwks = createRemoteJWKSet(new URL(`${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`));
    }
  }
  return _jwks;
}

/**
 * Drop the memoized resolver so a test can change SUPABASE_JWT_ISSUER and
 * have the next call rebuild against it. Without this the first test to touch a
 * bearer pins the resolver for the whole module lifetime, and a later test that
 * unsets the env still gets the old one — silently asserting the wrong branch.
 */
export function __resetJwksForTests(): void {
  _jwks = null;
}

export interface SessionResult {
  valid: boolean;
  userId?: string;
  /**
   * Always null. Supabase has no organizations, so nothing mints this claim.
   * The field stays because gateway usage telemetry reads it, and dropping it
   * would silently change that record's shape rather than its value.
   */
  orgId?: string | null;
  /**
   * Always 'free'. This is the SECOND, independent pro signal every gate
   * carries alongside the Convex entitlement row — Clerk fed it from
   * publicMetadata.plan, which is how complimentary, tester and legacy grants
   * were issued out of band from billing. Supabase has no equivalent channel
   * we can trust: `user_metadata` is the only per-user store the token carries
   * that we can read, and Supabase's own docs say to "not use it in security
   * sensitive context (such as in RLS policies or authorization logic), as
   * this value is editable by the user without any checks". Reading a plan
   * from it would let any user grant themselves Pro.
   *
   * So the field stays and the grant channel closes: after the cutover a
   * complimentary grant is an entitlement row like every other, which is also
   * the only place that can price one. Deriving this from the entitlement row
   * instead would be worse than useless — the gates read `role === 'pro'` as
   * an early allow that SKIPS the row, so a paying subscriber would take the
   * unpriceable-grant branch and land on the unverified LLM quota floor
   * (server/_shared/premium-check.ts) while dropping the row from usage
   * telemetry (server/gateway.ts).
   */
  role?: 'free' | 'pro';
  email?: string;
  name?: string;
  /**
   * Why a `valid: false` result is invalid — present only on the deny arm.
   *
   * `invalid` is a confirmed answer ABOUT THE TOKEN: bad signature, expired,
   * wrong issuer, no subject. Re-authenticating is the fix.
   *
   * `unverifiable` means verification never happened — the issuer is unset, or
   * the JWKS fetch failed. That says nothing about the token, so a caller must
   * not render it as "your credential is bad, signing in again is the fix"
   * (#5619 follow-up: the same "our defect is not a verdict" rule the
   * entitlement path already follows).
   *
   * Optional and additive: `valid` keeps its exact meaning, so every existing
   * consumer that only reads `valid` is unaffected. A caller opts in by
   * branching on this to answer the retryable contract instead.
   */
  reason?: 'invalid' | 'unverifiable';
  /**
   * Present only when verification succeeded BECAUSE of the bounded
   * `clockTolerance` — the token's `exp` was already in the past on this
   * machine's clock. Optional and additive, like `reason`: `valid` keeps its
   * exact meaning for every existing consumer. A caller that re-presents the
   * same bearer to a second verifier with its own clock (Convex via
   * `client.setAuth`) opts in by branching on this to classify that verifier's
   * rejection as expected near-expiry traffic rather than auth-config drift.
   */
  acceptedWithinClockTolerance?: true;
}

/**
 * True when a jwtVerify rejection means we could not REACH the JWKS, rather
 * than that the token failed verification against it.
 *
 * Deliberately narrow. `JWKSNoMatchingKey` is excluded: it fires both for a
 * forged token and for a mid-rotation key, and misclassifying a forged token as
 * "retry later" is the worse error. Only unambiguous transport failures — jose's
 * own JWKS timeout, and the bare `TypeError` a failed `fetch` surfaces — count.
 */
function isJwksFetchFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_JWKS_TIMEOUT';
}

/**
 * Read the display name Supabase carries.
 *
 * Google OAuth writes `full_name`; email sign-up writes whatever the client
 * passed, commonly `name`. There are no `given_name`/`family_name` claims to
 * join, so nothing here reconstructs one.
 */
function extractName(userMetadata: Record<string, unknown>): string | undefined {
  for (const key of ['full_name', 'name'] as const) {
    const value = userMetadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Validate a Supabase-issued bearer token using local JWKS verification.
 * The token proves identity; the plan comes from the Convex entitlement row
 * that the Stripe billing webhook writes.
 * Fails closed: invalid/expired/unverifiable tokens return { valid: false }.
 */
export async function validateBearerToken(token: string): Promise<SessionResult> {
  const jwks = getJWKS();
  // No issuer configured: a deploy defect, not a bad token.
  if (!jwks) return { valid: false, reason: 'unverifiable' };

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, jwks, getJwtVerifyOptions()));
  } catch (err) {
    // Usually signature verification failed / expired / wrong issuer — a
    // confirmed answer about the token. But this same catch also covers a JWKS
    // FETCH failure, since createRemoteJWKSet resolves lazily inside jwtVerify,
    // and that says nothing about the token at all. Split them so a Supabase
    // outage stops rendering as "sign in again" (#5619 follow-up).
    return { valid: false, reason: isJwksFetchFailure(err) ? 'unverifiable' : 'invalid' };
  }

  const userId = typeof payload.sub === 'string' ? payload.sub : undefined;
  // Verified, but carries no subject — a confirmed answer about the token.
  if (!userId) return { valid: false, reason: 'invalid' };

  const userMetadata = (payload.user_metadata ?? {}) as Record<string, unknown>;

  // Top-level claim only. Supabase always mints it, and the `user_metadata`
  // copy beside it is user-editable — it reaches Stripe as the checkout customer
  // email (api/create-checkout.ts), so nothing is gained by trusting a field
  // the account holder can rewrite.
  const email = typeof payload.email === 'string' ? payload.email : undefined;

  // `exp` in the past on our clock means only the clockTolerance admitted
  // this token (requiredClaims guarantees the claim is present on success).
  const expMs = typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  const withinTolerance = expMs !== null && expMs <= Date.now();

  return {
    valid: true,
    userId,
    orgId: null,
    // Never read `payload.role`. Supabase sets that claim to the Postgres role
    // ("authenticated"), which has nothing to do with our free/pro plan and
    // would read as a truthy non-'pro' value.
    role: 'free',
    email,
    name: extractName(userMetadata),
    ...(withinTolerance ? { acceptedWithinClockTolerance: true as const } : {}),
  };
}
