# Pro monetization — current architecture

**Last verified**: 2026-08-05 (payments section rewritten after the move to Stripe; the `/pro` rows were still describing Clerk and Dodo months after both were gone).

Factual snapshot of how authentication, payments, entitlements, and billing management work today. This page intentionally describes only current deployed behavior.

## Stack at a glance

| Concern | Provider | Primary entry points |
|---|---|---|
| Auth | **Supabase**, on the main app and on `/pro` | `src/services/auth.ts`, `src/services/supabase-client.ts`, `pro-test/src/services/auth.ts` |
| Payments | **Stripe** (hosted Checkout, redirect mode), on the main app and on `/pro` | `convex/lib/stripe.ts`, `src/services/checkout.ts`, `pro-test/src/services/checkout.ts` |
| Entitlements | **Convex** (`subscriptions` + `entitlements` tables, reactive WebSocket) | `convex/payments/*`, `src/services/entitlements.ts`, `src/services/billing.ts` |
| Referral attribution | Credited in Convex off the `metadata.affonso_referral` key | `convex/payments/checkout.ts`, `convex/payments/subscriptionHelpers.ts` |
| Billing portal | **Stripe billing portal** (`billing.stripe.com`, session-only — no generic landing page to fall back to) | `api/customer-portal.ts`, `convex/payments/billing.ts`, `src/services/billing.ts:openBillingPortal` |
| Gateway auth | Supabase bearer JWT, verified locally against `SUPABASE_JWT_ISSUER` | `server/auth-session.ts`, `api/create-checkout.ts` |

## Tier model

The authoritative lifecycle, plan, price, visibility, and checkout metadata lives in `convex/config/productCatalog.ts`. The MCP capability count comes from `api/mcp/registry/index.ts`. `npm run product:facts` combines those sources into committed Edge, Railway, static, structured-data, and agent-discovery artifacts; normal production build commands run it automatically. `npm run product:facts:check` is the non-mutating freshness gate.

Products are served at runtime from `https://api.worldmonitor.app/api/product-catalog`; generated client configuration lives in `pro-test/src/generated/tiers.json`:

- **Free** — `price: 0`, no productId, card links to dashboard.
- **Pro Monthly** — `wm_pro_monthly` ($29/mo, 25 dashboards, 250 MCP calls/day, commercial license).
- **Pro Annual** — `wm_pro_annual` ($290/yr, 2 months free).
- **API Monthly** — `wm_api_monthly` ($49/mo, 1k req/day). Sold as "API"; the stored planKey is still `api_starter`.
- **API Annual** — `wm_api_annual` ($490/yr, 2 months free).
- **API Business** — `wm_api_business_monthly` ($299/mo, 10k req/day, commercial-use license + 5 bundled Pro seats (same company email domain)); **API Business Annual** — `wm_api_business_annual` ($2,990/yr). API→Business upgrades ride the provider collection/portal path.
- **Enterprise** — `mailto:hello@sibt.ai` (contact sales).

The IDs above are price lookup keys, not provider price IDs. Pro Business merged into Pro on 2026-08-05 — same gates, $10 apart — so its keys and entitlement rows are gone.

## Auth — Supabase

Clerk ran both surfaces until the sibt.ai fork replaced it. `src/services/clerk.ts` is gone and so is `@clerk/clerk-js`. Nothing here reads a Clerk key.

- **Init**: `src/services/auth.ts` wraps supabase-js. `initAuth()`, `scheduleAuthLoad()` (idle callback after first paint), `openSignIn()`, `openSignUp()`, `signOut()`, `getAuthToken()`.
- **No token cache**: supabase-js keeps the session in localStorage and refreshes it on a timer. `auth.ts` adds only a near-expiry check, because `getSession()` will hand back a token with two seconds left on it. The Clerk version cached tokens and had to grow clock calibration to fix the staleness that caused.
- **Sign-in methods**: password, sign-up, Google OAuth, password reset — all in `auth.ts`.
- **Header UI**: `src/components/AuthHeaderWidget.ts` when signed in, `"Sign In"` button when signed out; `AuthModal.ts` and `AuthLauncher.ts` carry the dialog.
- **`/pro` surface**: `pro-test/src/services/auth.ts` is the React equivalent of the above, and `pro-test/src/components/AuthModal.tsx` is the dialog Clerk used to host. Same env names, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- **Auth state**: `src/services/auth-state.ts` centralizes the current session; subscribers include billing watch, entitlement watch, referral service, auth header widget.
- **One Clerk name left on purpose**: the `auth_kind` value `clerk_jwt` in `server/_shared/usage-identity.ts`. It is a wire value Axiom dashboards filter on, so renaming it would empty every saved query. Everything else — fields, comments, CSP hosts, the auth docs — now says what it does.

