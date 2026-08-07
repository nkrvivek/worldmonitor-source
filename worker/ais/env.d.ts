/**
 * Hand-written augmentation of the Wrangler-generated `Cloudflare.Env`, the
 * same pattern worker/env.d.ts uses. Secrets are set with `wrangler secret
 * put` and so never appear in wrangler.jsonc, which means `wrangler types`
 * cannot know about them. Names only — values live in Worker secret bindings.
 *
 * Both are optional: a Worker deployed without them still type-checks, and
 * the code fails loudly at the point of use instead.
 */
declare namespace Cloudflare {
  interface Env {
    AISSTREAM_API_KEY?: string;
    RELAY_SHARED_SECRET?: string;
  }
}
