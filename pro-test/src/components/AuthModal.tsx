/**
 * Sign-in modal for the /pro pages.
 *
 * Clerk shipped a hosted modal; Supabase does not, so this is it. The copy and
 * the flow deliberately match `src/components/AuthModal.ts` in the dashboard —
 * a visitor who signs in here and one who signs in there should see the same
 * thing — but the two cannot share code: pro-test is a separate Vite app whose
 * `@` alias points at its own root, and the dashboard's version is vanilla DOM.
 *
 * `services/auth.ts` owns when this opens. Any service can call `openSignIn()`
 * without importing React; this component registers itself as the handler.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';

import {
  isAuthEnabled,
  registerAuthSurface,
  sendPasswordReset,
  signInWithGoogle,
  signInWithPassword,
  signUpWithPassword,
  type AuthSurfaceMode,
  type AuthSurfaceRequest,
} from '../services/auth';

type Message = { text: string; kind: 'error' | 'info' } | null;

function GoogleIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

export function AuthModal(): ReactElement | null {
  const [request, setRequest] = useState<AuthSurfaceRequest | null>(null);
  const [mode, setMode] = useState<AuthSurfaceMode>('sign-in');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    registerAuthSurface((req) => {
      setRequest(req);
      if (req) {
        setMode(req.mode);
        setMessage(null);
        setBusy(false);
      }
    });
    return () => registerAuthSurface(null);
  }, []);

  const close = useCallback(() => setRequest(null), []);

  useEffect(() => {
    if (!request) return;
    emailRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [request, close]);

  if (!request) return null;

  const signingUp = mode === 'sign-up';
  const returnUrl = request.returnUrl;

  const onGoogle = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    const res = await signInWithGoogle(returnUrl);
    // On success the browser is already navigating away, so only the failure
    // path needs to hand the form back.
    if (!res.ok) {
      setBusy(false);
      setMessage({ text: res.error ?? 'Google sign-in failed.', kind: 'error' });
    }
  };

  const onForgot = async (): Promise<void> => {
    if (!email.trim()) {
      setMessage({ text: 'Enter your email address first.', kind: 'error' });
      return;
    }
    setBusy(true);
    const res = await sendPasswordReset(email.trim());
    setBusy(false);
    setMessage(
      res.ok
        ? { text: 'Check your email for a reset link.', kind: 'info' }
        : { text: res.error ?? 'Could not send the reset email.', kind: 'error' },
    );
  };

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setMessage({ text: 'Email and password are both required.', kind: 'error' });
      return;
    }
    setBusy(true);
    setMessage(null);
    const res = signingUp
      ? await signUpWithPassword(email.trim(), password, displayName)
      : await signInWithPassword(email.trim(), password);
    if (res.ok && res.needsEmailConfirmation) {
      setBusy(false);
      setMessage({ text: 'Check your email to confirm your account.', kind: 'info' });
      return;
    }
    if (res.ok) {
      close();
      // A pending checkout is resumed by whoever set returnUrl; going there
      // also clears the sign-in state out of the current URL.
      if (returnUrl) window.location.assign(returnUrl);
      return;
    }
    setBusy(false);
    setMessage({ text: res.error ?? 'Something went wrong.', kind: 'error' });
  };

  const input =
    'w-full rounded border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-[#44ff88]';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={signingUp ? 'Create account' : 'Sign in'}
        className="w-full max-w-sm rounded border border-white/15 bg-[#0f0f0f] p-6 font-mono text-white"
      >
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg">{signingUp ? 'Create account' : 'Sign in'}</h2>
          <button type="button" aria-label="Close" onClick={close} className="text-white/50 hover:text-white">
            ✕
          </button>
        </div>

        {!isAuthEnabled() ? (
          <p className="text-sm text-white/70">Sign-in is not configured for this build.</p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void onGoogle()}
              disabled={busy}
              className="mb-4 flex w-full items-center justify-center gap-2 rounded border border-white/20 px-3 py-2 text-sm hover:border-white/40 disabled:opacity-50"
            >
              <GoogleIcon />
              <span>Continue with Google</span>
            </button>

            <form onSubmit={(e) => void onSubmit(e)} className="space-y-3">
              {signingUp && (
                <div>
                  <label className="mb-1 block text-xs text-white/60" htmlFor="wm-auth-name">
                    Display name
                  </label>
                  <input
                    id="wm-auth-name"
                    className={input}
                    placeholder="Optional"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs text-white/60" htmlFor="wm-auth-email">
                  Email
                </label>
                <input
                  id="wm-auth-email"
                  ref={emailRef}
                  type="email"
                  autoComplete="email"
                  className={input}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-white/60" htmlFor="wm-auth-password">
                  Password
                </label>
                <input
                  id="wm-auth-password"
                  type="password"
                  autoComplete={signingUp ? 'new-password' : 'current-password'}
                  className={input}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              {!signingUp && (
                <button
                  type="button"
                  onClick={() => void onForgot()}
                  disabled={busy}
                  className="text-xs text-white/50 underline hover:text-white/80"
                >
                  Forgot your password?
                </button>
              )}

              {message && (
                <p className={message.kind === 'error' ? 'text-xs text-red-400' : 'text-xs text-[#44ff88]'}>
                  {message.text}
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded bg-[#44ff88] px-3 py-2 text-sm font-semibold text-black hover:bg-[#5affa0] disabled:opacity-50"
              >
                {signingUp ? 'Create account' : 'Sign in'}
              </button>
            </form>

            <p className="mt-4 text-center text-xs text-white/60">
              {signingUp ? 'Already have an account? ' : 'No account yet? '}
              <button
                type="button"
                onClick={() => {
                  setMode(signingUp ? 'sign-in' : 'sign-up');
                  setMessage(null);
                }}
                className="underline hover:text-white"
              >
                {signingUp ? 'Sign in' : 'Create one'}
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
