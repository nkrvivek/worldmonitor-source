# Payments: move to Stripe, and cut the plan list down

Status: in progress. Steps 2 through 6 are done on the main app; the step list
below says where each one stands. `/pro` (`pro-test/`) still runs the old Dodo
overlay and still loads Clerk — porting it is its own change. Current deployed behavior is described
in [pro-monetization.md](pro-monetization.md).

## The decision

Stay on Stripe. The user already runs it for sibt.ai, and the port out of Dodo
is small — four provider calls, one signature scheme, nine event names. It is
not the 12,000 lines the payments directory suggests.

## What is live today

Nothing. Measured 2026-08-05 against worldmonitor.sibt.ai:

| Path | Status |
|---|---|
| `/api/create-checkout` | 404 |
| `/api/product-catalog` | 404 |
| `/api/bootstrap` | 401 (ported, wants a session cookie) |

The payments endpoints are among the 148 RPCs still routed to
`UPSTREAM_API_ORIGIN`, and that host — `vercel-origin.worldmonitor.app` — does
not resolve. So no one can buy anything on our deployment, and there are no
subscriptions to migrate. The port carries no data risk. That is the whole
reason it can be done cheaply now and not later.

## The port surface

Four calls reach the provider:

| Call | File |
|---|---|
| `checkoutSessions.create` | `convex/lib/dodo.ts:82` |
| `customers.customerPortal.create` | `convex/payments/billing.ts:448` |
| `subscriptions.retrieve` | `convex/payments/billing.ts:1770` |
| `payments.retrieve` | `convex/payments/billing.ts:3056` |

Their Stripe counterparts are `checkout.sessions.create`,
`billingPortal.sessions.create`, `subscriptions.retrieve`, and
`paymentIntents.retrieve`. Same shape, same one-request-per-call contract. The
`maxRetries: 0` pin in `convex/lib/dodo.ts` carries over unchanged and stays
load-bearing: the retry ladder in `payments/checkoutRateLimit.ts` owns all
retry policy, and a nested SDK retry would break its wall-clock budget.

Webhooks are the only real rewrite. `convex/payments/webhookHandlers.ts:39`
verifies a Standard Webhooks signature by hand — HMAC-SHA256 over
`id.timestamp.body` with a `whsec_` base64 secret. Stripe signs differently
(`stripe-signature`, `t=` and `v1=` parts). Use
`stripe.webhooks.constructEventAsync`; the sync variant needs Node crypto and
Convex does not have it.

Event names change but the state machine does not:

| Dodo | Stripe |
|---|---|
| `subscription.active` | `customer.subscription.created`, `customer.subscription.updated` |
| `subscription.on_hold` | `customer.subscription.updated` with status `past_due` or `unpaid` |
| `subscription.cancelled` | `customer.subscription.updated` with `cancel_at_period_end` |
| `subscription.expired` | `customer.subscription.deleted` |
| `subscription.plan_changed` | `customer.subscription.updated` with a changed price |
| `payment.succeeded` | `invoice.paid` |
| `payment.failed` | `invoice.payment_failed` |
| `payment.processing`, `payment.cancelled` | no counterpart; drop |

Stripe pushes one `customer.subscription.updated` for several of these, so the
handler dispatches on the status field rather than the event name. Keep the
existing `active` / `on_hold` / `cancelled` / `expired` vocabulary in the
database — the entitlement code reads those words in about forty places and
none of it needs to know who charged the card.

Schema columns are renamed provider-neutral, done 2026-08-05: `dodoProductId`
→ `providerPriceId`, `dodoSubscriptionId` → `providerSubscriptionId`,
`dodoCustomerId` → `providerCustomerId`, `dodoPaymentId` → `providerPaymentId`,
and their indexes with them. Every payment table was empty, so this was a
rename and not a backfill. `providerPriceId` holds a Stripe **price** ID, not a
product ID — Stripe Checkout takes prices.

The other `dodo` names — the client in `convex/lib/dodo.ts`, function names,
comments — stay until the provider swap replaces the code that owns them.
Renaming them ahead of that would touch 145 files to no effect.

Environment variables drop from six to four. `DODO_API_KEY`,
`DODO_WEBHOOK_SECRET`, `DODO_PAYMENTS_WEBHOOK_SECRET` and `DODO_BUSINESS_ID`
are gone; `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` replace them.
`DODO_PAYMENTS_ENVIRONMENT` and `VITE_DODO_ENVIRONMENT` keep their job under
neutral names, `PAYMENTS_ENVIRONMENT` and `VITE_PAYMENTS_ENVIRONMENT`, as does
`DODO_IDENTITY_SIGNING_SECRET` as `IDENTITY_SIGNING_SECRET` — that secret is
ours, not the provider's.

Four and not three, against the original plan of deriving live-versus-test
from an `sk_live_` prefix on the Stripe key. Three places build the entitlement
cache namespace, and one of them — `api/_user-api-key.js` — runs on the edge
where the Stripe secret does not exist. A derived prefix would have made that
reader disagree with the two writers and split the namespace in half, which is
incident #5600 word for word. A neutral variable every runtime can see costs
one line of config and cannot fail that way.

