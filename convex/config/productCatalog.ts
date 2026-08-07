/**
 * Canonical product catalog — single source of truth.
 *
 * All product IDs, prices, plan features, and marketing copy live here.
 * Convex server functions import directly. Dashboard and /pro page consume
 * auto-generated files produced by scripts/generate-product-config.mjs.
 *
 * To update prices or products:
 *   1. Edit this file
 *   2. Run: npm run product:facts
 *   3. Commit generated files
 *   4. Rebuild /pro: npm run build:pro
 *   5. Deploy Convex: npx convex deploy
 *   6. Re-seed plans: npx convex run payments/seedProductPlans:seedProductPlans
 */

/**
 * Public product lifecycle metadata shared by every acquisition, pricing,
 * structured-data, and agent-discovery surface. Keep operational product IDs
 * in PRODUCT_CATALOG; only deliberately public facts belong here.
 */
export const PUBLIC_PRODUCT_METADATA = {
  name: "World Monitor",
  lifecycle: "launched",
  canonicalUrl: "https://worldmonitor.sibt.ai/",
  pricingUrl: "https://worldmonitor.sibt.ai/pro#pricing",
  primaryCtaLabel: "View Pro plans",
  currency: "USD",
  availability: "https://schema.org/InStock",
} as const;

export type PlanLimits = {
  /**
   * Daily REST/gateway request allowance. `null` means unlimited for plans
   * where customer-specific contracts set the real cap outside the catalog.
   */
  apiRequestsPerDay: number | null;
  /**
   * Per-minute REST/gateway burst allowance. Mirrors `apiRateLimit` for
   * current callers while giving plan-limit lifecycle code a named dimension.
   */
  apiBurstRequestsPerMinute: number | null;
  /**
   * Daily MCP tool/resource call allowance. Current runtime enforcement only
   * has a Pro daily counter; API-tier counters need scanner/source support.
   */
  mcpCallsPerDay: number | null;
  /**
   * Daily dashboard-AI/REST LLM allowance. This is deliberately separate from
   * `mcpCallsPerDay`: MCP clients and dashboard/API callers have different
   * workloads and must not share the same product limit by accident.
   */
  dashboardAiCallsPerDay: number | null;
  /**
   * Per-minute MCP burst allowance. Notices stay disabled until limiter-hit
   * telemetry is durable enough to scan.
   */
  mcpBurstRequestsPerMinute: number | null;
};

export type PlanLimitDimension =
  | "api_daily_requests"
  | "api_minute_burst"
  | "mcp_daily_calls"
  | "mcp_minute_burst";

export type PlanFeatures = {
  tier: number;
  maxDashboards: number;
  apiAccess: boolean;
  apiRateLimit: number;
  planLimits?: PlanLimits;
  prioritySupport: boolean;
  /**
   * Format allowlist for an entitled export surface. `dataExport` below is
   * the first-stage lock: when it is false the entire surface is unavailable.
   * Once that gate is open, consumers expose only supported CSV/JSON/PDF
   * values declared here and ignore unknown values. Keep the two fields in
   * agreement — a tier with `dataExport: false` advertises no formats.
   */
  exportFormats: string[];
  /**
   * Pro MCP access — bearer-token MCP authorization via Clerk + per-user 50/day
   * quota. See plan 2026-05-10-001. Distinct from `apiAccess` (which gates
   * manual `wm_…` API key issuance for REST callers). All paid tiers grant
   * `mcpAccess: true`; free is `false`.
   *
   * Optional in the type because legacy entitlement rows written before this
   * field was added do not carry it. The Dodo webhook repopulates the field
   * on the next subscription event, and every consumer (`hasFeature`,
   * `isCallerPremium`, the MCP edge handler) treats `undefined` as `false`
   * (fail-closed). Catalog entries below ALWAYS set the field explicitly.
   */
  mcpAccess?: boolean;
  /**
   * Per-account daily REST request allowance (the "included" number). Read by
   * the per-account rate-limit layer (#3199): the daily usage meter counts but
   * never rejects at this value; the hard safety ceiling is 10× this number.
   * `-1` means unlimited (no daily meter/ceiling), mirroring `maxDashboards: -1`.
   *
   * Optional for the same reason as `mcpAccess`: legacy/cached entitlement rows
   * predate it. But unlike `mcpAccess`, consumers treat `undefined` as
   * **no daily limit (fail-OPEN)** — never punish a paying customer for a stale
   * cache; the 15-min cache + Dodo webhook self-heal. Catalog entries below
   * ALWAYS set the field explicitly.
   */
  apiDailyAllowance?: number;
  /**
   * First-stage data-export entitlement for CSV/JSON/PDF export (plan
   * 2026-07-25-001). Once this gate is open, `exportFormats` narrows the
   * actions exposed by each export surface. `tier` cannot stand in for this
   * field: Pro Business shares `tier: 1` with Pro but exports, and Pro does
   * not.
   *
   * Optional for the same reason as `apiDailyAllowance`: rows written before
   * the field existed omit it. Consumers treat `undefined` on a `tier >= 2`
   * row as **entitled (fail-OPEN)**, and that allowance is PERMANENT, not a
   * migration window — the 15-min server-side entitlement cache
   * (`server/_shared/entitlement-check.ts`) does not key its staleness check
   * on this field, so a stale row must never lock a paying customer out of
   * their own data. `undefined` below tier 2 is NOT entitled. Catalog
   * entries below ALWAYS set the field explicitly.
   */
  dataExport?: boolean;
};

