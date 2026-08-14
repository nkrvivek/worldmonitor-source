/**
 * Auth for the browser, on top of Supabase.
 *
 * Three things start the load:
 *   1. `scheduleAuthLoad()` — an idle callback after first paint, which is what
 *      the main app boot path uses (called from auth-state.ts).
 *   2. A click — `openSignIn` / `openSignUp` force the load on first call.
 *   3. Anything that needs a JWT — `getAuthToken()` forces it through
 *      `initAuth()` (the mcp-grant page calls that directly).
 *
 * `subscribeAuth()` queues callbacks issued before the client is live, so
 * `subscribeAuthState()` keeps working across the deferred-load window. Once
 * the client hydrates, queued callbacks attach and fire once, so a stored
 * session lights up the UI without a refresh.
 *
 * Tokens are NOT cached here. supabase-js keeps the session in localStorage and
 * refreshes it on a timer, so a second cache on top would re-create the stale
 * -token defect (WORLDMONITOR-XR/XQ) that the Clerk version had to grow clock
 * calibration to fix. All this file adds is a near-expiry check, because
 * `getSession()` will happily hand back a token with two seconds left on it.
 */

import type { Session, SupabaseClient, User } from '@supabase/supabase-js';

import { enqueueSentryCall } from '@/bootstrap/sentry-defer';

import {
  isAuthEnabled,
  loadSupabaseClient,
} from './supabase-client';

export { isAuthEnabled };

let client: SupabaseClient | null = null;
let currentSession: Session | null = null;
let loadPromise: Promise<void> | null = null;
let loadScheduled = false;
let forceRefreshNext = false;

const pendingSubscribers: Array<() => void> = [];
const pendingSubscriberDetachers = new WeakMap<() => void, { detached: boolean }>();
const activeListenerDetachers = new WeakMap<() => void, () => void>();
const liveSubscribers = new Set<() => void>();

/**
 * How long before a token's own `exp` we stop handing it out.
 *
 * `server/auth-session.ts` allows only a small clock tolerance. This margin
 * keeps request flight time from eating that whole allowance.
 */
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 10_000;

/** Where to land after sign-out. */
function afterSignOutUrl(): string {
  // The current URL may carry stale checkout params or a session fragment that
  // has no business surviving into a signed-out state, so pin this to the
  // origin root. That is also unambiguous inside the Tauri WKWebView.
  return new URL('/', window.location.origin).toString();
}

function notifySubscribers(): void {
  for (const cb of liveSubscribers) {
    try {
      cb();
    } catch {
      // One subscriber must not block the rest of the fan-out.
    }
  }
}

/** Drain the queue once the client is live. */
function attachPendingSubscribers(): void {
  const queued = pendingSubscribers.splice(0, pendingSubscribers.length);
  for (const cb of queued) {
    if (pendingSubscriberDetachers.get(cb)?.detached) continue;
    liveSubscribers.add(cb);
    activeListenerDetachers.set(cb, () => liveSubscribers.delete(cb));
    // Fire once so a stored session that was already present before the client
    // finished loading becomes visible.
    try {
      cb();
    } catch {
      // As above.
    }
  }
}

/**
 * Fire queued subscribers without consuming the queue. Used when `initAuth()`
 * fails, so `subscribeAuthState` can settle on `{ user: null, isPending: false }`
 * instead of leaving the whole app on the boot-default pending session. The
 * queue survives, so a later successful retry can still attach and re-fire.
 */
function notifyPendingSubscribersOfHydrationFailure(): void {
  for (const cb of pendingSubscribers) {
    if (pendingSubscriberDetachers.get(cb)?.detached) continue;
    try {
      cb();
    } catch {
      // As above.
    }
  }
}

/**
 * Load Supabase now. Call when a session is needed synchronously (mcp-grant
 * bootstrap, the first authenticated request). Idempotent — repeat calls return
 * the same in-flight promise.
 */
export async function initAuth(): Promise<void> {
  if (client) return;
  if (loadPromise) return loadPromise;
  if (!isAuthEnabled()) {
    console.warn('[auth] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set, auth disabled');
    return;
  }
  loadPromise = (async () => {
    try {
      const supabase = await loadSupabaseClient();
      const { data } = await supabase.auth.getSession();
      currentSession = data.session;
      supabase.auth.onAuthStateChange((_event, session) => {
        currentSession = session;
        notifySubscribers();
      });
      client = supabase;
      attachPendingSubscribers();
    } catch (e) {
      loadPromise = null; // allow retry
      notifyPendingSubscribersOfHydrationFailure();
      throw e;
    }
  })();
  return loadPromise;
}

/**
 * Start the load off the critical path. Returns as soon as it is scheduled; the
 * import runs on `requestIdleCallback` (or after `load` plus a microtask where
 * that does not exist). Callers that later need the client synchronously can
 * still `await initAuth()`.
 */
