// AUTO-GENERATED from convex/config/productCatalog.ts and the MCP registry.
// Do not edit manually. Run: npm run product:facts
// @ts-check

export const PUBLIC_PRODUCT_FACTS = {
  "_generated": "scripts/generate-public-product-facts.mjs — do not edit by hand; run `npm run product:facts`",
  "product": {
    "name": "World Monitor",
    "lifecycle": "launched",
    "canonicalUrl": "https://worldmonitor.sibt.ai/",
    "pricingUrl": "https://worldmonitor.sibt.ai/pro#pricing",
    "primaryCtaLabel": "View Pro plans"
  },
  "currency": "USD",
  "plans": [
    {
      "planKey": "free",
      "name": "Free",
      "tierGroup": "free",
      "billingPeriod": "none",
      "billingDuration": null,
      "price": 0,
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": "https://worldmonitor.sibt.ai/pro#pricing",
      "currentForCheckout": false,
      "selfServe": false,
      "dashboardAiCallsPerDay": 0,
      "description": "Core dashboard panels, Global news feed, Earthquake & weather alerts, Basic map view, 3 dashboard tabs"
    },
    {
      "planKey": "pro_monthly",
      "name": "Pro Monthly",
      "tierGroup": "pro",
      "billingPeriod": "monthly",
      "billingDuration": "P1M",
      "price": 29,
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": "https://worldmonitor.sibt.ai/pro#pricing",
      "currentForCheckout": true,
      "selfServe": true,
      "dashboardAiCallsPerDay": 2500,
      "description": "Everything in Free, AI stock analysis & backtesting, Daily market briefs, Military & geopolitical tracking, Custom widget builder, 25 custom dashboards (vs 3), MCP + SDK access for Claude Desktop & other AI clients (250 calls/day), Data export — CSV, JSON & PDF reports, Priority support, Commercial license included"
    },
    {
      "planKey": "pro_annual",
      "name": "Pro Annual",
      "tierGroup": "pro",
      "billingPeriod": "annual",
      "billingDuration": "P1Y",
      "price": 290,
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": "https://worldmonitor.sibt.ai/pro#pricing",
      "currentForCheckout": true,
      "selfServe": true,
      "dashboardAiCallsPerDay": 2500,
      "description": ""
    },
    {
      "planKey": "api_starter",
      "name": "API Monthly",
      "tierGroup": "api_starter",
      "billingPeriod": "monthly",
      "billingDuration": "P1M",
      "price": 49,
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": "https://worldmonitor.sibt.ai/pro#pricing",
      "currentForCheckout": true,
      "selfServe": true,
      "dashboardAiCallsPerDay": 1000,
      "description": "REST API + official SDKs (npm, PyPI, RubyGems, Go), License / API key included, Real-time data streams, 60 requests/minute, 1,000 requests/day included, Webhook notifications, Commercial license — for your organization"
    },
    {
      "planKey": "api_starter_annual",
      "name": "API Annual",
      "tierGroup": "api_starter",
      "billingPeriod": "annual",
      "billingDuration": "P1Y",
      "price": 490,
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": "https://worldmonitor.sibt.ai/pro#pricing",
      "currentForCheckout": true,
      "selfServe": true,
      "dashboardAiCallsPerDay": 1000,
      "description": ""
    },
    {
      "planKey": "api_business",
      "name": "API Business",
      "tierGroup": "api_business",
      "billingPeriod": "monthly",
      "billingDuration": "P1M",
      "price": 299,
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": "https://worldmonitor.sibt.ai/pro#pricing",
      "currentForCheckout": true,
      "selfServe": true,
      "dashboardAiCallsPerDay": 10000,
      "description": "Everything in API Monthly, Redistribution rights — embed our data in what you sell, 300 requests/minute, 10,000 requests/day included, 5 Pro licenses included, Priority support, Commercial license — for your customers"
    },
    {
      "planKey": "api_business_annual",
      "name": "API Business Annual",
      "tierGroup": "api_business",
      "billingPeriod": "annual",
      "billingDuration": "P1Y",
      "price": 2990,
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": "https://worldmonitor.sibt.ai/pro#pricing",
      "currentForCheckout": true,
      "selfServe": true,
      "dashboardAiCallsPerDay": 10000,
      "description": ""
    },
    {
      "planKey": "enterprise",
      "name": "Enterprise",
      "tierGroup": "enterprise",
      "billingPeriod": "none",
      "billingDuration": null,
      "price": null,
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": "https://worldmonitor.sibt.ai/pro#pricing",
      "currentForCheckout": false,
      "selfServe": false,
      "dashboardAiCallsPerDay": null,
      "description": "Everything in Pro + API, Unlimited API requests, Dedicated support, Custom integrations, SLA guarantee, On-premise option"
    }
  ],
  "capabilities": {
    "mcpTools": 59,
    "locales": 26,
    "variants": 6,
    "mapLayers": 56,
    "feedDefinitions": 628,
    "freshnessTrackedSourceGroups": 35
  }
};

