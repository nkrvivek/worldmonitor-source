import { afterEach, describe, expect, test, vi } from "vitest";

const { checkoutCreate, pricesList, promotionCodesList, constructorCalls } =
  vi.hoisted(() => ({
    checkoutCreate: vi.fn(),
    pricesList: vi.fn(),
    promotionCodesList: vi.fn(),
    constructorCalls: [] as unknown[],
  }));

const FETCH_CLIENT = { kind: "fetch-http-client" };

vi.mock("stripe", () => ({
  default: class {
    static createFetchHttpClient() {
      return FETCH_CLIENT;
    }

    checkout = { sessions: { create: checkoutCreate } };
    prices = { list: pricesList };
    promotionCodes = { list: promotionCodesList };

    constructor(apiKey: string, config: unknown) {
      constructorCalls.push({ apiKey, config });
    }
  },
}));

import {
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS,
  STRIPE_API_VERSION,
  buildCheckoutClientOptions,
  createStripeCheckoutSession,
  resetCheckoutPriceCache,
  resolveCheckoutPriceId,
  resolvePromotionCodeId,
  type CheckoutSessionPayload,
} from "../lib/stripe";

const originalSecretKey = process.env.STRIPE_SECRET_KEY;

afterEach(() => {
  checkoutCreate.mockReset();
  pricesList.mockReset();
  promotionCodesList.mockReset();
  constructorCalls.length = 0;
  resetCheckoutPriceCache();
  if (originalSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalSecretKey;
});

describe("Stripe checkout production client seam", () => {
  test("constructs the SDK with retries disabled and creates the payload exactly once", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_seam";
    checkoutCreate.mockResolvedValue({
      id: "cs_retry_owner",
      url: "https://checkout.stripe.com/c/pay/cs_retry_owner",
    });
    const payload: CheckoutSessionPayload = {
      mode: "subscription",
      line_items: [{ price: "price_retry_owner", quantity: 1 }],
      success_url: "https://worldmonitor.app/?wm_checkout=return",
      cancel_url: "https://worldmonitor.app/?wm_checkout=return",
    };

    const result = await createStripeCheckoutSession(payload);

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).toMatchObject({
      apiKey: "sk_test_seam",
      config: {
        apiVersion: STRIPE_API_VERSION,
        httpClient: FETCH_CLIENT,
        // The retry ladder in payments/checkoutRateLimit.ts owns all retry
        // policy. Stripe spells this maxNetworkRetries, not maxRetries.
        maxNetworkRetries: 0,
        timeout: CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS,
      },
    });
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    expect(checkoutCreate).toHaveBeenCalledWith(payload);
    expect(result).toEqual({
      checkout_url: "https://checkout.stripe.com/c/pay/cs_retry_owner",
    });
  });

  test("a session created without a url fails instead of returning a dead link", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_seam";
    checkoutCreate.mockResolvedValue({ id: "cs_no_url", url: null });

    await expect(
      createStripeCheckoutSession({ mode: "subscription" }),
    ).rejects.toThrow("Stripe checkout session cs_no_url has no url");
  });

  test("throws a named error when the secret key is missing", () => {
    delete process.env.STRIPE_SECRET_KEY;

    expect(() => buildCheckoutClientOptions({})).toThrow(
      /STRIPE_SECRET_KEY is not set/,
    );
  });
});

describe("lookup_key resolution", () => {
  test("resolves a lookup key to a price id and reuses it on the next call", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_seam";
    pricesList.mockResolvedValue({ data: [{ id: "price_pro_monthly" }] });

    expect(await resolveCheckoutPriceId("wm_pro_monthly")).toBe(
      "price_pro_monthly",
    );
    expect(await resolveCheckoutPriceId("wm_pro_monthly")).toBe(
      "price_pro_monthly",
    );

    expect(pricesList).toHaveBeenCalledTimes(1);
    expect(pricesList).toHaveBeenCalledWith({
      lookup_keys: ["wm_pro_monthly"],
      active: true,
      limit: 1,
    });
  });

  test("a miss is not cached, so a price created later is picked up", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_seam";
    pricesList.mockResolvedValueOnce({ data: [] });

    await expect(resolveCheckoutPriceId("wm_api_monthly")).rejects.toThrow(
      'No active Stripe price with lookup_key "wm_api_monthly"',
    );

    pricesList.mockResolvedValueOnce({ data: [{ id: "price_api_monthly" }] });
    expect(await resolveCheckoutPriceId("wm_api_monthly")).toBe(
      "price_api_monthly",
    );
  });

  test("an unmatched promotion code resolves to null rather than failing the purchase", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_seam";
    promotionCodesList.mockResolvedValue({ data: [] });

    expect(await resolvePromotionCodeId("LAUNCH50")).toBeNull();
    expect(promotionCodesList).toHaveBeenCalledWith({
      code: "LAUNCH50",
      active: true,
      limit: 1,
    });
  });
});
