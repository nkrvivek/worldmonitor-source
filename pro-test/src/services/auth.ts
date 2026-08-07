/**
 * Auth for the /pro marketing pages, on top of Supabase.
 *
 * This is the pro-test twin of `src/services/auth.ts` in the main app. The two
 * cannot share a module: pro-test is a separate Vite app whose `@` alias points
 * at its own root, so it has no path into the dashboard's source tree.
 *
 * The Supabase project is shared with sibt.ai and with the dashboard, so a
 * visitor who signed in on /dashboard is already signed in here — same origin,
 * same localStorage, same session.
 *
 * Loading is deferred. Nothing on first paint needs the SDK: the navbar's
 * signed-in state comes from `auth-session.ts` reading storage directly, and
 * the SDK is pulled in only when someone clicks sign-in or starts checkout.
 * The Clerk build this replaces shipped a 3 MB chunk on the critical path.
 */

import type { Session, SupabaseClient, User } from '@supabase/supabase-js';

/** What callers get back: the current user, plus a change subscription. */
export interface AuthApi {
  readonly user: User | null;
  addListener(cb: () => void): () => void;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  needsEmailConfirmation?: boolean;
}

/** How long before a token's own `exp` we stop handing it out. */
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 10_000;

/** How long to wait for an idle slot before loading anyway. */
const IDLE_LOAD_TIMEOUT_MS = 4_000;

function readEnv(name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY'): string | undefined {
  try {
    return import.meta.env[name];
  } catch {
    return undefined;
  }
}

const SUPABASE_URL = readEnv('VITE_SUPABASE_URL');
const SUPABASE_ANON_KEY = readEnv('VITE_SUPABASE_ANON_KEY');

/** True when the build has both Supabase values. */
export function isAuthEnabled(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

let client: SupabaseClient | null = null;
let currentSession: Session | null = null;
let loadPromise: Promise<AuthApi> | null = null;
let scheduledLoadPromise: Promise<AuthApi> | null = null;

const listeners = new Set<() => void>();
const loadedSubscribers = new Set<(api: AuthApi) => void>();

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // One listener must not block the rest of the fan-out.
    }
  }
}

const api: AuthApi = {
  get user(): User | null {
    return currentSession?.user ?? null;
  },
  addListener(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

/**
 * Build the client and attach the session listener, once.
 *
 * Only publishes the client after the first session read succeeds, so a failed
 * load leaves `ensureAuth()` retryable rather than wedged half-initialised.
 */
async function loadAuth(): Promise<AuthApi> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('[auth] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set');
  }
  const { createClient } = await import('@supabase/supabase-js');
  const instance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // The Google and email-confirmation redirects both come back with the
      // session in the URL fragment; this consumes and clears it.
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  });
  const { data } = await instance.auth.getSession();
  currentSession = data.session;
  instance.auth.onAuthStateChange((_event, session) => {
    currentSession = session;
    notify();
  });
  client = instance;
  for (const cb of loadedSubscribers) {
    try {
      cb(api);
    } catch {
      // Same reasoning as notify().
    }
  }
  return api;
}

/** Load the SDK now. Callers that need a token or a sign-in surface use this. */
export function ensureAuth(): Promise<AuthApi> {
  if (client) return Promise.resolve(api);
  if (!loadPromise) {
    loadPromise = loadAuth().catch((err) => {
      loadPromise = null;
      scheduledLoadPromise = null;
      throw err;
    });
  }
  return loadPromise;
}

/**
 * Load the SDK when the browser is idle. Returns null when there is nothing to
 * load — no window, or no Supabase config — so callers can tell "will never
 * load" apart from "still loading".
 */
export function scheduleAuthLoad(): Promise<AuthApi> | null {
  if (client) return Promise.resolve(api);
  if (loadPromise) return loadPromise;
  if (scheduledLoadPromise) return scheduledLoadPromise;
  if (typeof window === 'undefined') return null;
  if (!isAuthEnabled()) return null;

  scheduledLoadPromise = new Promise<AuthApi>((resolve, reject) => {
    const start = (): void => {
      ensureAuth().then(resolve, reject);
    };
    const idle = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    }).requestIdleCallback;
    if (typeof idle === 'function') {
      idle(start, { timeout: IDLE_LOAD_TIMEOUT_MS });
    } else if (document.readyState === 'complete') {
      setTimeout(start, 0);
    } else {
      window.addEventListener('load', () => setTimeout(start, 0), { once: true });
    }
  });
  return scheduledLoadPromise;
}

/**
 * Run `cb` once the SDK is live. Fires immediately if it already is, so a
 * subscriber that arrives late still sees the current user.
 */