export function scheduleAuthLoad(): void {
  if (client || loadPromise || loadScheduled) return;
  if (!isAuthEnabled()) return;
  if (typeof window === 'undefined') return;
  loadScheduled = true;

  const startLoad = (): void => {
    // initAuth's own guard handles re-entry from a concurrent force-load (the
    // user clicked Sign In before the idle callback fired). Reset the flag on
    // failure so a later call is not silently blocked.
    void initAuth().catch(() => {
      loadScheduled = false;
    });
  };

  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(startLoad, { timeout: 4000 });
    return;
  }
  if (document.readyState === 'complete') {
    setTimeout(startLoad, 0);
  } else {
    window.addEventListener('load', () => setTimeout(startLoad, 0), { once: true });
  }
}

/** The Supabase client, or null when it has not loaded yet. */
export function getAuthClient(): SupabaseClient | null {
  return client;
}

/** The signed-in Supabase user, or null. */
export function getAuthUser(): User | null {
  return currentSession?.user ?? null;
}

/**
 * Epoch ms of the current account's creation, or null when signed out. Read
 * straight from the user record so analytics can spot a fresh signup without
 * widening the UI projection below.
 */
export function getUserCreatedAtMs(): number | null {
  const createdAt = currentSession?.user?.created_at;
  if (!createdAt) return null;
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * What the UI needs about the signed-in account. Returns null when signed out.
 *
 * `plan` is always `'free'`. Supabase's only per-user token store is
 * `user_metadata`, which its own docs call "editable by the user without any
 * checks", so nothing in the token may grant Pro. The Convex entitlement row is
 * the sole answer, on the client exactly as on the server — see
 * `server/auth-session.ts`. Name and avatar come from `user_metadata` too, but
 * those are display only, and a user renaming themselves grants nothing.
 */
export function getCurrentUser(): {
  id: string;
  name: string;
  email: string;
  image: string | null;
  plan: 'free' | 'pro';
} | null {
  const user = currentSession?.user;
  if (!user) return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  const email = str(user.email) ?? '';
  return {
    id: user.id,
    name: str(meta.display_name) ?? str(meta.full_name) ?? str(meta.name) ?? email.split('@')[0] ?? 'User',
    email,
    image: str(meta.avatar_url) ?? str(meta.picture),
    plan: 'free',
  };
}

/**
 * Subscribe to auth changes. Returns the unsubscribe function.
 *
 * Callbacks issued before the client finishes its deferred load are queued and
 * attached once it does, then fired once so a stored session becomes visible
 * without a refresh. The returned detacher works whether the client ever loads
 * or not.
 */
export function subscribeAuth(callback: () => void): () => void {
  if (client) {
    liveSubscribers.add(callback);
    return () => liveSubscribers.delete(callback);
  }
  const handle = { detached: false };
  pendingSubscriberDetachers.set(callback, handle);
  pendingSubscribers.push(callback);
  return () => {
    handle.detached = true;
    const i = pendingSubscribers.indexOf(callback);
    if (i >= 0) pendingSubscribers.splice(i, 1);
    const detach = activeListenerDetachers.get(callback);
    if (detach) {
      detach();
      activeListenerDetachers.delete(callback);
    }
  };
}

/**
 * The `exp` claim of a JWT as epoch ms, or null when it cannot be read.
 *
 * Null rather than a throw keeps an unreadable token on the "assume usable"
 * path, so a token-format change degrades to the old behaviour instead of
 * signing everyone out. Reading `exp` needs no signature check: the server is
 * the authority, and a forged `exp` can only make this client refresh sooner.
 */
export function tokenExpiresAtMs(token: string | null): number | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(
      atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)),
    ) as Record<string, unknown>;
    const exp = claims.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1_000 : null;
  } catch {
    return null;
  }
}

/**
 * Whether a session's access token still has enough life to sign a request.
 *
 * Prefers the token's own `exp` and falls back to the session's `expires_at`,
 * which supabase-js computes from the same claim. Exported for testing.
 */
export function isTokenFresh(
  token: string | null,
  expiresAtSeconds: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!token) return false;
  const expiresAt = tokenExpiresAtMs(token)
    ?? (typeof expiresAtSeconds === 'number' ? expiresAtSeconds * 1_000 : null);
  if (expiresAt === null) return true;
  return now < expiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS;
}

/**
 * Drop the current token. Call when Convex reports a 401 through
 * `forceRefreshToken`, or when the observed account changes. The next
 * `getAuthToken()` asks Supabase for a new one rather than reusing what is in
 * storage.
 */
export function clearAuthTokenCache(): void {
  forceRefreshNext = true;
}

let tokenInflight: Promise<string | null> | null = null;

/**
 * A bearer token for API requests, or null when signed out.
 *
 * supabase-js owns the caching and the background refresh; this only forces a
 * refresh when the stored token is inside the expiry margin, or when
 * `clearAuthTokenCache()` asked for one.
 */
