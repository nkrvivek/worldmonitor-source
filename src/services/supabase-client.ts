/**
 * The Supabase browser client, loaded off the critical path.
 *
 * `@supabase/supabase-js` is ~40 KB gzipped and nothing on first paint needs
 * it, so the module is pulled in by dynamic import the first time auth is
 * actually required. `auth.ts` owns when that happens; this file only knows how
 * to build the client and how to say whether auth is configured at all.
 *
 * The project is shared with sibt.ai, so a user signs in once and both sites
 * see the same account.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

function readEnv(name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY'): string | undefined {
  try {
    return import.meta.env[name];
  } catch {
    return undefined;
  }
}

const SUPABASE_URL = readEnv('VITE_SUPABASE_URL');
const SUPABASE_ANON_KEY = readEnv('VITE_SUPABASE_ANON_KEY');

/**
 * True when the browser has both Supabase values. Surfaces that must tell
 * "auth is still hydrating" apart from "auth will never load" read this — the
 * Pro banner deferral in #5728 hangs on a sticky `isPending` without it.
 */
export function isAuthEnabled(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

let clientPromise: Promise<SupabaseClient> | null = null;

/**
 * Build the client, once. Rejects when the env is missing; clears the cached
 * promise on failure so a transient chunk-load error does not permanently
 * disable sign-in.
 */
export function loadSupabaseClient(): Promise<SupabaseClient> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('[auth] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set');
    }
    const { createClient } = await import('@supabase/supabase-js');
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // Keep the session in localStorage and refresh it in the background so
        // a long-lived tab does not start signing requests with a dead token.
        persistSession: true,
        autoRefreshToken: true,
        // The OAuth and email-confirmation redirects both come back with the
        // session in the URL fragment; this consumes and clears it.
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    });
  })().catch((e) => {
    clientPromise = null;
    throw e;
  });
  return clientPromise;
}

/** Test seam: install a stand-in client and skip the dynamic import. */
export function __setSupabaseClientForTests(client: SupabaseClient | null): void {
  clientPromise = client ? Promise.resolve(client) : null;
}
