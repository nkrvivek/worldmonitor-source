import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import {
  getCurrentUser,
  isAuthEnabled,
  scheduleAuthLoad,
  subscribeAuth,
} from './auth';

/** Minimal user profile exposed to UI components. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role: 'free' | 'pro';
}

/** Simplified auth session state for UI consumption. */
export interface AuthSession {
  user: AuthUser | null;
  isPending: boolean;
}

let _currentSession: AuthSession = { user: null, isPending: true };

function snapshotSession(): AuthSession {
  const cu = getCurrentUser();
  if (!cu) {
    enqueueSentryCall((s) => s.setUser(null));
    return { user: null, isPending: false };
  }
  enqueueSentryCall((s) => s.setUser({ id: cu.id }));
  return {
    user: {
      id: cu.id,
      name: cu.name,
      email: cu.email,
      image: cu.image,
      role: cu.plan,
    },
    isPending: false,
  };
}

/**
 * Initialize auth state. Call once at app startup before UI subscribes.
 *
 * Does NOT await `initAuth()` — nothing on first paint needs the auth SDK, so
 * awaiting it here would block the App.init() chain (panel layout, data
 * fetches) on a load the user has not asked for. Schedule it instead, via
 * `scheduleAuthLoad()` (idle callback after first paint).
 *
 * When auth is configured, leaves `_currentSession` at the module-level
 * default `{ user: null, isPending: true }` — calling `snapshotSession()`
 * before the deferred load would make a stored signed-in session look
 * anonymously settled for up to 4 s. The pending-callback queue in auth.ts
 * fires the subscribeAuthState listener as soon as the client loads, snapshots
 * the real session, and flips `isPending` to `false`.
 *
 * When auth is not configured, no authenticated session can appear. Settle
 * immediately as anonymous instead of leaving every auth consumer pending
 * until its own fallback timer expires.
 */
export async function initAuthState(): Promise<void> {
  if (!isAuthEnabled()) {
    _currentSession = snapshotSession();
    return;
  }
  scheduleAuthLoad();
}

/**
 * Subscribe to reactive auth state changes.
 * @returns Unsubscribe function.
 */
export function subscribeAuthState(callback: (state: AuthSession) => void): () => void {
  // Emit current state immediately
  callback(_currentSession);

  return subscribeAuth(() => {
    _currentSession = snapshotSession();
    callback(_currentSession);
  });
}

/**
 * Synchronous snapshot of current auth state.
 */
export function getAuthState(): AuthSession {
  return _currentSession;
}
