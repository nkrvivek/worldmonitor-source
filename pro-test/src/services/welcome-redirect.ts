import { DASHBOARD_PATH } from '../routes';
import { hasLiveStoredSession } from './auth-session';

export interface WelcomeRedirectLocation {
  search: string;
  hash: string;
  replace(target: string): void;
}

export function welcomeDashboardRedirectTarget(location: Pick<WelcomeRedirectLocation, 'search' | 'hash'>): string {
  return `${DASHBOARD_PATH}${location.search}${location.hash}`;
}

/**
 * `storedSession` is the raw `sb-<ref>-auth-token` value from localStorage, or
 * null. It is passed in rather than read here so this stays testable without a
 * browser — the same reason the Clerk version took `document.cookie`.
 */
export function maybeRedirectWelcomeVisitor(
  storedSession: string | null,
  location: WelcomeRedirectLocation
): boolean {
  if (!hasLiveStoredSession(storedSession)) return false;
  location.replace(welcomeDashboardRedirectTarget(location));
  return true;
}
