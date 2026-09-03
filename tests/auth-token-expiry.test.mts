/**
 * `getAuthToken()` must never hand out a token that is about to expire.
 *
 * Why this exists (Sentry WORLDMONITOR-XR / XQ, 2026-07-27, under the previous
 * auth provider): a Pro user's session lost its identity on two unrelated
 * endpoints inside the same second — `/api/notification-channels` answered 401
 * and the gateway logged `/api/intelligence/v1/classify-event` 401 with
 * `customer_id` NULL — bracketed by authenticated 429s for the same
 * `customer_id` a minute either side. The session was alive; one short window of
 * requests carried a token the server rejected, and it healed on its own.
 *
 * The cause was a token cache that trusted a flat TTL over the token's own
 * `exp`, so a token handed over with 12s of life left was served for 50s. The
 * Supabase wrapper keeps no cache of its own — supabase-js owns the session —
 * but it still owes the same guarantee, and these tests are that bound: read
 * `exp` from the token, treat a token inside the safety margin as unusable, and
 * refresh before returning one.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  __setAuthForTests,
  clearAuthTokenCache,
  getAuthToken,
  isTokenFresh,
  tokenExpiresAtMs,
} from '../src/services/auth.ts';

const NOW = 1_760_000_000_000;
/** Must match TOKEN_EXPIRY_SAFETY_MARGIN_MS in src/services/auth.ts. */
const SAFETY_MARGIN_MS = 10_000;

afterEach(() => {
  __setAuthForTests(null);
});

/** A JWT whose payload carries an `exp` claim. */
function tokenExpiringAt(expMs: number): string {
  const payload = Buffer.from(JSON.stringify({
    sub: 'user_1',
    exp: Math.floor(expMs / 1_000),
  })).toString('base64url');
  return `header.${payload}.signature`;
}

/** A Supabase session carrying `token`, with `expires_at` derived from it. */
function sessionFor(token: string, expiresAtMs: number): Record<string, unknown> {
  return {
    access_token: token,
    refresh_token: 'refresh',
    token_type: 'bearer',
    expires_in: Math.max(0, Math.floor((expiresAtMs - NOW) / 1_000)),
    expires_at: Math.floor(expiresAtMs / 1_000),
    user: { id: 'user_1' },
  };
}

/**
 * A stand-in Supabase client. `getSession` answers with `stored`; each
 * `refreshSession` call shifts to the next entry of `refreshes`, so a test can
 * script a failure followed by a recovery.
 */
