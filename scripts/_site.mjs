/**
 * Where this deployment lives, for the build scripts.
 *
 * Fork-owned file, and the third twin of `src/config/site.ts` and
 * `server/_shared/site.ts`. Those two repointed the links the app and the
 * server hand to people; the build scripts kept upstream's origin, so the
 * sitemap, the crawlable corpus and the IndexNow batches all described
 * worldmonitor.app while running on our host.
 *
 * Build scripts are plain ESM and cannot import the TypeScript twins, so the
 * value is repeated here rather than shared. Changing our host means changing
 * three files, and `tests/sitemap-generation.test.mjs` fails when the
 * published sitemap disagrees with this one.
 *
 * Not for API hosts, CORS allowlists, or user-agent strings — those name
 * upstream's services on purpose and stay as they are.
 */

export const SITE_ORIGIN = 'https://worldmonitor.sibt.ai';

/**
 * Where a customer writes to reach us.
 *
 * The same value as `SUPPORT_EMAIL` in the two TypeScript twins. Upstream's
 * generators wrote an address on their own domain into the pricing table, the
 * product catalog and 40-odd translated strings, so an enterprise enquiry from
 * our site reached them and not us.
 */
export const SUPPORT_EMAIL = 'hello@sibt.ai';