### What gets simpler

`convex/payments/billing.ts` carries three reconciliation loops that exist
because Dodo webhooks could be missed: `reconcileMissedDodoRenewals`,
`listStuckPendingPaymentCandidates`, and the stale-subscription verifier.
Stripe retries a failed webhook for three days. Keep the loops for the first
month, then measure how often they find anything. If the answer is never,
delete them and the file loses about a third of its length.

## Pricing

What the catalog held before the port — six paid plans, ten price rows counting
the annual variants. Kept here as the record of what changed; the live numbers
are the streamlined table below.

| Plan | Monthly | Annual | Tier |
|---|---|---|---|
| Free | $0 | — | 0 |
| Pro | $39.99 | $359.99 | 1 |
| Pro Business | $49.99 | $449.99 | 1 |
| API Starter | $99.99 | $899.99 | 2 |
| API Business | $299.99 | $2,699.99 | 2 |
| Enterprise | contact | — | 3 |

Those are the `priceCents` values in `convex/config/productCatalog.ts`, which
labels itself a fallback and says live prices come from the Dodo API.
`pro-monetization.md` quotes $399.99 and $999 for the two annual plans instead
of $359.99 and $899.99. One of the two is stale and there is no way to tell
which without asking Dodo. Settle it before publishing any price, and after the
port the catalog becomes the only copy so the question cannot recur.

Pro and Pro Business are the same tier, unlock through the same gates, and sit
$10 apart. A buyer has to read two feature tables to find that out. Collapse
them: one Pro, priced under both, carrying Pro Business's limits.

Chosen, and now live in `convex/config/productCatalog.ts`:

| Plan | Monthly | Annual | Dashboards | MCP/day | AI calls/day | API/day |
|---|---|---|---|---|---|---|
| Free | $0 | — | 3 | 0 | 0 | 0 |
| Pro | $29 | $290 | 25 | 250 | 2,500 | 0 |
| API | $49 | $490 | 25 | 1,000 | 1,000 | 1,000 |
| API Business | $299 | $2,990 | 100 | 10,000 | 10,000 | 10,000 |
| Enterprise | contact | — | unlimited | unlimited | unlimited | unlimited |

Three paid plans instead of five. Pro gets cheaper and better at once. API
Starter drops from $99.99 to $49 — at 1,000 requests a day it was priced at
2.5× Pro for a narrow feature.

Annual is ten months' price, which reads as two free months without anyone
having to work out a percentage.

**Measure before committing to $29.** The 2,500 daily AI calls are the only
line that can make this plan lose money. One heavy user at the cap costs more
than the subscription unless a call is under roughly a third of a cent. Meter
`dashboardAiCallsPerDay` against real spend for a week first. If the number
does not hold, cut the allowance rather than raising the price — the allowance
is invisible to most buyers and the price is not.

## Order of work

Do the pricing change inside the Stripe port, not before it. The catalog rows
carry provider product and price IDs, so touching them twice means writing them
twice.

1. **Test mode done, live mode open.** Create the products and prices in the
   existing sibt.ai Stripe account. Seven prices, addressed by lookup key:
   Pro monthly and annual, API monthly and annual, API Business monthly and
   annual, Enterprise. The test-mode set exists; live mode needs a key with
   Products and Prices write, which the current one does not have.
2. **Done.** Rewrite `convex/config/productCatalog.ts` against the new plan
   list. `pro_business` and its entitlement rows came out. The `api_starter`
   plan keys stayed — they are sold as "API Monthly" and "API Annual", and
   renaming the key would have rewritten roughly a hundred test call sites for
   no behaviour change.
3. **Done.** Swap the four provider calls. One file each, no shared code.
4. **Done.** Rewrite the webhook handler: Stripe signature, status-based
   dispatch, same database vocabulary.
5. **Done.** Rename the schema columns and the environment variables.
6. **Done.** Route the payments endpoints into the Worker and cut the client
   overlay. `worker/routes/payments.ts` now answers `/api/product-catalog`,
   `/api/create-checkout`, `/api/customer-portal` and `/api/me/entitlement`.
   All four were 404, not three — the earlier note that `/api/product-catalog`
   was "already ported" was true of its Stripe rewrite and false of its
   routing, so the pricing page kept serving its static fallback.

   On the client, both redirect guards now point at Stripe hosts
   (`checkout.stripe.com`, `billing.stripe.com`), and the billing portal has
   no fallback URL because Stripe has no generic portal page — a portal
   session is the only way in, so failure is a typed outcome and one sentence
   in the UI. The Dodo overlay is deleted: it had no callers from the day
   redirect mode shipped, and it was pinning a payment SDK in the bundle plus
   five provider hosts in `frame-src` and two in `payment=`. Those allowlist
   entries went with it.
7. Point a Stripe test-mode webhook at the Convex HTTP endpoint and buy each
   plan once.
