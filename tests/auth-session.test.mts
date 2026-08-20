/**
 * Tests for server/auth-session.ts (Supabase JWT verification with jose)
 *
 * Covers the full validation matrix:
 *  - Returns unverifiable when SUPABASE_JWT_ISSUER is not set (fail-closed)
 *  - The JWKS URL keeps the issuer's path, so the fetch resolves at all
 *  - Valid ES256 token → { valid: true }
 *  - RS256 token → accepted, so an RSA signing key does not lock everyone out
 *  - HS256 token → rejected (no algorithm confusion against a public JWKS)
 *  - Audience: only the fixed string "authenticated"; other or absent → rejected
 *  - Small JWT clock skew → accepted within the bounded tolerance
 *  - Expired token beyond the tolerance → { valid: false, reason: 'invalid' }
 *  - Not-yet-valid token within the nbf tolerance → accepted
 *  - Exact exp/nbf tolerance boundaries → pinned with a fixed verification clock
 *  - Token with no exp claim → rejected (requiredClaims makes the bound enforced)
 *  - Tolerance-only acceptance → surfaced via acceptedWithinClockTolerance
 *  - Invalid signature → { valid: false }
 *  - Supabase's own `role` claim → never read as our free/pro role
 *  - Profile fields → email plus user_metadata full_name / name
 *  - JWKS transport failure → { valid: false, reason: 'unverifiable' }
 *  - JWKS resolver is reused across calls (module-scoped, not per-request)
 *  - role → always 'free': Supabase mints no grant channel we may trust
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, it, before, after } from 'node:test';
import { generateKeyPair, exportJWK, jwtVerify, SignJWT } from 'jose';

const EXPECTED_CLOCK_TOLERANCE_SECONDS = 5;

// Supabase's audience is this fixed string. It is not the app name and not
// configurable, so the test states it literally rather than importing it.
const AUDIENCE = 'authenticated';

// Real issuers carry a path. Keeping one here is the point: the JWKS URL must
// be APPENDED to the issuer, and `new URL('/.well-known/jwks.json', issuer)`
// would silently drop `/auth/v1` and 404. The JWKS server below serves the
// path-qualified URL only, so that mistake fails every token test in the file.
const ISSUER_PATH = '/auth/v1';

type AuthSessionResult = {
  valid: boolean;
  userId?: string;
  orgId?: string | null;
  role?: string;
  email?: string;
  name?: string;
  reason?: 'invalid' | 'unverifiable';
  acceptedWithinClockTolerance?: true;
};

// ---------------------------------------------------------------------------
// Suite 1: fail-closed when SUPABASE_JWT_ISSUER is NOT set
// ---------------------------------------------------------------------------

// Clear env BEFORE dynamic import so the module captures an empty issuer
delete process.env.SUPABASE_JWT_ISSUER;

let validateBearerTokenNoEnv: (token: string) => Promise<AuthSessionResult>;

before(async () => {
  const mod = await import('../server/auth-session.ts');
  validateBearerTokenNoEnv = mod.validateBearerToken;
});

describe('validateBearerToken (no SUPABASE_JWT_ISSUER)', () => {
  it('returns unverifiable when SUPABASE_JWT_ISSUER is not set', async () => {
    const result = await validateBearerTokenNoEnv('some-random-token');
    assert.equal(result.valid, false);
    // A missing issuer is OUR deploy defect, not a verdict about the token, so
    // callers must not render it as "sign in again".
    assert.equal(result.reason, 'unverifiable');
    assert.equal(result.userId, undefined);
    assert.equal(result.role, undefined);
  });

  it('returns invalid for empty token', async () => {
    const result = await validateBearerTokenNoEnv('');
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: full JWT validation with self-signed keys + local JWKS server
// ---------------------------------------------------------------------------

describe('validateBearerToken (with JWKS)', () => {
  let esPrivateKey: CryptoKey;
  let esPublicKey: CryptoKey;
  let rsPrivateKey: CryptoKey;
  let wrongPrivateKey: CryptoKey;

  let jwksServer: Server;
  let issuer: string;
  let jwksRequests = 0;

  let validateBearerToken: (token: string) => Promise<AuthSessionResult>;
  let getJwtVerifyOptions: () => {
    clockTolerance?: string | number;
    requiredClaims?: string[];
    algorithms?: string[];
    audience?: string;
  };

  before(async () => {
    const es = await generateKeyPair('ES256');
    esPrivateKey = es.privateKey;
    esPublicKey = es.publicKey;

    const rs = await generateKeyPair('RS256');
    rsPrivateKey = rs.privateKey;

    const wrong = await generateKeyPair('ES256');
    wrongPrivateKey = wrong.privateKey;

    const esJwk = { ...(await exportJWK(es.publicKey)), kid: 'es-key-1', alg: 'ES256', use: 'sig' };
    const rsJwk = { ...(await exportJWK(rs.publicKey)), kid: 'rs-key-1', alg: 'RS256', use: 'sig' };
    const jwks = { keys: [esJwk, rsJwk] };

    // Serves the path-qualified JWKS URL only. A request to the bare
    // /.well-known/jwks.json — what dropping the issuer path produces — 404s.
    jwksServer = createServer((req, res) => {
      if (req.url === `${ISSUER_PATH}/.well-known/jwks.json`) {
        jwksRequests += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jwks));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      jwksServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = jwksServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    issuer = `http://127.0.0.1:${port}${ISSUER_PATH}`;

    process.env.SUPABASE_JWT_ISSUER = issuer;
    // Verification is local: no Convex read, no plan lookup, no network call
    // beyond the JWKS above. Unset these so a regression that reintroduces an
    // entitlement fetch inside validateBearerToken cannot quietly find one
    // configured and pass anyway.
    delete process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_SERVER_SHARED_SECRET;

    // Dynamic import with cache-busting query param to get a fresh module instance
    const mod = await import(`../server/auth-session.ts?t=${Date.now()}`);
    validateBearerToken = mod.validateBearerToken;
    getJwtVerifyOptions = mod.getJwtVerifyOptions;
  });

  after(async () => {
    jwksServer?.close();
    delete process.env.SUPABASE_JWT_ISSUER;
  });

  /** Helper to sign a JWT with the test ES256 private key */
  function signToken(
    claims: Record<string, unknown>,
    opts?: {
      audience?: string | null;
      expiresAt?: number;
      key?: CryptoKey;
      notBeforeAt?: number;
    },
  ) {
    const builder = new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'es-key-1' })
      .setIssuer(issuer)
      .setSubject((claims.sub as string) ?? 'user_test123')
      .setIssuedAt();

    if (opts?.audience !== null) builder.setAudience(opts?.audience ?? AUDIENCE);
    if (opts?.notBeforeAt !== undefined) builder.setNotBefore(opts.notBeforeAt);
    builder.setExpirationTime(opts?.expiresAt ?? '1h');

    return builder.sign(opts?.key ?? esPrivateKey);
  }

  it('exposes the intentionally bounded JWT clock tolerance', () => {
    const options = getJwtVerifyOptions();
    assert.equal(options.clockTolerance, EXPECTED_CLOCK_TOLERANCE_SECONDS);
    assert.deepEqual(options.requiredClaims, ['exp']);
  });

  it('allows ES256 and RS256 but never HS256', () => {
    // HS256 verifies with the key it was signed with. Against a PUBLIC JWKS
    // that is the classic algorithm-confusion forgery, so it must never appear.
    assert.deepEqual(getJwtVerifyOptions().algorithms, ['ES256', 'RS256']);
  });

  it('accepts a valid ES256 token', async () => {
    const token = await signToken({ sub: 'user_es' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_es');
    // A token with real life left was not admitted by the tolerance.
    assert.equal(result.acceptedWithinClockTolerance, undefined);
  });

  it('accepts an RS256 token, so an RSA signing key does not lock users out', async () => {
    const token = await new SignJWT({ sub: 'user_rs' })
      .setProtectedHeader({ alg: 'RS256', kid: 'rs-key-1' })
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setSubject('user_rs')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(rsPrivateKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_rs');
  });

  it('rejects an HS256 token', async () => {
    const token = await new SignJWT({ sub: 'user_hs' })
      .setProtectedHeader({ alg: 'HS256', kid: 'es-key-1' })
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setSubject('user_hs')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new Uint8Array(32));

    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('reports orgId as null — Supabase has no organizations', async () => {
    const result = await validateBearerToken(await signToken({ sub: 'user_noorg' }));
    assert.equal(result.valid, true);
    assert.equal(result.orgId, null);
  });

  it('never reads Supabase\'s own role claim as our plan', async () => {
    // Supabase stamps `role: "authenticated"` on every token — the Postgres
    // role, unrelated to free/pro. Reading it here would hand every signed-in
    // user a role string the entitlement gates never expect.
    const token = await signToken({ sub: 'user_pgrole', role: 'authenticated' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.role, 'free');
  });

  it('rejects a token signed with the wrong key', async () => {
    const token = await signToken({ sub: 'user_wrongkey' }, { key: wrongPrivateKey });
    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('rejects a token with an unexpected audience', async () => {
    const token = await signToken({ sub: 'user_anyaud' }, { audience: 'convex' });
    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('rejects a token with no aud claim', async () => {
    // Supabase always mints `aud`. There is no no-audience fallback to fall
    // into, and re-adding one would accept tokens minted for another service.
    const token = await signToken({ sub: 'user_noaud' }, { audience: null });
    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('rejects a token with the wrong issuer', async () => {
    const token = await new SignJWT({ sub: 'user_wrongiss' })
      .setProtectedHeader({ alg: 'ES256', kid: 'es-key-1' })
      .setIssuer('https://wrong-issuer.example.com/auth/v1')
      .setAudience(AUDIENCE)
      .setSubject('user_wrongiss')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(esPrivateKey);

    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('rejects a token with no sub claim', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'es-key-1' })
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(esPrivateKey);

    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('rejects a token with no exp claim (requiredClaims enforces the stated bound)', async () => {
    const token = await new SignJWT({ sub: 'user_no_exp' })
      .setProtectedHeader({ alg: 'ES256', kid: 'es-key-1' })
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setSubject('user_no_exp')
      .setIssuedAt()
      .sign(esPrivateKey);

    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('accepts a token expired within the clock tolerance', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({ sub: 'user_within_tolerance' }, { expiresAt: now - 1 });

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_within_tolerance');
    // Downstream consumers (api/user-prefs.ts) branch on this to classify a
    // Convex re-verification 401 as expected near-expiry, not auth drift.
    assert.equal(result.acceptedWithinClockTolerance, true);
  });

  it('rejects a token expired beyond the clock tolerance', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({ sub: 'user_beyond_tolerance' }, { expiresAt: now - 8 });

    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('accepts a not-yet-valid token within the nbf clock tolerance', async () => {
    // Structurally flake-safe direction: nbf recedes into the past as real
    // time advances, so test-runner delay can only help acceptance. The
    // rejection side of the nbf boundary is pinned with a fixed clock below —
    // a live-clock nbf rejection test would flip to a false pass within
    // seconds, the flake class tracked in #5841.
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({ sub: 'user_nbf_within' }, { notBeforeAt: now + 4 });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_nbf_within');
  });

  describe('exact tolerance boundaries (fixed verification clock)', () => {
    // These pin the numeric bound behaviorally — a tolerance quietly widened
    // to 6 or narrowed to 4 fails here — with zero wall-clock coupling:
    // jose's `currentDate` option freezes "now", so elapsed runner time
    // cannot flip an outcome. Verification runs against the same exported
    // options object the module passes to jwtVerify in production.
    it('pins the exp boundary: 4s late accepted, exactly 5s late rejected', async () => {
      const t = Math.floor(Date.now() / 1000);
      const currentDate = new Date(t * 1000);

      const justInside = await signToken(
        { sub: 'user_exp_edge_in' },
        { expiresAt: t - (EXPECTED_CLOCK_TOLERANCE_SECONDS - 1) },
      );
      const { payload } = await jwtVerify(justInside, esPublicKey, {
        ...getJwtVerifyOptions(),
        currentDate,
      });
      assert.equal(payload.sub, 'user_exp_edge_in');

      const atBoundary = await signToken(
        { sub: 'user_exp_edge_out' },
        { expiresAt: t - EXPECTED_CLOCK_TOLERANCE_SECONDS },
      );
      await assert.rejects(
        jwtVerify(atBoundary, esPublicKey, { ...getJwtVerifyOptions(), currentDate }),
        (err: { code?: string }) => err.code === 'ERR_JWT_EXPIRED',
      );
    });

    it('pins the nbf boundary: exactly 5s early accepted, 6s early rejected', async () => {
      const t = Math.floor(Date.now() / 1000);
      const currentDate = new Date(t * 1000);

      const atBoundary = await signToken(
        { sub: 'user_nbf_edge_in' },
        { notBeforeAt: t + EXPECTED_CLOCK_TOLERANCE_SECONDS },
      );
      const { payload } = await jwtVerify(atBoundary, esPublicKey, {
        ...getJwtVerifyOptions(),
        currentDate,
      });
      assert.equal(payload.sub, 'user_nbf_edge_in');

      const beyond = await signToken(
        { sub: 'user_nbf_edge_out' },
        { notBeforeAt: t + EXPECTED_CLOCK_TOLERANCE_SECONDS + 1 },
      );
      await assert.rejects(
        jwtVerify(beyond, esPublicKey, { ...getJwtVerifyOptions(), currentDate }),
        (err: { code?: string; claim?: string }) =>
          err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && err.claim === 'nbf',
      );
    });
  });

  it('extracts email and full_name for checkout prefill', async () => {
    // Google OAuth writes full_name into user_metadata. Supabase mints no
    // given_name/family_name, so there is nothing to join.
    const token = await signToken({
      sub: 'user_prefill',
      email: 'elie@worldmonitor.app',
      user_metadata: { full_name: 'Ada Lovelace', avatar_url: 'https://example.test/a.png' },
    });

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.email, 'elie@worldmonitor.app');
    assert.equal(result.name, 'Ada Lovelace');
  });

  it('falls back to user_metadata.name when full_name is absent', async () => {
    const token = await signToken({
      sub: 'user_prefill_name',
      email: 'name@worldmonitor.app',
      user_metadata: { name: 'Signup Name' },
    });

    const result = await validateBearerToken(token);
    assert.equal(result.name, 'Signup Name');
  });

  it('handles missing email/name gracefully (no prefill)', async () => {
    const result = await validateBearerToken(await signToken({ sub: 'user_noprofile' }));
    assert.equal(result.valid, true);
    assert.equal(result.email, undefined);
    assert.equal(result.name, undefined);
  });

  it('reuses the JWKS resolver across calls (not per-request)', async () => {
    const fetchesBefore = jwksRequests;
    const [r1, r2] = await Promise.all([
      validateBearerToken(await signToken({ sub: 'user_a' })),
      validateBearerToken(await signToken({ sub: 'user_b' })),
    ]);

    assert.equal(r1.valid, true);
    assert.equal(r2.valid, true);
    assert.equal(jwksRequests, fetchesBefore, 'a warm resolver must not re-fetch the JWKS');
  });

  it('classifies a JWKS transport failure as unverifiable', async () => {
    const failingJwksServer = createServer((_req, res) => {
      res.destroy();
    });
    await new Promise<void>((resolve) => {
      failingJwksServer.listen(0, '127.0.0.1', () => resolve());
    });
    const failingAddress = failingJwksServer.address();
    const failingPort =
      typeof failingAddress === 'object' && failingAddress ? failingAddress.port : 0;
    const failingIssuer = `http://127.0.0.1:${failingPort}${ISSUER_PATH}`;

    try {
      process.env.SUPABASE_JWT_ISSUER = failingIssuer;
      const failingModule = await import(`../server/auth-session.ts?jwks-failure=${Date.now()}`);
      const token = await new SignJWT({ sub: 'user_jwks_failure' })
        .setProtectedHeader({ alg: 'ES256', kid: 'es-key-1' })
        .setIssuer(failingIssuer)
        .setAudience(AUDIENCE)
        .setSubject('user_jwks_failure')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(esPrivateKey);

      assert.deepEqual(
        await failingModule.validateBearerToken(token),
        { valid: false, reason: 'unverifiable' },
      );
    } finally {
      process.env.SUPABASE_JWT_ISSUER = issuer;
      await new Promise<void>((resolve, reject) => {
        failingJwksServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3: role is a closed grant channel, and verification stays local
// ---------------------------------------------------------------------------

describe('the session role', () => {
  let validateBearerToken: (token: string) => Promise<AuthSessionResult>;
  let signToken: (claims: Record<string, unknown>) => Promise<string>;
  let jwksServer: Server;
  let privateKey: CryptoKey;
  let outboundHosts: string[];
  let realFetch: typeof globalThis.fetch;

  before(async () => {
    const keys = await generateKeyPair('ES256', { extractable: true });
    privateKey = keys.privateKey;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'role-key', alg: 'ES256', use: 'sig' };

    jwksServer = createServer((req, res) => {
      if (req.url === `${ISSUER_PATH}/.well-known/jwks.json`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => { jwksServer.listen(0, '127.0.0.1', () => resolve()); });
    const addr = jwksServer.address();
    const issuer = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}${ISSUER_PATH}`;
    process.env.SUPABASE_JWT_ISSUER = issuer;

    // Configure the entitlement backend on purpose. If validateBearerToken ever
    // reaches for it again, the lookup will be live and the host assertion below
    // will name it instead of silently short-circuiting on missing config.
    process.env.CONVEX_SITE_URL = 'https://entitlements.invalid';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'test-shared-secret';

    realFetch = globalThis.fetch;
    outboundHosts = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input
        : input instanceof URL ? input.href
        : (input as Request).url;
      outboundHosts.push(new URL(url).host);
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;

    signToken = (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: 'role-key' })
        .setIssuer(issuer)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

    const mod = await import('../server/auth-session.ts?role-channel=1');
    validateBearerToken = mod.validateBearerToken;
  });

  after(() => {
    globalThis.fetch = realFetch;
    jwksServer.close();
    delete process.env.SUPABASE_JWT_ISSUER;
    delete process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_SERVER_SHARED_SECRET;
  });

  it('is free for a plain signed-in user', async () => {
    const result = await validateBearerToken(await signToken({ sub: 'user_plain' }));
    assert.equal(result.valid, true);
    assert.equal(result.role, 'free');
  });

  it('cannot be raised by anything the user controls', async () => {
    // user_metadata is the only per-user store in the token, and Supabase's own
    // docs say not to use it in authorization logic because the account holder
    // can rewrite it without any checks. Every shape a self-granted plan could
    // take must still come back free.
    for (const claims of [
      { sub: 'u1', user_metadata: { role: 'pro' } },
      { sub: 'u2', user_metadata: { plan: 'pro' } },
      { sub: 'u3', app_metadata: { role: 'pro' } },
      { sub: 'u4', app_metadata: { plan: 'pro' } },
      { sub: 'u5', plan: 'pro' },
      { sub: 'u6', role: 'pro' },
    ]) {
      const result = await validateBearerToken(await signToken(claims));
      assert.equal(result.valid, true, `${JSON.stringify(claims)} should verify`);
      assert.equal(result.role, 'free', `${JSON.stringify(claims)} must not grant pro`);
    }
  });

  it('is decided without any network call but the JWKS', async () => {
    // The gates read `role === 'pro'` as an early allow that SKIPS the
    // entitlement row, so a role derived from that same row would push paying
    // subscribers onto the unpriceable-grant branch. Keeping the lookup out of
    // this module is what makes that impossible, so pin it: the only host this
    // call may talk to is the JWKS server.
    outboundHosts.length = 0;
    await validateBearerToken(await signToken({ sub: 'user_no_lookup' }));
    assert.deepEqual(
      [...new Set(outboundHosts)].filter((host) => !host.startsWith('127.0.0.1:')),
      [],
      'validateBearerToken reached a host other than the JWKS server',
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 4: CORS origin matching -- pure logic (independent of auth provider)
// ---------------------------------------------------------------------------

describe('CORS origin matching (convex/http.ts)', () => {
  function matchOrigin(origin: string, pattern: string): boolean {
    if (pattern.startsWith('*.')) {
      return origin.endsWith(pattern.slice(1));
    }
    return origin === pattern;
  }

  function allowedOrigin(origin: string | null, trusted: string[]): string | null {
    if (!origin) return null;
    return trusted.some((p) => matchOrigin(origin, p)) ? origin : null;
  }

  const TRUSTED = [
    'https://worldmonitor.app',
    '*.worldmonitor.app',
    'http://localhost:3000',
  ];

  it('allows exact match', () => {
    assert.equal(allowedOrigin('https://worldmonitor.app', TRUSTED), 'https://worldmonitor.app');
  });

  it('allows wildcard subdomain', () => {
    const origin = 'https://preview-xyz.worldmonitor.app';
    assert.equal(allowedOrigin(origin, TRUSTED), origin);
  });

  it('allows localhost', () => {
    assert.equal(allowedOrigin('http://localhost:3000', TRUSTED), 'http://localhost:3000');
  });

  it('blocks unknown origin', () => {
    assert.equal(allowedOrigin('https://evil.com', TRUSTED), null);
  });

  it('blocks partial domain match', () => {
    assert.equal(allowedOrigin('https://attackerworldmonitor.app', TRUSTED), null);
  });

  it('returns null for null origin -- no ACAO header emitted', () => {
    assert.equal(allowedOrigin(null, TRUSTED), null);
  });
});
