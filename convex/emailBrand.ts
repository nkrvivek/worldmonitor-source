/**
 * Sender identity and link targets for every email Convex sends.
 *
 * Upstream wrote its own domain into each email module: a `noreply@` sender on
 * a domain this fork cannot send from, and body links pointing at a site we do
 * not run. Both are live faults, not cosmetics — Resend rejects a send from an
 * unverified domain, and a customer who clicks "accept invite" hands the invite
 * token to somebody else's server.
 *
 * Links derive from SITE_URL, the same value checkout's return-URL guard reads,
 * so moving hosts stays one env change.
 */
import { resolveSiteUrl } from "./payments/returnUrl";

/** Verified Resend sender. Replies reach a person, which `noreply@` never did. */
export const EMAIL_FROM = "World Monitor <hello@sibt.ai>";

/** Shown to customers and used as the reply-to on lifecycle mail. */
export const SUPPORT_EMAIL = "hello@sibt.ai";

/** Origin of the running site, no trailing slash. */
export function siteOrigin(): string {
  return new URL(resolveSiteUrl()).origin;
}

/** Bare host, for footer text that reads as a name rather than a link. */
export function siteHost(): string {
  return new URL(resolveSiteUrl()).host;
}

export function sitePath(path: string): string {
  return `${siteOrigin()}${path}`;
}

/** Email clients need an absolute image URL; this one ships in public/favico. */
export function logoUrl(): string {
  return sitePath("/favico/android-chrome-192x192.png");
}
