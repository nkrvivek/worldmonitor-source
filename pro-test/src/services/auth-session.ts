/**
 * "Is this visitor signed in right now?" — answered from storage alone.
 *
 * The welcome page uses this to send a returning, actively-signed-in visitor
 * to /dashboard without loading the Supabase SDK on the critical path
 * (issue #4428). The Clerk version read a `__session` cookie; supabase-js
 * keeps its session in localStorage under `sb-<project-ref>-auth-token`, so
 * this reads that instead.
 *
 * The project ref comes from VITE_SUPABASE_URL rather than a second constant,
 * so pointing the build at a different Supabase project cannot leave a stale
 * key here silently reading nothing.
 *
 * Expiry is checked, so a dead session cannot divert an anonymous visitor away
 * from the landing page. An idle signed-in user with an expired access token
 * simply stays put and uses the Launch CTA — the destination still validates
 * auth, and supabase-js will refresh from the refresh token there.
 */

function readSupabaseUrl(): string | undefined {
  try {
    return import.meta.env.VITE_SUPABASE_URL;
  } catch {
    return undefined;
  }
}

/**
 * `https://abcdefgh.supabase.co` → `abcdefgh`. Returns null for anything that
 * is not a URL, so a malformed env value degrades to "signed out" rather than
 * throwing during boot.
 */
export function supabaseProjectRef(supabaseUrl: string | undefined): string | null {
  if (!supabaseUrl) return null;
  try {
    const host = new URL(supabaseUrl).hostname;
    const ref = host.split('.')[0];
    return ref || null;
  } catch {
    return null;
  }
}

export function sessionStorageKey(supabaseUrl: string | undefined): string | null {
  const ref = supabaseProjectRef(supabaseUrl);
  return ref ? `sb-${ref}-auth-token` : null;
}

/**
 * True when the stored session carries an access token that has not expired.
 *
 * supabase-js writes `{ access_token, expires_at, ... }`; `expires_at` is in
 * seconds. Older shapes wrapped it under `currentSession`, so both are read —
 * a visitor whose browser still holds the older shape should not be told they
 * are signed out.
 */
export function hasLiveStoredSession(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const session = (parsed.currentSession ?? parsed) as Record<string, unknown>;
    if (typeof session.access_token !== 'string' || !session.access_token) return false;
    const expiresAt = session.expires_at;
    if (typeof expiresAt !== 'number') return false;
    return expiresAt * 1000 > Date.now();
  } catch {
    return false;
  }
}

/**
 * The raw stored session, or null. Safari in private mode throws on
 * localStorage access; that reads as signed out.
 */
export function readStoredSession(): string | null {
  if (typeof window === 'undefined') return null;
  const key = sessionStorageKey(readSupabaseUrl());
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function hasLiveClientSession(): boolean {
  return hasLiveStoredSession(readStoredSession());
}
