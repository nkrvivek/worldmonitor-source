import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../_generated/api";
import {
  createStripeCheckoutSession,
  resolveCheckoutPriceId,
  resolvePromotionCodeId,
} from "../lib/stripe";
import {
  CHECKOUT_RATE_LIMITED,
  CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS,
  CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS,
  CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS,
  CHECKOUT_RETRY_AFTER_SECONDS,
  checkoutRateLimitedOutcomeFromError,
  checkoutRetryClock,
  isCheckoutRateLimitedOutcome,
  retryAfterMsFromError,
  runCheckoutWithRateLimitRetry,
} from "../payments/checkoutRateLimit";
import schema from "../schema";

// The whole provider seam is mocked: checkout.ts resolves the catalog's
// lookup key to a price id and any discount code to a promotion-code id
// BEFORE entering the ladder, so both resolvers need a stub or every action
// test would fail before reaching the retry behaviour under test.
vi.mock("../lib/stripe", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createStripeCheckoutSession: vi.fn(),
  resolveCheckoutPriceId: vi.fn(async () => "price_rate_limited"),
  resolvePromotionCodeId: vi.fn(async () => null),
}));

const modules = import.meta.glob("../**/*.ts");
const TEST_SIGNING_SECRET = "checkout-rate-limit-test-signing-secret";
const TEST_RELAY_SECRET = "checkout-rate-limit-test-relay-secret";
const TEST_PROVIDER_ATTEMPT_TIMEOUT_MS = 3_500;
const TEST_RETRY_OPTIONS = {
  attemptTimeoutMs: TEST_PROVIDER_ATTEMPT_TIMEOUT_MS,
} as const;
const TEST_USER = {
  subject: "user_checkout_rate_limit",
  tokenIdentifier: "clerk|user_checkout_rate_limit",
  email: "rate-limit@example.com",
};
// Matches ANON_ID_V4_REGEX (lowercase hex, version 4, variant [89ab]) so the
// anonymous-claim-token merge path activates.
const ANON_USER_ID = "1f2e3d4c-5b6a-4789-8abc-def012345678";

/** SDK-shaped rate-limit error: typed status, no 429 wording in the message. */
function sdkRateLimitError(headers?: Record<string, string>) {
  return Object.assign(new Error("Rate limited by provider"), {
    status: 429,
    ...(headers ? { headers: new Headers(headers) } : {}),
  });
}

// Persistent (not *Once) rejection: the action retries 429s through the
// bounded ladder, so a sustained provider limit must fail EVERY attempt to
// exercise the exhaustion path.
function mockSustainedProviderRateLimit() {
  vi.mocked(createStripeCheckoutSession).mockRejectedValue(sdkRateLimitError());
}

/**
 * Compress the retry ladder to zero wall-clock and pin jitter to its midpoint
 * (factor 1.0), so waits equal their base values exactly; every other code
 * path stays real.
 */
function pinRetryClock() {
  vi.spyOn(checkoutRetryClock, "random").mockReturnValue(0.5);
  return vi.spyOn(checkoutRetryClock, "sleep").mockResolvedValue(undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks does not reset module-factory vi.fn()s — clear queued
  // once-values/implementations so no test inherits another's provider script.
  vi.mocked(createStripeCheckoutSession).mockReset();
  vi.mocked(resolveCheckoutPriceId).mockReset();
  vi.mocked(resolveCheckoutPriceId).mockResolvedValue("price_rate_limited");
  vi.mocked(resolvePromotionCodeId).mockReset();
  vi.mocked(resolvePromotionCodeId).mockResolvedValue(null);
  delete process.env.IDENTITY_SIGNING_SECRET;
  delete process.env.RELAY_SHARED_SECRET;
});