export interface CatalogEntry {
  /**
   * The Stripe price's `lookup_key`, not its `price_…` id.
   *
   * Price ids differ between test mode and live mode, so hardcoding one makes
   * the catalog environment-specific and makes every live price a code change.
   * Lookup keys are ours, we set them when we create the price, and they are
   * the same string in both modes. Checkout resolves the key to a price id at
   * call time; the webhook maps an incoming price back to a plan through the
   * same key.
   */
  providerPriceId?: string;
  planKey: string;
  displayName: string;
  priceCents: number | null;
  billingPeriod: "monthly" | "annual" | "none";
  tierGroup: string;
  features: PlanFeatures;
  marketingFeatures: string[];
  /** License/commercial-use callouts rendered as green highlighted notes on the
   *  pricing card, visually distinct from the plain (muted) feature bullets. */
  highlightFeatures?: string[];
  selfServe: boolean;
  highlighted: boolean;
  currentForCheckout: boolean;
  // Whether EXISTING customers can self-serve CHANGE their plan to this one.
  // Distinct from `currentForCheckout` (which only means "purchasable at all"):
  // the Dodo customer portal cannot perform a plan change, so the plan-limit
  // upgrade CTA's `billing_portal` path is gated on THIS flag. Keep false until
  // a real self-serve change-plan surface exists; otherwise the CTA leads to a
  // portal that can't upgrade anyone.
  canChangePlanSelfServe?: boolean;
  publicVisible: boolean;
}

// ---------------------------------------------------------------------------
// Shared feature sets (avoids duplication across billing variants)
// ---------------------------------------------------------------------------

const FREE_FEATURES: PlanFeatures = {
  tier: 0,
  maxDashboards: 3,
  apiAccess: false,
  apiRateLimit: 0,
  apiDailyAllowance: 0,
  planLimits: {
    apiRequestsPerDay: 0,
    apiBurstRequestsPerMinute: 0,
    mcpCallsPerDay: 0,
    dashboardAiCallsPerDay: 0,
    mcpBurstRequestsPerMinute: 0,
  },
  prioritySupport: false,
  exportFormats: [],
  mcpAccess: false,
  dataExport: false,
};

/**
 * Pro — one plan, carrying what Pro Business used to carry.
 *
 * Pro and Pro Business sat $10 apart at the same tier and unlocked through the
 * same gates, so a buyer had to read two feature tables to find the
 * difference. They collapsed into this one block on 2026-08-05: the limits are
 * Pro Business's, the price is under both, and `PRO_BUSINESS_FEATURES` is
 * gone.
 *
 * `apiAccess` stays false so Pro cannot issue `wm_…` API keys — that is what
 * separates it from the API plans. Everything else it now has: data export,
 * 25 dashboards, priority support, and the larger MCP and AI allowances.
 */