function fakeClient(
  stored: Record<string, unknown> | null,
  refreshes: Array<Record<string, unknown> | null | 'error'> = [],
) {
  const calls = { getSession: 0, refreshSession: 0 };
  const client = {
    auth: {
      getSession: async () => {
        calls.getSession += 1;
        return { data: { session: stored }, error: null };
      },
      refreshSession: async () => {
        const next = refreshes[calls.refreshSession] ?? null;
        calls.refreshSession += 1;
        if (next === 'error') {
          return { data: { session: null }, error: new Error('refresh failed') };
        }
        return { data: { session: next }, error: null };
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  };
  return { client, calls };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the fake client implements only the surface auth.ts touches. */

describe('tokenExpiresAtMs', () => {
  it('reads the exp claim as epoch milliseconds', () => {
    assert.equal(tokenExpiresAtMs(tokenExpiringAt(NOW + 60_000)), NOW + 60_000);
  });

  it('returns null for a token with no exp claim', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user_1' })).toString('base64url');
    assert.equal(tokenExpiresAtMs(`header.${payload}.signature`), null);
  });

  it('returns null rather than throwing on a malformed token', () => {
    assert.equal(tokenExpiresAtMs('not-a-jwt'), null);
    assert.equal(tokenExpiresAtMs('header.@@@notbase64@@@.signature'), null);
    assert.equal(tokenExpiresAtMs(null), null);
  });
});

describe('isTokenFresh', () => {
  it('accepts a token well inside its lifetime', () => {
    const token = tokenExpiringAt(NOW + 3_600_000);
    assert.equal(isTokenFresh(token, null, NOW), true);
  });

  it('rejects a token inside the safety margin before its own expiry', () => {
    const token = tokenExpiringAt(NOW + SAFETY_MARGIN_MS - 1);
    assert.equal(isTokenFresh(token, null, NOW), false);
  });

  it('rejects an already-expired token', () => {
    const token = tokenExpiringAt(NOW - 1_000);
    assert.equal(isTokenFresh(token, null, NOW), false);
  });

  it('falls back to the session expiry when the token carries no exp claim', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user_1' })).toString('base64url');
    const opaque = `header.${payload}.signature`;
    assert.equal(isTokenFresh(opaque, Math.floor((NOW + 60_000) / 1_000), NOW), true);
    assert.equal(isTokenFresh(opaque, Math.floor((NOW - 60_000) / 1_000), NOW), false);
  });

  it('assumes usable when neither the token nor the session states an expiry', () => {
    // Degrade to the old behaviour rather than signing everyone out on a
    // token-format change.
    assert.equal(isTokenFresh('opaque-token', null, NOW), true);
  });

  it('never treats a missing token as fresh', () => {
    assert.equal(isTokenFresh(null, Math.floor((NOW + 60_000) / 1_000), NOW), false);
  });
});

describe('getAuthToken', () => {
  it('returns the stored token when it has plenty of life left', async () => {
    const expiry = Date.now() + 3_600_000;
    const token = tokenExpiringAt(expiry);
    const { client, calls } = fakeClient(sessionFor(token, expiry));
    __setAuthForTests(client as any, sessionFor(token, expiry) as any);

    assert.equal(await getAuthToken(), token);
    assert.equal(calls.refreshSession, 0, 'a healthy token must not trigger a refresh');
  });

  it('refreshes instead of returning a near-expiry token', async () => {
    const nearExpiry = Date.now() + 5_000;
    const stale = tokenExpiringAt(nearExpiry);
    const freshExpiry = Date.now() + 3_600_000;
    const fresh = tokenExpiringAt(freshExpiry);
    const { client, calls } = fakeClient(
      sessionFor(stale, nearExpiry),
      [sessionFor(fresh, freshExpiry)],
    );
    __setAuthForTests(client as any, sessionFor(stale, nearExpiry) as any);

    assert.equal(await getAuthToken(), fresh);
    assert.equal(calls.refreshSession, 1);
  });

  it('falls back to the near-expiry token when the refresh fails but it has not expired', async () => {
    // Better a token the server may still accept than no token at all: the
    // failure is transient and the request is about to be made either way.
    const nearExpiry = Date.now() + 5_000;
    const stale = tokenExpiringAt(nearExpiry);
    const { client } = fakeClient(sessionFor(stale, nearExpiry), ['error']);
    __setAuthForTests(client as any, sessionFor(stale, nearExpiry) as any);

    assert.equal(await getAuthToken(), stale);
  });

  it('returns null when the refresh fails and the token has already expired', async () => {
    const expired = Date.now() - 1_000;
    const token = tokenExpiringAt(expired);
    const { client } = fakeClient(sessionFor(token, expired), ['error']);
    __setAuthForTests(client as any, sessionFor(token, expired) as any);

    assert.equal(await getAuthToken(), null);
  });

  it('returns null when no session is stored', async () => {
    const { client } = fakeClient(null);
    __setAuthForTests(client as any, null);

    assert.equal(await getAuthToken(), null);
  });

  it('returns null when no client could be loaded', async () => {
    __setAuthForTests(null);
    assert.equal(await getAuthToken(), null);
  });

  it('refreshes a healthy token once the cache is cleared', async () => {
    // Convex reports 401 through forceRefreshToken, or the observed account
    // changed. Either way the stored token is no longer trusted.
    const expiry = Date.now() + 3_600_000;
    const stored = tokenExpiringAt(expiry);
    const nextExpiry = Date.now() + 3_600_000;
    const next = tokenExpiringAt(nextExpiry + 1_000);
    const { client, calls } = fakeClient(
      sessionFor(stored, expiry),
      [sessionFor(next, nextExpiry)],
    );
    __setAuthForTests(client as any, sessionFor(stored, expiry) as any);

    clearAuthTokenCache();
    assert.equal(await getAuthToken(), next);
    assert.equal(calls.refreshSession, 1);

    // The forced refresh is one-shot — the next call trusts the new token.
    assert.equal(await getAuthToken(), stored);
    assert.equal(calls.refreshSession, 1);
  });

  it('shares one in-flight request across concurrent callers', async () => {
    const nearExpiry = Date.now() + 5_000;
    const stale = tokenExpiringAt(nearExpiry);
    const freshExpiry = Date.now() + 3_600_000;
    const fresh = tokenExpiringAt(freshExpiry);
    const { client, calls } = fakeClient(
      sessionFor(stale, nearExpiry),
      [sessionFor(fresh, freshExpiry)],
    );
    __setAuthForTests(client as any, sessionFor(stale, nearExpiry) as any);

    const [a, b, c] = await Promise.all([getAuthToken(), getAuthToken(), getAuthToken()]);
    assert.deepEqual([a, b, c], [fresh, fresh, fresh]);
    assert.equal(calls.refreshSession, 1, 'three callers must not mint three refreshes');
  });
});