export async function getAuthToken(): Promise<string | null> {
  if (tokenInflight) return tokenInflight;
  const promise: Promise<string | null> = (async () => {
    try {
      if (!client && isAuthEnabled()) {
        try {
          await initAuth();
        } catch {
          return null; // load failed; caller proceeds unauthenticated
        }
      }
      if (!client) return null;

      // Pin the client this fetch belongs to. A sign-out swaps the module-level
      // client while a fetch is in flight, and the token that lands afterwards
      // belongs to the account that just left — handing it to a caller is how a
      // departing session's credential reaches the next request.
      const owner = client;
      const stillOurs = (): boolean => client === owner;

      const { data, error } = await owner.auth.getSession();
      if (error || !stillOurs()) return null;
      const session = data.session;
      if (!session) return null;

      const mustRefresh = forceRefreshNext
        || !isTokenFresh(session.access_token, session.expires_at);
      if (!mustRefresh) return session.access_token;

      const refreshed = await owner.auth.refreshSession();
      if (!stillOurs()) return null;
      forceRefreshNext = false;
      if (refreshed.error || !refreshed.data.session) {
        // The refresh failed. Hand back the stored token only while it is still
        // genuinely unexpired — better a request that may 401 than one the user
        // cannot make at all — and never once it is past `exp`.
        const expiresAt = tokenExpiresAtMs(session.access_token);
        if (expiresAt === null || Date.now() < expiresAt) return session.access_token;
        return null;
      }
      currentSession = refreshed.data.session;
      return refreshed.data.session.access_token;
    } catch {
      return null;
    }
  })();
  tokenInflight = promise;
  // Retire only our own entry, and only after it is installed: a sign-out
  // mid-flight puts a fresh promise in this slot, and clearing that one would
  // let two fetches run against the same account.
  void promise.finally(() => {
    if (tokenInflight === promise) tokenInflight = null;
  });
  return promise;
}

/** Sign out and clear the local session. */
export async function signOut(): Promise<void> {
  clearAuthTokenCache();
  try {
    await client?.auth.signOut();
  } finally {
    currentSession = null;
    notifySubscribers();
  }
  if (typeof window !== 'undefined') window.location.assign(afterSignOutUrl());
}

export interface AuthResult {
  ok: boolean;
  /** Set when the account was created but still needs email confirmation. */
  needsEmailConfirmation?: boolean;
  error?: string;
}

function authErrorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Sign in with an email address and password. */
export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  try {
    await initAuth();
    if (!client) return { ok: false, error: 'Auth is not configured.' };
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: authErrorMessage(e, 'Sign-in failed.') };
  }
}

/** Create an account with an email address and password. */
export async function signUpWithPassword(
  email: string,
  password: string,
  displayName?: string,
): Promise<AuthResult> {
  try {
    await initAuth();
    if (!client) return { ok: false, error: 'Auth is not configured.' };
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName?.trim() || email.split('@')[0] },
        emailRedirectTo: `${window.location.origin}/`,
      },
    });
    if (error) return { ok: false, error: error.message };
    // Supabase returns a user with no identities when the address is already
    // registered, rather than an error, so the caller cannot tell without this.
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      return { ok: false, error: 'An account with this email already exists. Try signing in.' };
    }
    if (data.user && !data.session) return { ok: true, needsEmailConfirmation: true };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: authErrorMessage(e, 'Sign-up failed.') };
  }
}

/** Hand off to Google. Resolves once the redirect is under way. */
export async function signInWithGoogle(): Promise<AuthResult> {
  try {
    await initAuth();
    if (!client) return { ok: false, error: 'Auth is not configured.' };
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: new URL('/', window.location.origin).toString() },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: authErrorMessage(e, 'Google sign-in failed.') };
  }
}

/** Send a password-reset email. */
export async function sendPasswordReset(email: string): Promise<AuthResult> {
  try {
    await initAuth();
    if (!client) return { ok: false, error: 'Auth is not configured.' };
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: new URL('/', window.location.origin).toString(),
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: authErrorMessage(e, 'Could not send the reset email.') };
  }
}

function reportSurfaceFailure(action: string, err: unknown): void {
  enqueueSentryCall((Sentry) => {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { surface: 'auth', action },
    });
  });
}

function openAuthSurface(mode: 'sign-in' | 'sign-up'): void {
  // boundary-ignore: lazy dynamic import, so no load-time coupling to components
  void import('@/components/AuthModal')
    .then(({ openAuthModal }) => openAuthModal(mode))
    .catch((err) => {
      console.error(`[auth] could not open the ${mode} modal:`, err);
      reportSurfaceFailure(`open-${mode}`, err);
    });
}

/** Open the sign-in modal. */
export function openSignIn(): void {
  openAuthSurface('sign-in');
}

/** Open the sign-up modal. */
export function openSignUp(): void {
  openAuthSurface('sign-up');
}

/** Test seam: install a client and session without touching the network. */
export function __setAuthForTests(
  testClient: SupabaseClient | null,
  session: Session | null = null,
): void {
  client = testClient;
  currentSession = session;
  loadPromise = null;
  loadScheduled = false;
  forceRefreshNext = false;
  tokenInflight = null;
  if (testClient) attachPendingSubscribers();
}