export function subscribeAuthLoaded(cb: (auth: AuthApi) => void): () => void {
  if (client) {
    cb(api);
    return () => {};
  }
  loadedSubscribers.add(cb);
  return () => loadedSubscribers.delete(cb);
}

function tokenExpiresAtMs(token: string | null): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * A JWT for the API, or null when signed out.
 *
 * No cache lives here: supabase-js already keeps the session in localStorage
 * and refreshes it on a timer, and a second cache on top is what produced the
 * stale-token defects the Clerk build had to grow clock calibration to fix.
 * The only thing added is a near-expiry check, because `getSession()` will
 * hand back a token with two seconds left on it.
 */
export async function getAuthToken(): Promise<string | null> {
  const auth = await ensureAuth().catch(() => null);
  if (!auth || !client) return null;
  const { data } = await client.auth.getSession();
  currentSession = data.session;
  const token = data.session?.access_token ?? null;
  if (!token) return null;
  const expiresAt = tokenExpiresAtMs(token);
  if (expiresAt !== null && expiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS <= Date.now()) {
    const refreshed = await client.auth.refreshSession();
    currentSession = refreshed.data.session;
    return refreshed.data.session?.access_token ?? null;
  }
  return token;
}

export function getCurrentUser(): User | null {
  return currentSession?.user ?? null;
}

function authErrorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  try {
    await ensureAuth();
    if (!client) return { ok: false, error: 'Auth is not configured.' };
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: authErrorMessage(e, 'Sign-in failed.') };
  }
}

export async function signUpWithPassword(
  email: string,
  password: string,
  displayName?: string,
): Promise<AuthResult> {
  try {
    await ensureAuth();
    if (!client) return { ok: false, error: 'Auth is not configured.' };
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName?.trim() || email.split('@')[0] },
        emailRedirectTo: window.location.href,
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

/**
 * Hand off to Google, coming back to `returnUrl`.
 *
 * `returnUrl` is what carries a pending checkout across the round trip: the
 * caller encodes the clicked plan into it, and the resumed page reads it back.
 */
export async function signInWithGoogle(returnUrl?: string): Promise<AuthResult> {
  try {
    await ensureAuth();
    if (!client) return { ok: false, error: 'Auth is not configured.' };
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: returnUrl ?? window.location.href },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: authErrorMessage(e, 'Google sign-in failed.') };
  }
}

export async function sendPasswordReset(email: string): Promise<AuthResult> {
  try {
    await ensureAuth();
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

export async function signOut(): Promise<void> {
  try {
    await ensureAuth();
    await client?.auth.signOut();
  } catch {
    // Signing out is best-effort; the local session is cleared either way.
  }
  currentSession = null;
  notify();
}

/* ------------------------------------------------------------------ *
 * Sign-in surface
 *
 * Clerk shipped its own modal. Supabase does not, so the modal lives in
 * `components/AuthModal.tsx` and this is the channel that opens it: any
 * service can ask for sign-in without importing React.
 * ------------------------------------------------------------------ */

export type AuthSurfaceMode = 'sign-in' | 'sign-up';

export interface AuthSurfaceRequest {
  mode: AuthSurfaceMode;
  /** Where Google should return to. Defaults to the current URL. */
  returnUrl?: string;
}

type AuthSurfaceHandler = (req: AuthSurfaceRequest | null) => void;

let surfaceHandler: AuthSurfaceHandler | null = null;
let pendingSurfaceRequest: AuthSurfaceRequest | null = null;

/** The modal registers itself here on mount. */
export function registerAuthSurface(handler: AuthSurfaceHandler | null): void {
  surfaceHandler = handler;
  if (handler && pendingSurfaceRequest) {
    const queued = pendingSurfaceRequest;
    pendingSurfaceRequest = null;
    handler(queued);
  }
}

function openAuthSurface(req: AuthSurfaceRequest): void {
  // Start the SDK load now: by the time the visitor has typed a password it
  // should already be there.
  scheduleAuthLoad();
  if (surfaceHandler) surfaceHandler(req);
  else pendingSurfaceRequest = req;
}

export function openSignIn(returnUrl?: string): void {
  openAuthSurface({ mode: 'sign-in', returnUrl });
}

export function openSignUp(returnUrl?: string): void {
  openAuthSurface({ mode: 'sign-up', returnUrl });
}

export function closeAuthSurface(): void {
  pendingSurfaceRequest = null;
  surfaceHandler?.(null);
}

/** Test seam: install a client and session without touching the network. */
export function __setAuthForTests(
  testClient: SupabaseClient | null,
  session: Session | null = null,
): void {
  client = testClient;
  currentSession = session;
  loadPromise = testClient ? Promise.resolve(api) : null;
  scheduledLoadPromise = null;
}