describe("checkout rate-limit classification", () => {
  test("recognizes a typed SDK 429 by status even without 429 wording", () => {
    const result = checkoutRateLimitedOutcomeFromError(sdkRateLimitError());

    expect(result).toEqual({
      checkoutFailed: true,
      code: CHECKOUT_RATE_LIMITED,
      retryAfterSeconds: CHECKOUT_RETRY_AFTER_SECONDS,
    });
    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
  });

  test("keeps recognizing the legacy component-era 429 message shape", () => {
    const result = checkoutRateLimitedOutcomeFromError(
      new Error("Failed to create checkout session: 429 status code (no body)"),
    );

    expect(result).toMatchObject({ code: CHECKOUT_RATE_LIMITED });
  });

  test("does not reclassify other upstream failures as rate limiting", () => {
    expect(
      checkoutRateLimitedOutcomeFromError(
        new Error("Failed to create checkout session: 503 no healthy upstream"),
      ),
    ).toBeNull();
    expect(
      checkoutRateLimitedOutcomeFromError(
        Object.assign(new Error("Bad request"), { status: 400 }),
      ),
    ).toBeNull();
    expect(
      isCheckoutRateLimitedOutcome({
        checkoutFailed: true,
        code: CHECKOUT_RATE_LIMITED,
        retryAfterSeconds: 999,
      }),
    ).toBe(false);
  });

  test("extracts an advertised Retry-After in ms, seconds, or not at all", () => {
    expect(
      retryAfterMsFromError(sdkRateLimitError({ "retry-after-ms": "1500" })),
    ).toBe(1500);
    expect(
      retryAfterMsFromError(sdkRateLimitError({ "retry-after": "3" })),
    ).toBe(3000);
    expect(retryAfterMsFromError(sdkRateLimitError())).toBeNull();
    expect(
      retryAfterMsFromError(sdkRateLimitError({ "retry-after": "soon" })),
    ).toBeNull();
    expect(retryAfterMsFromError(new Error("no headers"))).toBeNull();
  });
});

describe("relay and public action contracts", () => {
  test("a transient provider 429 is absorbed by the bounded retry and checkout succeeds (#6027)", async () => {
    process.env.IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    const sleeps = pinRetryClock();
    // Local call counter instead of chained *Once mocks: an unconsumed once-
    // queue entry would leak into the next test (restoreAllMocks does not
    // clear module-factory vi.fn queues).
    let providerCalls = 0;
    vi.mocked(createStripeCheckoutSession).mockImplementation(async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw sdkRateLimitError();
      }
      return {
        checkout_url: "https://checkout.stripe.com/c/pay/cks_transient",
      };
    });
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: TEST_USER.subject,
        productId: "prod_rate_limited",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      checkout_url: "https://checkout.stripe.com/c/pay/cks_transient",
    });
    expect(providerCalls).toBe(2);
    expect(sleeps.mock.calls).toEqual([[CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS[0]]]);
  });

  test("an anonymous user keeps the claim token through an absorbed 429", async () => {
    process.env.IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    pinRetryClock();
    let providerCalls = 0;
    vi.mocked(createStripeCheckoutSession).mockImplementation(async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw sdkRateLimitError();
      }
      return {
        checkout_url: "https://checkout.stripe.com/c/pay/cks_anon",
      };
    });
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: ANON_USER_ID,
        productId: "prod_rate_limited",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      checkout_url: "https://checkout.stripe.com/c/pay/cks_anon",
    });
    expect(typeof body.anonymous_claim_token).toBe("string");
    expect(body.anonymous_claim_token.length).toBeGreaterThan(0);
  });

  test("the internal relay preserves the real action outcome as HTTP 429", async () => {
    process.env.IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    mockSustainedProviderRateLimit();
    const sleeps = pinRetryClock();
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: TEST_USER.subject,
        productId: "prod_rate_limited",
      }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(
      String(CHECKOUT_RETRY_AFTER_SECONDS),
    );
    const body = await response.json();
    expect(body).toEqual({
      error: CHECKOUT_RATE_LIMITED,
      message: "Checkout is temporarily rate limited. Retry shortly.",
    });
    // The typed outcome must never leak an anonymous claim token.
    expect(body.anonymous_claim_token).toBeUndefined();
    // The whole bounded ladder ran before the typed outcome surfaced.
    expect(sleeps.mock.calls).toEqual(
      CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS.map((ms) => [ms]),
    );
  });

  test("a non-429 provider timeout remains relay HTTP 500 after one provider call", async () => {
    process.env.IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    const sleeps = pinRetryClock();
    vi.mocked(createStripeCheckoutSession).mockRejectedValue(
      Object.assign(new Error("Request timed out."), { name: "TimeoutError" }),
    );
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: TEST_USER.subject,
        productId: "prod_provider_timeout",
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Checkout failed: Request timed out."),
    });
    expect(createStripeCheckoutSession).toHaveBeenCalledTimes(1);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("the public action keeps provider rate limits on its error channel", async () => {
    process.env.IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    mockSustainedProviderRateLimit();
    pinRetryClock();
    const t = convexTest(schema, modules);

    const request = t.withIdentity(TEST_USER).action(
      api.payments.checkout.createCheckout,
      {
        productId: "prod_rate_limited",
      },
    );
    await expect(request).rejects.toBeInstanceOf(Error);
    await request.catch((error: unknown) => {
      const data = JSON.parse(String((error as { data?: unknown }).data));
      expect(data).toMatchObject({
        code: CHECKOUT_RATE_LIMITED,
        retryAfterSeconds: CHECKOUT_RETRY_AFTER_SECONDS,
      });
    });
  });
});

