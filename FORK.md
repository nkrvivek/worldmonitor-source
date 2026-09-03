# Fork deviations

This repo tracks `koala73/worldmonitor` as `upstream` and carries changes that
run the site at `worldmonitor.sibt.ai` on our own infrastructure. Read this
before merging upstream. It says what we changed, why, and which files a merge
is likely to fight over.

`upstream` is fetch-only. Its push URL is set to a string that is not a URL, so
a stray `git push upstream` fails instead of publishing our fork.

## Measured merge surface

Taken at merge-base `2fbb17a` against 16 upstream commits (2026-08-04):

| | count |
|---|---|
| Files we added | 129 |
| Files we edited | 114 |
| Files we deleted | 3 |
| Files upstream changed in the same window | 167 |
| **Files both sides changed** | **16** |

The overlap is the only set that can conflict. Three of those sixteen are lock
files and one is generated JSON, all of which we rebuild rather than merge. So
a month of upstream work costs twelve hand-merged files.

`scripts/merge-upstream.sh` recomputes these numbers on every run and prints
them before it merges anything. Trust its output over this table.

That number stays low because most of our work lives in files upstream does not
have. Keep it that way: when a change can go in a new file, put it in a new
file.

## What we changed, and why

### Auth: Clerk to Supabase

We already run Supabase auth for sibt.ai. worldmonitor signs in against the same
user pool (project `twyzyvgqzzuvlvsftcjj`), so one account works on both sites.

- Added `src/services/auth.ts`, `src/services/supabase-client.ts`,
  `src/services/auth-state.ts`, `src/components/AuthModal.ts`.
- Deleted `src/services/clerk.ts` and its two test files.
- About 30 files under `src/` and `api/` change only their import path from
  `@/services/clerk` to `@/services/auth`. Each is two to eight lines.
- `server/auth-session.ts` verifies Supabase ES256 JWTs from
  `https://twyzyvgqzzuvlvsftcjj.supabase.co/auth/v1/.well-known/jwks.json`.
- `convex/auth.config.ts` names the same issuer.

Two rules survive from the port and must not be undone by a merge:

1. **`role` and `plan` are always `'free'`.** Every Pro gate reads a Convex
   entitlement row. The billing webhook writes those rows and never wrote Clerk
   `publicMetadata`, so the second signal was already dead in production.
   Complimentary and tester grants are issued as entitlement rows.
2. **Nothing may read Supabase `user_metadata` for authorization.** Supabase
   documents it as user-editable. `app_metadata` is unverified and also off
   limits for grants.

Client env names: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` replace
`VITE_CLERK_PUBLISHABLE_KEY` everywhere, including the two desktop workflows and
`scripts/check-desktop-build-env.mjs`.

### Hosting: Cloudflare only

No Vercel, no Railway, no fly.io. `vercel.json` stays in the tree because the
deploy-config tests read its header rules, but nothing deploys from it.

- Added `wrangler.jsonc`, `worker/` (28 files), `worker-configuration.d.ts`,
  `tsconfig.worker.json`, `vitest.worker.config.mts`.
- Every worker deploys through `/Users/Vivek/Development/trade-refresh/scripts/cf-deploy.sh`
  from the worker's directory. Never `npx wrangler deploy` bare, never
  `wrangler login`. Account `3e2617436093fffd3446428537e90efd`.
- `Authentication error [code: 10000]` on a correct-looking account path means
  the wrong account is active, not a missing worker.

### Client defaults point at our host

Upstream's clients default to upstream's hosts. On a key issued here, that
sends the user's API key to a server we do not run and gets a 403 back. Every
default endpoint now names `worldmonitor.sibt.ai`:

- `cli/src/core.mjs`, `sdk/go/worldmonitor.go`, `sdk/python/src/worldmonitor_sdk/__init__.py`,
  `sdk/ruby/lib/worldmonitor.rb` — REST base, MCP URL, spec URL, and the
  `/pro` and `/docs` links in help text and auth hints.
- `src/app/desktop-updater.ts` — the version check and the platform download.
- The four SDK READMEs and the three root READMEs, which print those defaults.

Two things stay upstream's on purpose. Package identity — the gem and PyPI
homepages, the package names, the `+https://worldmonitor.app` in each
User-Agent — describes packages upstream publishes and we do not; `tests/sdk-packages.test.mjs`
pins it. And `api/_github-release.js` still reads `koala73/worldmonitor`
releases, because this fork has published none and our own repo would 404.
That file names what to change on the day we tag one.

These are four constants per client. Expect them in every merge, and expect the
conflict to be obvious.

### Convex

52 new files under `convex/`, 5 edited. Entitlements, API-plan limits, and the
usage counters live here.

### Build config

`vite.config.ts` carries three of our edits: the Clerk version-pinning block and
its two build guards are gone, the lazy chunk is named `supabase`, and Workbox
ignores `supabase-*.js` instead of `clerk-*.js`. Upstream touches this file
often — expect to merge it by hand most months.

`package.json` drops `@clerk/clerk-js` and adds `@supabase/supabase-js`.

### CSP

`docker/nginx.conf`, `docker/nginx-security-headers.conf` and `vercel.json` drop
the two Clerk `frame-src` origins. Our sign-in modal is first-party DOM and
Google OAuth is a full-page redirect, so nothing auth-related is framed. If a
merge reintroduces those origins, take them back out.

## Merging upstream

Run `scripts/merge-upstream.sh`. It fetches, prints the overlap set before it
touches anything, and merges onto a branch so `main` is never left mid-merge.

Lock files are rebuilt, not merged. Take upstream's copy and reinstall:

```sh
git checkout --theirs package-lock.json && npm install
```

After a merge, run these before pushing:

```sh
npx tsc --noEmit
npx tsx --test tests/convex-auth-handoff.test.mts tests/auth-token-expiry.test.mts
npx tsx --test tests/deploy-config.test.mjs tests/ci-workflow-coverage.test.mts
npx tsx --test tests/browser-bundle-secret-guard.test.mts
```

Those five files guard everything in this document. `deploy-config` catches a
merge that restores the Clerk chunk name or the Clerk CSP origins.
`ci-workflow-coverage` catches a workflow that goes back to asking for
`VITE_CLERK_PUBLISHABLE_KEY`. `browser-bundle-secret-guard` catches a client env
name entering the bundle without review.

`npm run test:data` is red on `main` with pre-existing failures. Do not treat it
as a merge signal.

## Keeping the surface small

Two habits do most of the work:

- Put new behavior in new files. A new file cannot conflict.
- When you must edit an upstream file, edit as few lines as you can and leave
  the surrounding lines alone. A one-line import swap merges cleanly even when
  upstream rewrites the function under it.
