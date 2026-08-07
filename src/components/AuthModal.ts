/**
 * Sign-in and sign-up, in one modal.
 *
 * Clerk shipped this surface as a hosted widget. Supabase ships only the API,
 * so the form lives here. It offers what sibt.ai offers on the same user pool:
 * Google, and email with a password.
 *
 * Styling comes from the shared `.modal-overlay` / `.modal` classes and the
 * theme variables, so light and dark both work without a second code path.
 */

import {
  isAuthEnabled,
  sendPasswordReset,
  signInWithGoogle,
  signInWithPassword,
  signUpWithPassword,
} from '@/services/auth';
import { subscribeAuthState } from '@/services/auth-state';

export type AuthModalMode = 'sign-in' | 'sign-up';

let overlay: HTMLElement | null = null;
let unsubscribeAuth: (() => void) | null = null;
let lastFocused: HTMLElement | null = null;

/** Close the modal and put focus back where it was. */
export function closeAuthModal(): void {
  unsubscribeAuth?.();
  unsubscribeAuth = null;
  overlay?.remove();
  overlay = null;
  document.removeEventListener('keydown', onKeydown);
  lastFocused?.focus?.();
  lastFocused = null;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeAuthModal();
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function googleIcon(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('aria-hidden', 'true');
  const paths: Array<[string, string]> = [
    ['#4285F4', 'M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v9h11.9c-.5 2.8-2.1 5.1-4.4 6.7v5.6h7.1c4.2-3.8 6.5-9.5 6.5-16.6z'],
    ['#34A853', 'M24 46c5.9 0 10.9-2 14.6-5.3l-7.1-5.6c-2 1.3-4.5 2.1-7.5 2.1-5.8 0-10.7-3.9-12.4-9.1H4.3v5.8C8 41.3 15.4 46 24 46z'],
    ['#FBBC05', 'M11.6 28.1c-.5-1.3-.7-2.7-.7-4.1s.3-2.8.7-4.1v-5.8H4.3C2.8 17 2 20.4 2 24s.8 7 2.3 9.9l7.3-5.8z'],
    ['#EA4335', 'M24 10.8c3.3 0 6.2 1.1 8.5 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.4 2 8 6.7 4.3 14.1l7.3 5.8c1.7-5.2 6.6-9.1 12.4-9.1z'],
  ];
  for (const [fill, d] of paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', fill);
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Open the sign-in / sign-up modal. Re-opening while one is already up
 * replaces it, so a second click cannot stack two dialogs.
 */
export function openAuthModal(initialMode: AuthModalMode = 'sign-in'): void {
  closeAuthModal();
  lastFocused = document.activeElement as HTMLElement | null;

  let mode: AuthModalMode = initialMode;
  let busy = false;

  overlay = el('div', 'modal-overlay active auth-modal-overlay');
  const modal = el('div', 'modal auth-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'auth-modal-title');

  const header = el('div', 'modal-header');
  const title = el('div', 'modal-title');
  title.id = 'auth-modal-title';
  const closeBtn = el('button', 'modal-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', closeAuthModal);
  header.append(title, closeBtn);

  // Auth off means no key was built into the bundle. Say that plainly rather
  // than showing a form whose every submit would fail.
  if (!isAuthEnabled()) {
    const notice = el(
      'p',
      'auth-modal-error',
      'Sign-in is not configured for this build.',
    );
    title.textContent = 'Sign in';
    modal.append(header, notice);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeydown);
    closeBtn.focus();
    return;
  }

  const status = el('p', 'auth-modal-error');
  status.setAttribute('role', 'alert');
  status.hidden = true;

  const googleBtn = el('button', 'auth-modal-oauth');
  googleBtn.type = 'button';
  googleBtn.append(googleIcon(), el('span', undefined, 'Continue with Google'));

  const divider = el('div', 'auth-modal-divider');
  divider.append(el('span', undefined, 'or'));

  const form = el('form', 'auth-modal-form');

  const nameLabel = el('label', 'auth-modal-label', 'Display name');
  const nameInput = el('input', 'auth-modal-input');
  nameInput.type = 'text';
  nameInput.autocomplete = 'name';
  nameInput.placeholder = 'Optional';
  nameLabel.appendChild(nameInput);

  const emailLabel = el('label', 'auth-modal-label', 'Email');
  const emailInput = el('input', 'auth-modal-input');
  emailInput.type = 'email';
  emailInput.required = true;
  emailInput.autocomplete = 'email';
  emailLabel.appendChild(emailInput);

  const passwordLabel = el('label', 'auth-modal-label', 'Password');
  const passwordInput = el('input', 'auth-modal-input');
  passwordInput.type = 'password';
  passwordInput.required = true;
  passwordInput.minLength = 6;
  passwordLabel.appendChild(passwordInput);

  const submit = el('button', 'auth-modal-submit');
  submit.type = 'submit';

  const forgot = el('button', 'auth-modal-link', 'Forgot your password?');
  forgot.type = 'button';

  const toggleRow = el('p', 'auth-modal-toggle');
  const toggleText = el('span');
  const toggleBtn = el('button', 'auth-modal-link');
  toggleBtn.type = 'button';
  toggleRow.append(toggleText, toggleBtn);

  form.append(nameLabel, emailLabel, passwordLabel, submit);

  function setBusy(next: boolean): void {
    busy = next;
    submit.disabled = next;
    googleBtn.disabled = next;
    toggleBtn.disabled = next;
    forgot.disabled = next;
    modal.classList.toggle('auth-modal-busy', next);
  }

  function showMessage(text: string, kind: 'error' | 'ok'): void {
    status.textContent = text;
    status.hidden = false;
    status.classList.toggle('auth-modal-ok', kind === 'ok');
  }

  function clearMessage(): void {
    status.hidden = true;
    status.textContent = '';
    status.classList.remove('auth-modal-ok');
  }

  function render(): void {
    const signingUp = mode === 'sign-up';
    title.textContent = signingUp ? 'Create account' : 'Sign in';
    submit.textContent = signingUp ? 'Create account' : 'Sign in';
    nameLabel.hidden = !signingUp;
    forgot.hidden = signingUp;
    passwordInput.autocomplete = signingUp ? 'new-password' : 'current-password';
    toggleText.textContent = signingUp ? 'Already have an account? ' : 'No account yet? ';
    toggleBtn.textContent = signingUp ? 'Sign in' : 'Create one';
    clearMessage();
  }

  toggleBtn.addEventListener('click', () => {
    if (busy) return;
    mode = mode === 'sign-in' ? 'sign-up' : 'sign-in';
    render();
    emailInput.focus();
  });

  googleBtn.addEventListener('click', () => {
    if (busy) return;
    setBusy(true);
    clearMessage();
    void signInWithGoogle().then((res) => {
      // On success the page is already navigating away, so leave the modal
      // busy — re-enabling it would flash an interactive form mid-redirect.
      if (!res.ok) {
        setBusy(false);
        showMessage(res.error ?? 'Google sign-in failed.', 'error');
      }
    });
  });

  forgot.addEventListener('click', () => {
    if (busy) return;
    const email = emailInput.value.trim();
    if (!email) {
      showMessage('Enter your email address first.', 'error');
      emailInput.focus();
      return;
    }
    setBusy(true);
    void sendPasswordReset(email).then((res) => {
      setBusy(false);
      if (res.ok) showMessage(`Reset link sent to ${email}.`, 'ok');
      else showMessage(res.error ?? 'Could not send the reset email.', 'error');
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      showMessage('Email and password are both required.', 'error');
      return;
    }
    setBusy(true);
    clearMessage();
    const run = mode === 'sign-up'
      ? signUpWithPassword(email, password, nameInput.value)
      : signInWithPassword(email, password);
    void run.then((res) => {
      setBusy(false);
      if (!res.ok) {
        showMessage(res.error ?? 'Something went wrong.', 'error');
        return;
      }
      if (res.needsEmailConfirmation) {
        showMessage(`Check ${email} for a confirmation link.`, 'ok');
        return;
      }
      // A live session closes the modal through the auth subscription below.
    });
  });

  modal.append(header, googleBtn, divider, form, forgot, status, toggleRow);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeAuthModal();
  });
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKeydown);

  render();
  emailInput.focus();

  // Close as soon as a user actually arrives — password sign-in, an OAuth
  // return, or a confirmation link opened in this same tab.
  // `subscribeAuthState` fires once with the current state on subscribe; that
  // first call is the state the modal was opened against, not a sign-in.
  let sawInitial = false;
  unsubscribeAuth = subscribeAuthState((state) => {
    if (!sawInitial) {
      sawInitial = true;
      return;
    }
    if (state.user) closeAuthModal();
  });
}