const PRO_FEATURES: PlanFeatures = {
  tier: 1,
  maxDashboards: 25,
  apiAccess: false,
  apiRateLimit: 0,
  apiDailyAllowance: 0,
  planLimits: {
    apiRequestsPerDay: 0,
    apiBurstRequestsPerMinute: 0,
    mcpCallsPerDay: 250,
    dashboardAiCallsPerDay: 2_500,
    mcpBurstRequestsPerMinute: 60,
  },
  prioritySupport: true,
  exportFormats: ["csv", "json", "pdf"],
  mcpAccess: true,
  dataExport: true,
};

const API_STARTER_FEATURES: PlanFeatures = {
  tier: 2,
  maxDashboards: 25,
  apiAccess: true,
  apiRateLimit: 60,
  apiDailyAllowance: 1000,
  planLimits: {
    apiRequestsPerDay: 1_000,
    apiBurstRequestsPerMinute: 60,
    mcpCallsPerDay: 1_000,
    dashboardAiCallsPerDay: 1_000,
    mcpBurstRequestsPerMinute: 60,
  },
  prioritySupport: false,
  exportFormats: ["csv", "json", "pdf"],
  mcpAccess: true,
  dataExport: true,
};

const API_BUSINESS_FEATURES: PlanFeatures = {
  tier: 2,
  maxDashboards: 100,
  apiAccess: true,
  apiRateLimit: 300,
  apiDailyAllowance: 10000,
  planLimits: {
    apiRequestsPerDay: 10_000,
    apiBurstRequestsPerMinute: 300,
    mcpCallsPerDay: 10_000,
    dashboardAiCallsPerDay: 10_000,
    mcpBurstRequestsPerMinute: 300,
  },
  prioritySupport: true,
  // xlsx removed (#4974): no XLSX exporter exists anywhere in the product.
  exportFormats: ["csv", "json", "pdf"],
  mcpAccess: true,
  dataExport: true,
};

const ENTERPRISE_FEATURES: PlanFeatures = {
  tier: 3,
  maxDashboards: -1,
  apiAccess: true,
  apiRateLimit: 1000,
  apiDailyAllowance: -1,
  planLimits: {
    apiRequestsPerDay: null,
    apiBurstRequestsPerMinute: 1000,
    mcpCallsPerDay: null,
    dashboardAiCallsPerDay: null,
    mcpBurstRequestsPerMinute: 1000,
  },
  prioritySupport: true,
  // xlsx + api-stream removed for the same reason xlsx left API Business
  // (#4974): neither has an exporter, and this array is display truth.
  exportFormats: ["csv", "json", "pdf"],
  mcpAccess: true,
  dataExport: true,
};

// ---------------------------------------------------------------------------
// The Catalog
// ---------------------------------------------------------------------------