describe("runCheckoutWithRateLimitRetry", () => {
  test("a first-attempt success makes exactly one provider call and never sleeps", async () => {
    const sleeps = pinRetryClock();
    const attempt = vi.fn().mockResolvedValue({ checkout_url: "https://x" });
    const retries: number[] = [];

    const result = await runCheckoutWithRateLimitRetry(attempt, {
      ...TEST_RETRY_OPTIONS,
      onRetry: (ms) => retries.push(ms),
    });

    expect(result).toEqual({ checkout_url: "https://x" });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("returns the typed outcome only after exhausting every ladder step", async () => {
    const sleeps = pinRetryClock();
    const attempt = vi.fn().mockRejectedValue(sdkRateLimitError());
    const retries: number[] = [];

    const result = await runCheckoutWithRateLimitRetry(attempt, {
      ...TEST_RETRY_OPTIONS,
      onRetry: (ms) => retries.push(ms),
    });

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS);
    expect(retries).toEqual([...CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS]);
    expect(sleeps.mock.calls).toEqual(
      CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS.map((ms) => [ms]),
    );
  });

  test("jitter spreads the wait around the ladder step", async () => {
    const sleeps = vi
      .spyOn(checkoutRetryClock, "sleep")
      .mockResolvedValue(undefined);
    // random() = 1 -> factor 1.25 (upper jitter bound).
    vi.spyOn(checkoutRetryClock, "random").mockReturnValue(1);
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(sdkRateLimitError())
      .mockResolvedValueOnce({ checkout_url: "https://x" });

    await runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS);

    expect(sleeps.mock.calls).toEqual([
      [Math.round(CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS[0] * 1.25)],
    ]);
  });

  test("low jitter never reduces an advertised Retry-After provider floor", async () => {
    const sleeps = vi
      .spyOn(checkoutRetryClock, "sleep")
      .mockResolvedValue(undefined);
    vi.spyOn(checkoutRetryClock, "random").mockReturnValue(0);
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(sdkRateLimitError({ "retry-after": "3" }))
      .mockResolvedValueOnce({ checkout_url: "https://x" });

    const result = await runCheckoutWithRateLimitRetry(
      attempt,
      TEST_RETRY_OPTIONS,
    );

    expect(result).toEqual({ checkout_url: "https://x" });
    // random() = 0 jitters the 1000ms ladder step down to 750ms, but the
    // provider's Retry-After remains a hard 3000ms floor.
    expect(sleeps.mock.calls).toEqual([[3000]]);
  });

  test("an advertised Retry-After beyond the budget bails to the typed outcome", async () => {
    const sleeps = pinRetryClock();
    const attempt = vi
      .fn()
      .mockRejectedValue(sdkRateLimitError({ "retry-after": "60" }));

    const result = await runCheckoutWithRateLimitRetry(
      attempt,
      TEST_RETRY_OPTIONS,
    );

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("stops retrying once the next wait would cross the wall-clock budget", async () => {
    const sleeps = pinRetryClock();
    // First now() call anchors the deadline; every later check sits at the
    // deadline, so even the first retry's wait would cross it.
    vi.spyOn(checkoutRetryClock, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS);
    const attempt = vi.fn().mockRejectedValue(sdkRateLimitError());
    const retries: number[] = [];

    const result = await runCheckoutWithRateLimitRetry(attempt, {
      ...TEST_RETRY_OPTIONS,
      onRetry: (ms) => retries.push(ms),
    });

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("a mid-ladder budget exhaustion bails after the retries that fit", async () => {
    const sleeps = pinRetryClock();
    // Deadline anchored at 0; the first pre- and post-wait checks pass, then
    // the second pre-wait check sits at the deadline and bails.
    vi.spyOn(checkoutRetryClock, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS);
    const attempt = vi.fn().mockRejectedValue(sdkRateLimitError());

    const result = await runCheckoutWithRateLimitRetry(
      attempt,
      TEST_RETRY_OPTIONS,
    );

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleeps.mock.calls).toEqual([[CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS[0]]]);
  });

  test("does not start a retry unless its wait and maximum attempt fit the deadline", async () => {
    let nowMs = 0;
    vi.spyOn(checkoutRetryClock, "now").mockImplementation(() => nowMs);
    vi.spyOn(checkoutRetryClock, "random").mockReturnValue(0.5);
    const sleeps = vi
      .spyOn(checkoutRetryClock, "sleep")
      .mockImplementation(async (ms) => {
        nowMs += ms;
      });
    const attemptStarts: number[] = [];
    const attempt = vi.fn().mockImplementation(async () => {
      attemptStarts.push(nowMs);
      nowMs += 3_000;
      throw sdkRateLimitError();
    });

    const result = await runCheckoutWithRateLimitRetry(
      attempt,
      TEST_RETRY_OPTIONS,
    );

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attemptStarts).toEqual([0, 4_000]);
    expect(
      attemptStarts[1] + TEST_PROVIDER_ATTEMPT_TIMEOUT_MS,
    ).toBeLessThanOrEqual(CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleeps.mock.calls).toEqual([[CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS[0]]]);
  });

  test("rechecks the deadline after a late timer wakeup before starting the attempt", async () => {
    let nowMs = 0;
    vi.spyOn(checkoutRetryClock, "now").mockImplementation(() => nowMs);
    vi.spyOn(checkoutRetryClock, "random").mockReturnValue(0.5);
    const sleeps = vi
      .spyOn(checkoutRetryClock, "sleep")
      .mockImplementation(async () => {
        nowMs = 5_000;
      });
    const attempt = vi.fn().mockRejectedValue(sdkRateLimitError());

    const result = await runCheckoutWithRateLimitRetry(
      attempt,
      TEST_RETRY_OPTIONS,
    );

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveBeenCalledTimes(1);
  });

  test("rethrows a non-429 failure immediately without retrying", async () => {
    const sleeps = pinRetryClock();
    const attempt = vi
      .fn()
      .mockRejectedValue(
        new Error("Failed to create checkout session: 503 no healthy upstream"),
      );

    await expect(
      runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS),
    ).rejects.toThrow("503 no healthy upstream");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("rethrows a non-429 failure that follows an absorbed 429", async () => {
    pinRetryClock();
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(sdkRateLimitError())
      .mockRejectedValueOnce(new Error("Failed to create checkout session: 500"));

    await expect(
      runCheckoutWithRateLimitRetry(attempt, TEST_RETRY_OPTIONS),
    ).rejects.toThrow("500");
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

// The client-construction contract (maxNetworkRetries: 0, per-attempt
// timeout) is pinned in convex/__tests__/stripeCheckoutClient.test.ts, which
// mocks the SDK itself. This file mocks the seam, so it cannot see it.
