import { VARIANT_META } from './variant-meta';

const VARIANTS = new Set(Object.keys(VARIANT_META));

/**
 * Each variant's own path, taken from the canonical URL VARIANT_META already
 * publishes for it. Deriving it means the host and the paths move in one
 * place, and it is the same URL the header switcher navigates to.
 */
const VARIANT_BY_PATH = new Map<string, string>(
  Object.entries(VARIANT_META).map(([variant, meta]) => [normalizePath(new URL(meta.url).pathname), variant]),
);

/**
 * `pathname` is optional because this module reads `location` at import time and
 * does not own it. Several suites stub a partial location, and index.html's
 * pre-paint copy of this rule guards the same read for the same reason.
 */
function normalizePath(pathname: string | undefined): string {
  const trimmed = (pathname || '').toLowerCase().replace(/\/+$/, '');
  return trimmed || '/';
}

const buildVariant = (() => {
  try {
    return import.meta.env.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
})();

function loadStoredVariant(): string | null {
  try {
    return localStorage.getItem('worldmonitor-variant');
  } catch {
    return null;
  }
}

export interface SiteVariantInput {
  hostname: string;
  pathname: string | undefined;
  isDesktopApp: boolean;
  storedVariant: string | null;
  buildVariant: string;
}

/**
 * Work out which variant this page is.
 *
 * Two rules, in order. Upstream gives every variant its own subdomain, and
 * that still answers first — a variant subdomain names the whole deployment,
 * so a path inside it cannot mean something else. This fork serves all six as
 * paths on one host instead, and that is the second rule. Reading only the
 * hostname, as this did before, answered 'full' on every one of our paths, so
 * the header switcher navigated to /tech and got the full dashboard back.
 *
 * Local dev and the desktop app keep reading the stored variant: switching
 * there writes localStorage and reloads in place, so the old path is still in
 * the bar afterwards and must not win.
 */
export function resolveSiteVariant(input: SiteVariantInput): string {
  const stored = VARIANTS.has(input.storedVariant ?? '') ? input.storedVariant as string : null;

  if (input.isDesktopApp) return stored ?? input.buildVariant;

  const subdomain = input.hostname.toLowerCase().split('.')[0] ?? '';
  if (subdomain !== 'full' && VARIANTS.has(subdomain)) return subdomain;

  if (input.hostname === 'localhost' || input.hostname === '127.0.0.1') {
    return stored ?? input.buildVariant;
  }

  return VARIANT_BY_PATH.get(normalizePath(input.pathname)) ?? 'full';
}

export const SITE_VARIANT: string = (() => {
  if (typeof window === 'undefined') return buildVariant;

  return resolveSiteVariant({
    hostname: location.hostname,
    pathname: location.pathname,
    isDesktopApp: '__TAURI_INTERNALS__' in window || '__TAURI__' in window,
    storedVariant: loadStoredVariant(),
    buildVariant,
  });
})();
