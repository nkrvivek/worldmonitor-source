import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  EMAIL_FROM,
  SUPPORT_EMAIL,
  logoUrl,
  siteHost,
  siteOrigin,
  sitePath,
} from "../emailBrand";
import { DEFAULT_SITE_URL } from "../payments/returnUrl";

// Transactional mail only. convex/broadcast/proLaunchEmailContent.ts is
// upstream's one-off launch campaign, kept verbatim as fork history.
const TRANSACTIONAL_EMAIL_MODULES = [
  "convex/apiPlanLimitEmails.ts",
  "convex/payments/billing.ts",
  "convex/payments/businessSeats.ts",
  "convex/payments/subscriptionEmails.ts",
];

describe("email brand", () => {
  test("links and sender point at the host this fork runs", () => {
    expect(siteOrigin()).toBe(new URL(DEFAULT_SITE_URL).origin);
    expect(siteHost()).toBe(new URL(DEFAULT_SITE_URL).host);
    expect(sitePath("/settings")).toBe(`${siteOrigin()}/settings`);
    expect(logoUrl()).toBe(`${siteOrigin()}/favico/android-chrome-192x192.png`);
    expect(EMAIL_FROM).toContain(SUPPORT_EMAIL);
  });

  test("SITE_URL moves every link at once", () => {
    const previous = process.env.SITE_URL;
    process.env.SITE_URL = "https://staging.example.com";
    try {
      expect(sitePath("/pro")).toBe("https://staging.example.com/pro");
      expect(siteHost()).toBe("staging.example.com");
    } finally {
      if (previous === undefined) delete process.env.SITE_URL;
      else process.env.SITE_URL = previous;
    }
  });

  // Upstream wrote its own domain into each email module. A sender on a domain
  // we cannot send from gets the send rejected, and a body link — the business
  // invite carried a live token in its query string — hands the customer to
  // somebody else's server.
  test.each(TRANSACTIONAL_EMAIL_MODULES)(
    "%s names no upstream host",
    (path) => {
      expect(readFileSync(path, "utf8")).not.toContain("worldmonitor.app");
    },
  );
});
