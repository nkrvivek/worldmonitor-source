/**
 * Where this deployment lives.
 *
 * Fork-owned file. Upstream hardcodes `https://worldmonitor.app` at every CTA,
 * so a signed-out upgrade click on our host navigated the top window to
 * upstream's pricing page and the user never came back. Every link that sends a
 * person somewhere reads these constants instead.
 *
 * Relative paths would be simpler in the browser, but the desktop build runs
 * from `tauri.localhost` and needs an absolute origin, so both callers share
 * one value.
 *
 * Not for API hosts, CORS allowlists, or third-party referer headers — those
 * name upstream's services on purpose and stay as they are.
 */

export const SITE_ORIGIN = 'https://worldmonitor.sibt.ai';

/** Pricing and plan page. */
export const PRO_URL = `${SITE_ORIGIN}/pro`;

/** Pricing table anchor on the Pro page. */
export const PRO_PRICING_URL = `${PRO_URL}#pricing`;

/** Dashboard, used as the checkout return target. */
export const DASHBOARD_URL = `${SITE_ORIGIN}/dashboard`;

/** Blog index. */
export const BLOG_URL = `${SITE_ORIGIN}/blog/`;

/** Docs index. */
export const DOCS_URL = `${SITE_ORIGIN}/docs`;

/** Where people write when they need a human. Shared with sibt.ai. */
export const SUPPORT_EMAIL = 'hello@sibt.ai';