export const PRODUCT_CATALOG = {
  "wm_pro_monthly": {
    "planKey": "pro_monthly",
    "tierGroup": "pro",
    "billingPeriod": "monthly"
  },
  "wm_pro_annual": {
    "planKey": "pro_annual",
    "tierGroup": "pro",
    "billingPeriod": "annual"
  },
  "wm_api_monthly": {
    "planKey": "api_starter",
    "tierGroup": "api_starter",
    "billingPeriod": "monthly"
  },
  "wm_api_annual": {
    "planKey": "api_starter_annual",
    "tierGroup": "api_starter",
    "billingPeriod": "annual"
  },
  "wm_api_business_monthly": {
    "planKey": "api_business",
    "tierGroup": "api_business",
    "billingPeriod": "monthly"
  },
  "wm_api_business_annual": {
    "planKey": "api_business_annual",
    "tierGroup": "api_business",
    "billingPeriod": "annual"
  },
  "wm_enterprise": {
    "planKey": "enterprise",
    "tierGroup": "enterprise",
    "billingPeriod": "none"
  }
};

export const TIER_CONFIG = {
  "free": {
    "name": "Free",
    "localeKey": "free",
    "description": "Get started with the essentials",
    "features": [
      "Core dashboard panels",
      "Global news feed",
      "Earthquake & weather alerts",
      "Basic map view",
      "3 dashboard tabs"
    ],
    "planLimits": {
      "apiRequestsPerDay": 0,
      "apiBurstRequestsPerMinute": 0,
      "mcpCallsPerDay": 0,
      "dashboardAiCallsPerDay": 0,
      "mcpBurstRequestsPerMinute": 0
    },
    "cta": "Get Started",
    "href": "https://worldmonitor.sibt.ai/dashboard",
    "highlighted": false
  },
  "pro": {
    "name": "Pro",
    "localeKey": "pro",
    "description": "Full intelligence dashboard",
    "features": [
      "Everything in Free",
      "AI stock analysis & backtesting",
      "Daily market briefs",
      "Military & geopolitical tracking",
      "Custom widget builder",
      "25 custom dashboards (vs 3)",
      "MCP + SDK access for Claude Desktop & other AI clients (250 calls/day)",
      "Data export — CSV, JSON & PDF reports",
      "Priority support"
    ],
    "highlightFeatures": [
      "Commercial license included"
    ],
    "planLimits": {
      "apiRequestsPerDay": 0,
      "apiBurstRequestsPerMinute": 0,
      "mcpCallsPerDay": 250,
      "dashboardAiCallsPerDay": 2500,
      "mcpBurstRequestsPerMinute": 60
    },
    "highlighted": true
  },
  "api_starter": {
    "name": "API",
    "localeKey": "api",
    "description": "Build internal tools on live intelligence data",
    "features": [
      "REST API + official SDKs (npm, PyPI, RubyGems, Go)",
      "License / API key included",
      "Real-time data streams",
      "60 requests/minute",
      "1,000 requests/day included",
      "Webhook notifications"
    ],
    "highlightFeatures": [
      "Commercial license — for your organization"
    ],
    "planLimits": {
      "apiRequestsPerDay": 1000,
      "apiBurstRequestsPerMinute": 60,
      "mcpCallsPerDay": 1000,
      "dashboardAiCallsPerDay": 1000,
      "mcpBurstRequestsPerMinute": 60
    },
    "highlighted": false
  },
  "api_business": {
    "name": "API Business",
    "localeKey": "apiBusiness",
    "description": "Launch your own product on WorldMonitor data",
    "features": [
      "Everything in API Monthly",
      "Redistribution rights — embed our data in what you sell",
      "300 requests/minute",
      "10,000 requests/day included",
      "5 Pro licenses included",
      "Priority support"
    ],
    "highlightFeatures": [
      "Commercial license — for your customers"
    ],
    "planLimits": {
      "apiRequestsPerDay": 10000,
      "apiBurstRequestsPerMinute": 300,
      "mcpCallsPerDay": 10000,
      "dashboardAiCallsPerDay": 10000,
      "mcpBurstRequestsPerMinute": 300
    },
    "highlighted": false
  },
  "enterprise": {
    "name": "Enterprise",
    "localeKey": "enterprise",
    "description": "Custom solutions for organizations",
    "features": [
      "Everything in Pro + API",
      "Unlimited API requests",
      "Dedicated support",
      "Custom integrations",
      "SLA guarantee",
      "On-premise option"
    ],
    "planLimits": {
      "apiRequestsPerDay": null,
      "apiBurstRequestsPerMinute": 1000,
      "mcpCallsPerDay": null,
      "dashboardAiCallsPerDay": null,
      "mcpBurstRequestsPerMinute": 1000
    },
    "cta": "Contact Sales",
    "href": "mailto:hello@sibt.ai",
    "highlighted": false
  }
};

export const PUBLIC_TIER_GROUPS = [
  "free",
  "pro",
  "api_starter",
  "api_business",
  "enterprise"
];

export const FALLBACK_PRICES = {
  "wm_pro_monthly": 2900,
  "wm_pro_annual": 29000,
  "wm_api_monthly": 4900,
  "wm_api_annual": 49000,
  "wm_api_business_monthly": 29900,
  "wm_api_business_annual": 299000
};
