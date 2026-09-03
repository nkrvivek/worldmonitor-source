import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  startAuthUserStateSync,
  type AuthUserState,
  type AuthUserStateSource,
  type AuthUserStateUpdate,
} from '../pro-test/src/services/auth-user-state.ts';
import {
  hasLiveClientSession,
  hasLiveStoredSession,
  sessionStorageKey,
  supabaseProjectRef,
} from '../pro-test/src/services/auth-session.ts';
import { maybeRedirectWelcomeVisitor } from '../pro-test/src/services/welcome-redirect.ts';

const nowSec = Math.floor(Date.now() / 1000);

/** What supabase-js writes under `sb-<ref>-auth-token`. */
function storedSession(expiresAt: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ access_token: 'at_123', expires_at: expiresAt, ...extra });
}

describe('welcome auth probe — supabaseProjectRef', () => {
  it('takes the ref from the project URL', () => {
    assert.equal(supabaseProjectRef('https://abcdefgh.supabase.co'), 'abcdefgh');
    assert.equal(supabaseProjectRef('https://abcdefgh.supabase.co/'), 'abcdefgh');
  });

  it('is null for an absent or malformed URL', () => {
    assert.equal(supabaseProjectRef(undefined), null);
    assert.equal(supabaseProjectRef(''), null);
    assert.equal(supabaseProjectRef('not a url'), null);
  });

  it('builds the storage key supabase-js uses, or null with no ref', () => {
    assert.equal(sessionStorageKey('https://abcdefgh.supabase.co'), 'sb-abcdefgh-auth-token');
    assert.equal(sessionStorageKey(undefined), null);
  });
});

describe('welcome auth probe — hasLiveStoredSession (live access token only)', () => {
  it('is true for an unexpired session', () => {
    assert.equal(hasLiveStoredSession(storedSession(nowSec + 3600)), true);
    assert.equal(hasLiveStoredSession(storedSession(nowSec + 60)), true);
  });

  it('is false for an expired session', () => {
    assert.equal(hasLiveStoredSession(storedSession(nowSec - 1)), false);
    assert.equal(hasLiveStoredSession(storedSession(nowSec - 3600)), false);
  });

  it('is false when expires_at is missing or not a number', () => {
    assert.equal(hasLiveStoredSession(JSON.stringify({ access_token: 'at_123' })), false);
    assert.equal(
      hasLiveStoredSession(JSON.stringify({ access_token: 'at_123', expires_at: '9999999999' })),
      false
    );
  });

  it('is false when there is no access token', () => {
    assert.equal(hasLiveStoredSession(JSON.stringify({ expires_at: nowSec + 3600 })), false);
    assert.equal(
      hasLiveStoredSession(JSON.stringify({ access_token: '', expires_at: nowSec + 3600 })),
      false
    );
  });

  it('reads the older currentSession wrapper', () => {
    const raw = JSON.stringify({ currentSession: { access_token: 'at_123', expires_at: nowSec + 3600 } });
    assert.equal(hasLiveStoredSession(raw), true);
  });

  it('is false for absent or unparseable storage', () => {
    assert.equal(hasLiveStoredSession(null), false);
    assert.equal(hasLiveStoredSession(''), false);
    assert.equal(hasLiveStoredSession('not json'), false);
  });
});

describe('welcome auth probe — hasLiveClientSession browser wrapper', () => {
  it('is false in SSR/prerender contexts without window', () => {
    assert.equal(hasLiveClientSession(), false);
  });
});

describe('welcome auth probe — auth hook remount ordering', () => {
  function flushBatchedUpdates(initial: AuthUserState, updates: AuthUserStateUpdate[]): AuthUserState {
    return updates.reduce((state, update) => (
      typeof update === 'function' ? update(state) : update
    ), initial);
  }

  it('preserves an already-loaded user when the hook remounts', () => {
    const realUser = { id: 'user_pro_123' } as NonNullable<AuthUserState['user']>;
    const updates: AuthUserStateUpdate[] = [];
    let loadSubscribed = false;
    let authSubscribed = false;
    let scheduled = false;
    const auth: AuthUserStateSource = {
      user: realUser,
      addListener() {
        authSubscribed = true;
        return () => { authSubscribed = false; };
      },
    };

    const cleanup = startAuthUserStateSync((update) => {
      updates.push(update);
    }, {
      hasLiveClientSession: () => true,
      subscribeAuthLoaded(cb) {
        loadSubscribed = true;
        cb(auth);
        return () => { loadSubscribed = false; };
      },
      scheduleAuthLoad() {
        scheduled = true;
        return Promise.resolve(auth);
      },
      onLoadError(err) {
        throw err;
      },
    });

    const finalState = flushBatchedUpdates(
      { user: null, isLoaded: true, signedIn: true },
      updates
    );
    assert.equal(finalState.user, realUser);
    assert.equal(finalState.signedIn, true);
    assert.equal(finalState.isLoaded, true);
    assert.equal(loadSubscribed, true);
    assert.equal(authSubscribed, true);
    assert.equal(scheduled, true);

    cleanup();
    assert.equal(loadSubscribed, false);
    assert.equal(authSubscribed, false);
  });
});

describe('welcome auth probe — welcome redirect behavior', () => {
  function redirectProbe(raw: string | null, search = '?ref=welcome&lang=ar', hash = '#depth') {
    const targets: string[] = [];
    const redirected = maybeRedirectWelcomeVisitor(raw, {
      search,
      hash,
      replace(target) {
        targets.push(target);
      },
    });
    return { redirected, targets };
  }

  it('redirects live sessions to /dashboard while preserving query and hash', () => {
    assert.deepEqual(
      redirectProbe(storedSession(nowSec + 3600)),
      {
        redirected: true,
        targets: ['/dashboard?ref=welcome&lang=ar#depth'],
      }
    );
  });

  it('redirects live sessions to the bare dashboard path when no query/hash exists', () => {
    assert.deepEqual(
      redirectProbe(storedSession(nowSec + 3600), '', ''),
      {
        redirected: true,
        targets: ['/dashboard'],
      }
    );
  });

  it('does not redirect expired or absent sessions', () => {
    assert.deepEqual(redirectProbe(storedSession(nowSec - 1)), {
      redirected: false,
      targets: [],
    });
    assert.deepEqual(redirectProbe(null), {
      redirected: false,
      targets: [],
    });
  });
});