export const PRODUCT_CATALOG: Record<string, CatalogEntry> = {
  free: {
    planKey: "free",
    displayName: "Free",
    priceCents: 0,
    billingPeriod: "none",
    tierGroup: "free",
    features: FREE_FEATURES,
    marketingFeatures: [
      "Core dashboard panels",
      "Global news feed",
      "Earthquake & weather alerts",
      "Basic map view",
      "3 dashboard tabs",
    ],
    selfServe: false,
    highlighted: false,
    currentForCheckout: false,
    publicVisible: true,
  },

  pro_monthly: {
    providerPriceId: "wm_pro_monthly",
    planKey: "pro_monthly",
    displayName: "Pro Monthly",
    priceCents: 2900,
    billingPeriod: "monthly",
    tierGroup: "pro",
    features: PRO_FEATURES,
    marketingFeatures: [
      "Everything in Free",
      "AI stock analysis & backtesting",
      "Daily market briefs",
      "Military & geopolitical tracking",
      "Custom widget builder",
      "25 custom dashboards (vs 3)",
      "MCP + SDK access for Claude Desktop & other AI clients (250 calls/day)",
      "Data export — CSV, JSON & PDF reports",
      "Priority support",
    ],
    highlightFeatures: ["Commercial license included"],
    selfServe: true,
    highlighted: true,
    currentForCheckout: true,
    publicVisible: true,
  },

  pro_annual: {
    providerPriceId: "wm_pro_annual",
    planKey: "pro_annual",
    // Ten months' price. Two free months, without a percentage to work out.
    displayName: "Pro Annual",
    priceCents: 29000,
    billingPeriod: "annual",
    tierGroup: "pro",
    features: PRO_FEATURES,
    marketingFeatures: [],
    selfServe: true,
    highlighted: true,
    currentForCheckout: true,
    publicVisible: true,
  },

  api_starter: {
    providerPriceId: "wm_api_monthly",
    // The planKey stays `api_starter` while the plan is sold as "API". Renaming
    // it would touch 65 files and rewrite stored plan keys for no gain a buyer
    // can see.
    planKey: "api_starter",
    displayName: "API Monthly",
    priceCents: 4900,
    billingPeriod: "monthly",
    tierGroup: "api_starter",
    features: API_STARTER_FEATURES,
    marketingFeatures: [
      "REST API + official SDKs (npm, PyPI, RubyGems, Go)",
      "License / API key included",
      "Real-time data streams",
      "60 requests/minute",
      "1,000 requests/day included",
      "Webhook notifications",
    ],
    highlightFeatures: ["Commercial license — for your organization"],
    selfServe: true,
    highlighted: false,
    currentForCheckout: true,
    publicVisible: true,
  },

  api_starter_annual: {
    providerPriceId: "wm_api_annual",
    planKey: "api_starter_annual",
    displayName: "API Annual",
    priceCents: 49000,
    billingPeriod: "annual",
    tierGroup: "api_starter",
    features: API_STARTER_FEATURES,
    marketingFeatures: [],
    selfServe: true,
    highlighted: false,
    currentForCheckout: true,
    publicVisible: true,
  },

  api_business: {
    providerPriceId: "wm_api_business_monthly",
    planKey: "api_business",
    displayName: "API Business",
    priceCents: 29900,
    billingPeriod: "monthly",
    tierGroup: "api_business",
    features: API_BUSINESS_FEATURES,
    marketingFeatures: [
      "Everything in API Monthly",
      "Redistribution rights — embed our data in what you sell",
      "300 requests/minute",
      "10,000 requests/day included",
      "5 Pro licenses included",
      "Priority support",
    ],
    // "Same company email required" dropped from the card (#5604): it is a
    // requirement, not a benefit. Server-side enforcement is unchanged.
    highlightFeatures: ["Commercial license — for your customers"],
    // Published + self-serve since #4945 (bet B4): the tier existed in the
    // billing system but was invisible on every pricing surface and had
    // zero customers. Starter→Business upgrades for existing subscribers
    // ride the Dodo collection/portal path (#4634/#4672); this flag set
    // covers NEW-customer checkout and pricing-page visibility.
    selfServe: true,
    highlighted: false,
    currentForCheckout: true,
    // Self-serve plan change is live (#4634): api_starter + api_business share a
    // Dodo product COLLECTION with "Allow Subscription Updates" enabled, so the
    // customer portal surfaces the prorated Starter→Business upgrade. Flipping
    // this promotes the plan-limit-notice CTA from contact_support → billing_portal.
    canChangePlanSelfServe: true,
    publicVisible: true,
  },

  api_business_annual: {
    providerPriceId: "wm_api_business_annual",
    planKey: "api_business_annual",
    displayName: "API Business Annual",
    priceCents: 299000,
    billingPeriod: "annual",
    tierGroup: "api_business",
    features: API_BUSINESS_FEATURES,
    marketingFeatures: [],
    selfServe: true,
    highlighted: false,
    currentForCheckout: true,
    publicVisible: true,
  },

  enterprise: {
    // No Stripe price exists — Enterprise is quoted and provisioned by hand.
    // The key is the marker those manual grants carry so they resolve to a
    // plan like any other subscription.
    providerPriceId: "wm_enterprise",
    planKey: "enterprise",
    displayName: "Enterprise",
    priceCents: null,
    billingPeriod: "none",
    tierGroup: "enterprise",
    features: ENTERPRISE_FEATURES,
    marketingFeatures: [
      "Everything in Pro + API",
      "Unlimited API requests",
      "Dedicated support",
      "Custom integrations",
      "SLA guarantee",
      "On-premise option",
    ],
    selfServe: false,
    highlighted: false,
    currentForCheckout: false,
    publicVisible: true,
  },
};

