/**
 * Fork-owned branding.
 *
 * Upstream prints its author's byline under the logo. This fork runs on its own
 * domain, so it prints its own. Keeping the string here means an upstream pull
 * that touches the logo does not also hand back their byline — see FORK.md.
 */
export const SITE_BYLINE = 'by sibt.ai';
