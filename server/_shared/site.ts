/**
 * Where this deployment lives, for links the server hands to people.
 *
 * Fork-owned file, and the server-side twin of `src/config/site.ts`. Upstream
 * hardcodes `https://worldmonitor.app` in upgrade URLs, brief pages, and lead
 * emails, so every one of those sent our users to upstream's site.
 *
 * API hosts, CORS allowlists, user-agent strings, and the analytics loader keep
 * naming upstream's services — those are not links, and they are not ours to
 * repoint.
 */

export const SITE_ORIGIN = 'https://worldmonitor.sibt.ai';

/** Pricing and plan page. */
export const PRO_URL = `${SITE_ORIGIN}/pro`;

/** Dashboard. */
export const DASHBOARD_URL = `${SITE_ORIGIN}/dashboard`;

/** Where people write when they need a human. Shared with sibt.ai. */
export const SUPPORT_EMAIL = 'hello@sibt.ai';
