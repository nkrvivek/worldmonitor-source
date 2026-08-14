import type { User } from '@supabase/supabase-js';

export type AuthUserState = { user: User | null; isLoaded: boolean; signedIn: boolean };
export type AuthUserStateUpdate = AuthUserState | ((current: AuthUserState) => AuthUserState);
export type AuthUserStateSetter = (update: AuthUserStateUpdate) => void;

export type AuthUserStateSource = {
  user: User | null;
  addListener(cb: () => void): () => void;
};

type AuthUserStateSyncDeps = {
  hasLiveClientSession(): boolean;
  subscribeAuthLoaded(cb: (auth: AuthUserStateSource) => void): () => void;
  scheduleAuthLoad(): Promise<AuthUserStateSource> | null;
  onLoadError(err: unknown): void;
};

function applyClientSessionBaseline(current: AuthUserState, signedIn: boolean): AuthUserState {
  return current.user === null && current.isLoaded === true && current.signedIn === signedIn
    ? current
    : { user: null, isLoaded: true, signedIn };
}

function stateFromAuth(auth: AuthUserStateSource): AuthUserState {
  const user = auth.user ?? null;
  return { user, isLoaded: true, signedIn: !!user };
}

export function startAuthUserStateSync(
  setState: AuthUserStateSetter,
  deps: AuthUserStateSyncDeps
): () => void {
  let mounted = true;
  let unsubscribeAuth: (() => void) | undefined;
  const setFromAuth = (auth: AuthUserStateSource): void => {
    if (!mounted) return;
    setState(stateFromAuth(auth));
    if (!unsubscribeAuth) {
      unsubscribeAuth = auth.addListener(() => {
        if (!mounted) return;
        setState(stateFromAuth(auth));
      });
    }
  };

  const signedIn = deps.hasLiveClientSession();
  // subscribeAuthLoaded fires synchronously once the SDK is live. Queue the
  // storage baseline first so the real user wins React's batched remount.
  setState((current) => applyClientSessionBaseline(current, signedIn));
  const unsubscribeLoaded = deps.subscribeAuthLoaded(setFromAuth);

  if (signedIn) {
    const scheduled = deps.scheduleAuthLoad();
    if (!scheduled) {
      setState({ user: null, isLoaded: true, signedIn: false });
    } else {
      scheduled.catch((err) => {
        if (mounted) deps.onLoadError(err);
      });
    }
  }

  return () => {
    mounted = false;
    unsubscribeLoaded();
    unsubscribeAuth?.();
  };
}
