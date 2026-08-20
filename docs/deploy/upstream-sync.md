# Pulling upstream changes

This repo is a private fork. It carries the Cloudflare Workers port, which
upstream does not have and will not take.

| Remote | Points at | Push |
|---|---|---|
| `origin` | `nkrvivek/worldmonitor` (this fork) | yes |
| `upstream` | `koala73/worldmonitor` | **blocked** — push URL is set to a bogus string on purpose |

Never push to `upstream`. It is someone else's repo. The bogus push URL makes
an accidental `git push upstream` fail instead of succeed.

## Cadence

Sync monthly. The fork diverges fast: between 2026-07-22 and 2026-08-03,
upstream added 382 commits while this fork added 50. Leaving it longer turns
a merge into an archaeology project.

[`.github/workflows/upstream-sync.yml`](../../.github/workflows/upstream-sync.yml)
runs the mechanical half on the 2nd of each month. It tries the merge on a
branch and either opens a PR (clean) or opens an issue listing the conflicting
files (not clean). It never touches `main` and never runs the gate — GitHub
does not start CI for a PR opened with `GITHUB_TOKEN`, so that PR carries no
checks at all. Everything below still has to be run by hand.

## Workflows turned off on this fork

One of upstream's monitors audits Railway, which this fork does not use and
will not use:

| Workflow | Why off |
|---|---|
| `seed-freshness-monitor.yml` | Needs `secrets.RAILWAY_PRODUCTION_TOKEN` and `vars.RAILWAY_PROJECT_ID`; every step after the CLI install talks to Railway |

It is disabled through the Actions API (`gh workflow disable <file>`), not
by editing the files, so nothing here conflicts on a merge. A sync that adds
a new Railway-dependent workflow will start mailing failures until you disable
that one too. To check what is off:

```bash
gh api repos/nkrvivek/worldmonitor/actions/workflows \
  --jq '.workflows[] | select(.state != "active") | "\(.state)\t\(.name)"'
```

## The sync

Do this on a branch, never on `main` directly, and never with `git pull`.

```bash
git fetch upstream
git rev-list --left-right --count upstream/main...main   # behind / ahead
git switch -c sync/upstream-YYYY-MM-DD
git merge upstream/main
```

Conflicts land in the files the port owns. Resolve toward the port, not
toward upstream:

- `wrangler.jsonc`, `worker/**` — ours alone, upstream has no version.
- `api/**`, `server/**` — shared. Take upstream's logic changes, keep the
  Worker-side edits (the `.ts`-extension import in `api/_rate-limit.js`, the
  CORS allowlist entry for `worldmonitor.sibt.ai` in `server/cors.ts`).
- `.github/workflows/deploy-gate.yml` — keep the `checks: read` and
  `pull-requests: read` scopes. Upstream needs neither, because that repo is
  public and any token reads public check runs. This fork is private, and
  without them every evaluation 403s before it posts a status.
- `tests/china-policy-events.test.mts` — keep the core-scaled `budgetMs` in
  the hostile-markup test. Upstream's flat `1_000` holds on the 4-core runners
  a public repo gets; this fork is private, gets 2-core runners, and the same
  parser measures ~1_300ms under `--test-concurrency=16`. On 4 cores the
  formula returns upstream's number unchanged.
- `vercel.json` — upstream owns the routing table that `worker/routing/`
  mirrors. If it moved, the Worker's table has to move with it, and
  `scripts/routing-parity.mjs` is what proves it did.

Then, on node 24 (`.nvmrc`):

```bash
npm ci
npm run typecheck
npm run test:worker && npm run test:counters && npm run test:sidecar && npm run test:data
WORKERS_CI=1 npm run build
```

Build with `npm run build`, not bare `npx vite build`. The full build runs the
prerender and sitemap steps; plain vite skips them, leaving `dist/reference/`
missing, and `scripts/routing-parity.mjs` then reports a 200 that 404s. The
mismatch is in the build, not the routing.

`test:data` shells out to GNU `timeout`, which macOS does not ship. Without it,
11 tests in `tests/prepush-hook-gate.test.mjs` and
`tests/prepush-changed-tests.test.mjs` fail on `timeout: command not found` —
a missing binary wearing the costume of merge breakage. Install coreutils or
put a `timeout` shim on PATH before reading those failures as real.

Merge to `main` only once that is green, then deploy per
[cloudflare-cutover.md](./cloudflare-cutover.md) and check
`worldmonitor.sibt.ai` answers before calling it done.