// ---------------------------------------------------------------------------
// Aliases: provider identifiers that resolve to a plan but are not sold
// ---------------------------------------------------------------------------

/**
 * Empty as of 2026-08-05. It held six Dodo `pdt_…` product ids, including one
 * for an education-discounted API plan sold through the Dodo dashboard. None
 * of them mean anything under Stripe, no subscription on this deployment ever
 * carried one, and two of them pointed at Pro Business plan keys that no
 * longer exist — a stale alias resolves to a plan and then throws on the
 * feature lookup.
 *
 * The constant stays because the resolution chain in
 * `payments/subscriptionHelpers.ts` reads it: productPlans table → these
 * aliases → the catalog. Off-catalog prices (a negotiated rate, a discount
 * price sold outside the plan list) get their row here.
 */
export const LEGACY_PRODUCT_ALIASES: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/**
 * Plan-level precedence for entitlement recompute.
 *
 * Higher value = stronger plan. Used by the entitlement-recompute helper in
 * `subscriptionHelpers.ts` as the deterministic tie-breaker when a user has
 * multiple covering subscriptions of the same `tier` (e.g. `api_starter` and
 * `api_business` are both tier 2; monthly and annual variants of the same
 * tier-group share `tier`). The order is:
 *
 *   1. higher `features.tier` wins (always)
 *   2. higher `PLAN_PRECEDENCE` wins (capability tie-breaker within a tier)
 *   3. later `currentPeriodEnd` wins (duration tie-breaker within the same plan)
 *
 * KEEP IN SYNC with PRODUCT_CATALOG. Any new planKey added to the catalog
 * must also appear here, or the recompute helper falls back to 0 and the
 * tie-break degenerates to currentPeriodEnd.
 */
export const PLAN_PRECEDENCE: Record<string, number> = {
  free: 0,
  pro_monthly: 10,
  pro_annual: 11, // longer commitment outranks monthly at same tier
  api_starter: 20,
  api_starter_annual: 21,
  api_business: 30, // higher capability than api_starter at same tier 2
  api_business_annual: 31,
  enterprise: 40,
};

export function getEntitlementFeatures(planKey: string): PlanFeatures {
  const entry = PRODUCT_CATALOG[planKey];
  if (!entry) {
    throw new Error(
      `[productCatalog] Unknown planKey "${planKey}". Add it to PRODUCT_CATALOG.`,
    );
  }
  return entry.features;
}

export function getPlanLimit(
  planKey: string,
  dimension: PlanLimitDimension,
): number | null {
  const limits = getEntitlementFeatures(planKey).planLimits;
  if (!limits) return null;
  switch (dimension) {
    case "api_daily_requests":
      return limits.apiRequestsPerDay;
    case "api_minute_burst":
      return limits.apiBurstRequestsPerMinute;
    case "mcp_daily_calls":
      return limits.mcpCallsPerDay;
    case "mcp_minute_burst":
      return limits.mcpBurstRequestsPerMinute;
  }
}

export function resolveProductToPlan(providerPriceId: string): string | null {
  const entry = Object.values(PRODUCT_CATALOG).find(
    (e) => e.providerPriceId === providerPriceId,
  );
  if (entry) return entry.planKey;
  return LEGACY_PRODUCT_ALIASES[providerPriceId] ?? null;
}

export function getCheckoutProducts(): CatalogEntry[] {
  return Object.values(PRODUCT_CATALOG).filter((e) => e.currentForCheckout);
}

export function getPublicTiers(): CatalogEntry[] {
  return Object.values(PRODUCT_CATALOG).filter((e) => e.publicVisible);
}

export function getSeedableProducts(): Array<{
  providerPriceId: string;
  planKey: string;
  displayName: string;
  isActive: boolean;
}> {
  return Object.values(PRODUCT_CATALOG)
    .filter((e): e is CatalogEntry & { providerPriceId: string } => !!e.providerPriceId)
    .map((e) => ({
      providerPriceId: e.providerPriceId,
      planKey: e.planKey,
      displayName: e.displayName,
      isActive: true,
    }));
}