## Payments — Stripe

### Checkout creation

Two Convex actions at `convex/payments/checkout.ts`:

- `createCheckout` (public action): Convex auth.
- `internalCreateCheckout` (internal action): called by `/relay/create-checkout` with trusted userId from the edge gateway.

Both share `_createCheckoutSession()` which:

1. Validates `returnUrl` against `SITE_URL`, widened by `ALLOWED_RETURN_ORIGINS` (`convex/payments/returnUrl.ts`).
2. Builds metadata: `wm_user_id` (HMAC-signed via `convex/lib/identitySigning.ts`) + optional `affonso_referral`.
3. Calls `createStripeCheckoutSession()` from `convex/lib/stripe.ts`.
4. Returns `{ checkout_url }` for the full-page redirect.

### Duplicate guard

Before creating a session, `getCheckoutBlockingSubscription` checks for active/on_hold/cancelled subs. If one exists, throws/returns `ACTIVE_SUBSCRIPTION_EXISTS` with the blocking plan info — clients route the user to billing portal instead of creating a second sub.

### Redirect flow

There is one flow (#4449). `src/services/checkout.ts:startCheckout()` creates the session, then sends the top window to the provider's hosted page. The buyer comes back to `/dashboard?wm_checkout=return`; `src/services/checkout-return.ts:handleCheckoutReturn()` reads the params, cleans the URL, and returns a success boolean. The entitlement transition detector then shows the success banner and unlocks panels.

The overlay that used to run beside this is gone. It could not host the provider's nested 3DS stack, so card payments hung at "Processing…".

### Webhook → subscription lifecycle

`convex/payments/subscriptionHelpers.ts` handles the subscription and payment events (activation, renewal, update, payment succeeded, refunds). On first activation it writes the `subscriptions` row, recomputes `entitlements`, and credits referral attribution if `metadata.affonso_referral` matches a `userReferralCodes` row.

## Entitlements — Convex

- **Schema**: `subscriptions` (userId, planKey, status, currentPeriodEnd, providerSubscriptionId) + `entitlements` (userId, tier, validUntil, derived from subscriptions).
- **Reactive watch**: `src/services/billing.ts:initSubscriptionWatch()` subscribes to `getSubscriptionForUser` over WebSocket. Updates fire within seconds of webhook processing.
- **Panel gating**: `src/services/entitlements.ts` exposes `isEntitled()`, `hasTier()`; `panel-layout.ts` reloads on free→pro transition so locked panels unlock without manual refresh.
- **Cache invalidation**: entitlement changes delete the Redis cache entry via Upstash REST API before the reload.

## Billing management

- **Entry point**: `UnifiedSettings.ts:450` renders a `<button class="manage-billing-btn">Manage Billing</button>` inside the settings modal.
- **Edge gateway**: `api/customer-portal.ts` validates the Supabase bearer, relays to `/relay/customer-portal` on Convex, which mints a user-scoped Stripe portal session.
- **Client-side**: `src/services/billing.ts:openBillingPortal()` fetches the portal URL via Convex action and opens it in a pre-reserved tab. There is no fallback URL. Dodo had a generic portal to fall back to; Stripe does not, so a failure closes the tab and returns `unavailable` and the caller says why.
- **/pro parallel**: `pro-test/src/services/checkout.ts:openBillingPortal()` fires when a `/pro`-origin checkout hits `ACTIVE_SUBSCRIPTION_EXISTS`; it redirects in the same tab via `window.location.assign()`.
- **Payment failures**: `src/components/payment-failure-banner.ts` renders a persistent red banner when subscription status is `on_hold`; auto-hides on return to `active`.

## Referral attribution

- **Code generation**: `/api/referral/me.ts` (edge, bearer-auth'd) returns `{ code, shareUrl }` where `code` is a deterministic 8-char HMAC of the userId using `BRIEF_URL_SIGNING_SECRET`. Background binding into Convex via `ctx.waitUntil` — non-blocking on purpose (see module docstring for rationale).
- **Share link**: `https://worldmonitor.app/pro?ref=<code>`.
- **Attribution point**: the recipient's checkout metadata carries `affonso_referral: <code>`. The name is a Dodo-era vendor contract and **must not be renamed** — stored rows and webhook payloads both use it. Stripe forwards nothing to Affonso, so only the inbound half runs: on first activation, `subscriptionHelpers.ts` looks the code up in `userReferralCodes` and inserts a `userReferralCredits` row crediting the sharer.
- **Known gap**: referral code propagation from the dashboard-origin checkout path is incomplete.

## Security & auth surfaces

- **Edge endpoints** that accept bearer JWTs must go through `validateBearerToken` (`server/auth-session.ts`), which verifies a Supabase token locally against `SUPABASE_JWT_ISSUER` for audience `authenticated`. Applies to `/api/create-checkout`, `/api/customer-portal`, `/api/referral/me`.
- **Middleware UA guard** (`middleware.ts`): the short-UA guard 403s non-browser fetches by default. Any endpoint a scheduled job or an agent calls has to be listed in `PUBLIC_API_PATHS`.
- **Gateway premium check** (`server/gateway.ts`): accepts either a legacy `plan === 'pro'` role on the session OR Convex `entitlements.tier >= 1 && validUntil >= now`. The role path is a Clerk holdover, kept because the payment provider never wrote back to Clerk metadata; the entitlement row is what a paying subscriber actually gets.
- **CORS**: Cloudflare Worker `api-cors-preflight` is the source of truth for `api.worldmonitor.app`. Overrides `api/_cors.js` + `vercel.json`. Worker source lives at [`workers/api-cors-preflight/`](https://github.com/koala73/worldmonitor/tree/main/workers/api-cors-preflight); it short-circuits OPTIONS preflight at the edge (skipping Vercel) and stamps CORS headers onto non-OPTIONS responses on the way back. Unit-tested in `workers/api-cors-preflight/index.test.mjs`, smoke-tested live in `tests/cors-preflight-live.test.mjs` (gated by `LIVE_SMOKE=1`), and deployed by `.github/workflows/deploy-worker.yml` on changes under `workers/api-cors-preflight/`. The Worker's allowlist + Allow-Headers list MUST stay a superset of `api/_cors.js#getCorsHeaders`; drift breaks credentialed CORS site-wide (2026-05-27 outage post-mortem).
- **HMAC identity bridge**: the `wm_user_id` checkout metadata is signed with a server-side key (`convex/lib/identitySigning.ts`) so webhooks can trust the user association without a second lookup.

## Scope

This public reference documents current deployed behavior. Internal planning and rollout materials are intentionally excluded.

## File index (quick reference)

```
src/services/
├── auth.ts                   # Supabase auth: sign-in, sign-out, getAuthToken
├── auth-state.ts             # Central auth session
├── billing.ts                # Subscription watch + openBillingPortal
├── entitlements.ts           # Reactive entitlement state
├── checkout.ts               # Stripe Checkout redirect orchestration
├── checkout-return.ts        # Post-checkout URL param handling
└── referral.ts               # Share-link fetch + Web Share API

src/components/
├── AuthHeaderWidget.ts       # Signed-in/out header UI
├── AuthLauncher.ts           # Sign-in modal launcher
├── UnifiedSettings.ts        # Settings modal (Manage Billing lives here)
└── payment-failure-banner.ts # on_hold red banner

convex/payments/
├── checkout.ts               # createCheckout + internalCreateCheckout
├── subscriptionHelpers.ts    # Webhook → subscription lifecycle
├── webhookMutations.ts       # Idempotent webhook event processing
└── billing.ts                # getSubscriptionForUser + getCustomerPortalUrl

api/
├── create-checkout.ts        # Edge gateway → Convex relay
├── customer-portal.ts        # Edge gateway → Stripe portal session
└── referral/me.ts            # Bearer-auth'd share-link endpoint

pro-test/src/                 # React marketing page
├── App.tsx                   # /pro landing
├── components/PricingSection.tsx
└── services/checkout.ts      # /pro-origin Supabase + Stripe
```
