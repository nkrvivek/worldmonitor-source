# Deployment Plan — Supabase Auth + Stripe Payments

This fork runs on Cloudflare Workers. Auth is Supabase; payments are Stripe.
The upstream plan for Clerk and Dodo no longer applies and is replaced by
what follows.

## Where each variable goes

Three places hold configuration, and each holds a different set.

**Convex Dashboard** — every server-side payments secret. Convex runs the
checkout action, the billing portal, the renewal reconciler and the webhook
handler, so it is the only place that needs the Stripe secret key.

| Variable | Value |
|----------|-------|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers → Webhooks → signing secret |
| `IDENTITY_SIGNING_SECRET` | `openssl rand -hex 32`. Separate from the webhook secret — never the same value |
| `PAYMENTS_ENVIRONMENT` | `test_mode` or `live_mode` |
| `SUPABASE_JWT_ISSUER` | `https://<project-ref>.supabase.co/auth/v1` |

**Cloudflare Workers** (`wrangler secret put`) — what the edge needs to read
entitlements and verify callers.

| Variable | Value |
|----------|-------|
| `PAYMENTS_ENVIRONMENT` | Must match the Convex value. It picks the entitlement cache namespace, so a mismatch splits the namespace and every lookup misses |
| `SUPABASE_JWT_ISSUER` | Same issuer as above |
| `CONVEX_SERVER_SHARED_SECRET` | Shared with Convex; proves the caller is one of our own services |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Upstash console |
| `STRIPE_SECRET_KEY` | Only for `/api/product-catalog`, which reads live prices when Redis is empty |

**Build time** (`.env` for `npm run build`) — what the browser bundle reads.
These are public by construction; a secret must never appear here.

| Variable | Value |
|----------|-------|
| `VITE_CONVEX_URL` | Convex Dashboard → Settings → Deployment URL |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API |
| `VITE_PAYMENTS_ENVIRONMENT` | Must match the server-side `PAYMENTS_ENVIRONMENT` |

`tests/browser-bundle-secret-guard.test.mts` fails the build when a secret
name reaches the bundle. Treat it as the backstop, not the rule.

## Stripe dashboard setup

1. **Prices carry lookup keys.** Every plan the app sells has a Stripe price
   whose lookup key is one of `wm_pro_monthly`, `wm_pro_annual`,
   `wm_api_monthly`, `wm_api_annual`, `wm_api_business_monthly`,
   `wm_api_business_annual`, `wm_enterprise`. The code looks prices up by key,
   never by price id, so replacing a price keeps working as long as the key
   moves to the replacement.
2. **Webhook endpoint**: `https://<convex-deployment>.convex.site/stripe-webhook`
3. **Events to subscribe**: `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid`, `invoice.payment_failed`,
   `invoice.payment_action_required`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`.
4. **Seed the plan rows** after deploying Convex:
   `npx convex run payments/seedProductPlans:seedProductPlans`. It reads the
   generated catalog, so run `npm run product:facts` first if the catalog
   changed.

## Deploy order

Convex first, then the Worker. The Worker reads entitlements out of Convex, so
a Worker deployed against an older schema serves stale answers.

```
1. npm run product:facts && npm run build:pro
2. npx convex deploy
3. npx convex run payments/seedProductPlans:seedProductPlans
4. /Users/Vivek/Development/trade-refresh/scripts/cf-deploy.sh deploy
```

Never `npx wrangler deploy` bare — the wrapper carries the account token and
refuses the wrong account.

## After deploying

- [ ] Anonymous visitor sees locked premium panels
- [ ] Supabase sign-in works and the session reaches the Worker as a bearer token
- [ ] Test-mode checkout with card `4242 4242 4242 4242` creates a subscription
- [ ] The webhook lands: subscription and entitlement rows appear in Convex
- [ ] Unlocked panels load data for that user
- [ ] Billing portal opens from Settings
- [ ] Desktop API key flow still works

## Known gaps

- The Cloudflare seeds container went 11.8 days unable to write intel history,
  taking an HTTP 401 on every `/relay/intel-history` POST from 2026-08-07. It
  writes again as of 2026-08-19T18:35:56Z, first proved by `energy` rows landing
  in prod, that being the only resource with no Railway twin and so the only
  clean read on the container. **What unblocked it was not measured**: the error
  line built to name the relay host never printed, because the next attempt after
  the `seeds-a89e8b73b7f6` redeploy succeeded. Treat the 401 as unexplained
  rather than fixed, and watch the energy row count.
- Live-mode Stripe products do not exist yet. Only test mode is seeded.
