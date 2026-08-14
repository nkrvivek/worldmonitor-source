/**
 * Fork-owned branding for the blog.
 *
 * Mirrors pro-test/src/config/brand.ts. The two apps build separately and share
 * no module graph, so the string lives once per app rather than being imported
 * across a boundary that does not exist. See FORK.md.
 */
export const SITE_BYLINE = 'by sibt.ai';

/**
 * Blog authorship.
 *
 * Upstream bylines every post to its author, pulls his avatar from
 * unavatar.io, and marks him up as the schema.org Person behind the writing.
 * We do not publish his work, so posts here are credited to the publication.
 */
export const DEFAULT_AUTHOR = 'World Monitor';
export const DEFAULT_AUTHOR_URL = 'https://worldmonitor.sibt.ai/blog/';
export const DEFAULT_AUTHOR_ID = 'https://worldmonitor.sibt.ai/#organization';
export const DEFAULT_AUTHOR_BIO = 'Open-source global intelligence — 56 live data layers, correlated and scored.';
export const DEFAULT_AUTHOR_AVATAR = '/favico/apple-touch-icon.png';
