# A seed in two runtimes writes one health record

`intel-history:energy:intelligence` sat at `sourceState: degraded` for 11.8 days
with 47 consecutive failures and this error on every one:

```
intel-history relay returned HTTP 401: {"error":"UNAUTHORIZED"}
```

Two other seeds write the same archive and both read healthy. They were not
healthy. They were half broken, and the healthy half was overwriting the
evidence.

## What the health records said, and why they misled

| resource | consecutiveFailures | lastSuccessAt | lastErrorCode |
|---|---|---|---|
| `conflict:acled-intel` | 0 | recent, 150 records | `http_401` |
| `military:cross-strait-activity` | 0 | recent, 106 records | `http_401` |
| `energy:intelligence` | 47 | **null** | `http_401` |

All three carry `http_401`. `lastErrorCode` is retained after recovery on
purpose, so on the healthy two it reads as history. It was not history. Both of
those scripts run in two places: on Railway, and again in the Cloudflare seeds
container. The Railway run succeeds and resets `consecutiveFailures`; the
container run takes a 401 and leaves its error code behind. Each of those rows
is a blend of one working caller and one broken one.

`energy:intelligence` is in `worker/seeds/registry.ts` and not in
`scripts/railway-services.json`. It runs only in the container, so it is the one
record that shows the container's own result unblended. `lastSuccessAt: null`
after 47 attempts means it had never once succeeded, and prod holds zero `energy`
rows to match.

A seed that runs in two runtimes writes one health record. The successful
runtime hides the failing one, and the resource with no twin is the only honest
probe you have.

## What the archive actually shows

Read the rows rather than the health field, and the split disappears:

| deployment | conflict | military | energy |
|---|---|---|---|
| `benevolent-impala-683` (prod) | fresh, through 2026-08-19 | fresh, through 2026-08-19 | **zero** |
| `steady-snake-729` (dev) | zero | zero | zero |

Dev is empty in every domain. The site reads prod: the bundle served at
`https://worldmonitor.sibt.ai/pro/` contains `benevolent-impala-683.convex.cloud`
and no other Convex host. Railway writes prod, the app reads prod, and the two
match. Only the container is broken.

`acled-intel` reporting `lastInserted: 0, lastDeduped: 150` is the same fact
from the other side. Dedupe against an empty table is impossible, so that
successful write landed on the table that already had 150 rows, which is prod's.

## The credential is not obviously at fault

`/relay/intel-history` rejects on one condition, and an unconfigured deployment
fails closed:

```ts
const secret = process.env.RELAY_SHARED_SECRET ?? "";
if (!secret) return true;   // → 401 UNAUTHORIZED
```

Posting `{}` with a bearer separates auth from validation: a wrong token answers
401, a good one answers `400 MISSING_FIELDS`. With the secret from `.env.local`,
**both** deployments now answer `400 MISSING_FIELDS`. The same value gets 200
from the Worker's `GET /ais/snapshot`, which validates against the same variable,
so the Worker holds it too.

Setting `RELAY_SHARED_SECRET` on dev was the first fix attempted. It changed dev
from 401 to 400 and changed nothing else: dev still has zero rows twenty minutes
and five seeder ticks later. That is the proof the container is not posting to
dev either.

## It writes now, and the cause was never measured

Prod holds `energy` rows as of **2026-08-19T18:35:56Z**. The first one is
`energy:intelligence:oilprice-s1dn74-1787127300000`, and a poll running every
150 seconds recorded the change inside one container tick:

```
=== 18:34
 100 "conflict"
 100 "military"
=== 18:36
 100 "conflict"
  12 "energy"
  88 "military"
```

Twelve rows in a 200-row descending read, which is a fresh append and not a
backfill. The 47-failure streak on `energy:intelligence` ended on the tick after
the container was redeployed on image `seeds-a89e8b73b7f6`.

**Which change unblocked it is not known.** The measurement built to find out,
the relay error naming the host it called, never printed: the next attempt after
that deploy succeeded, so the line it was written to emit does not exist
anywhere.

The health record itself is readable, and it is worth saying where, because two
wrong places were tried first. It is not behind `/api/health`, which answers
`{"error":"API key required"}` without an operator key, and it is not in Convex,
whose prod deployment has no health table. It is a plain Upstash Redis key:

```sh
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/get/intel-history:ingest-health:energy:intelligence:v1"
```

Read every two minutes from 18:35 to 18:52 on 2026-08-19, it holds `state
healthy`, `consecutiveFailures 0`, `lastSuccessAt` and `lastAttemptAt` both
18:35:56, `lastErrorAt` 16:54:41. So one attempt succeeded and no attempt has
run since; the record confirms the write and says nothing about the cause,
because it carries no error text from the failures that preceded it.

So the honest reading is narrow. The container writes prod now, and the resource
with no Railway twin is the proof, exactly as it was the proof of the failure.
Nothing here establishes that the host was wrong, that the credential was wrong,
or that the redeploy is what did it. If the streak returns, the host-naming line
is still in place and will print on the first failure.

## The trap that cost the most time

Two commits' worth of `scripts/` fixes never reached the container. The seed
image is baked, and `.github/workflows/seed-container-image.yml` refuses to build
unless `wrangler.jsonc`'s image tag already matches `./scripts/seed-image-tag.sh`.
A `scripts/**` change with no tag move fails that check, so the image for the new
code is never built and the container keeps running the old one while the commit
sits on `main` looking shipped.
