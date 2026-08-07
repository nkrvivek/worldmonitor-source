import { convexTest } from "convex-test";
import Stripe from "stripe";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

/**
 * Only `customers.retrieve` is mocked. Signing and verification run through the
 * real SDK, which is what keeps the 401-vs-500 split under test: a bad secret
 * has to fail the same code path Stripe's deliveries hit. A subclass field is
 * assigned after `super()` returns, so it wins over the base constructor's own
 * assignment, and every static (`createSubtleCryptoProvider`, `webhooks`) is
 * inherited untouched.
 */
const { customersRetrieve } = vi.hoisted(() => ({
  customersRetrieve: vi.fn(),
}));
vi.mock("stripe", async () => {
  const actual = await vi.importActual<typeof import("stripe")>("stripe");
  const RealStripe = actual.default;
  class TestStripe extends RealStripe {
    customers = { retrieve: customersRetrieve } as unknown as RealStripe["customers"];
  }
  return { ...actual, default: TestStripe };
});

const modules = import.meta.glob("../**/*.ts");

async function makeT(): Promise<ReturnType<typeof convexTest>> {
  const t = convexTest(schema, modules);
  await t.mutation(
    internal.payments.webhookMutations._seedFailureSummary,
    {},
  );
  return t;
}

const BASE_TIMESTAMP = new Date("2026-07-23T10:00:00Z").getTime();
const BASE_TIMESTAMP_SECONDS = Math.floor(BASE_TIMESTAMP / 1000);
const STRIPE_SECRET_KEY = "sk_test_webhook_failure_suite";
const STRIPE_WEBHOOK_SECRET = "whsec_worldmonitor_webhook_failure_suite";
const CUSTOMER_EMAIL = "bad@example.com";

/**
 * Stripe re-signs on every retry, so the header carries a timestamp rather
 * than a delivery id. Tolerance checking compares it against `Date.now()`,
 * which each test pins to BASE_TIMESTAMP.
 */
async function signStripePayload(
  body: string,
  timestampSeconds: number = BASE_TIMESTAMP_SECONDS,
): Promise<string> {
  return Stripe.webhooks.generateTestHeaderStringAsync({
    payload: body,
    secret: STRIPE_WEBHOOK_SECRET,
    timestamp: timestampSeconds,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
}

/**
 * A `customer.subscription.created` delivery carrying an active subscription,
 * which the translator turns into one `subscription.active` internal event.
 * Billing periods sit on the subscription ITEM in this API version.
 */
function makeStripeSubscriptionEvent(eventId: string) {
  return {
    id: eventId,
    object: "event",
    api_version: "2026-07-29.dahlia",
    created: BASE_TIMESTAMP_SECONDS,
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_http_failure",
        object: "subscription",
        customer: "cus_http_failure",
        status: "active",
        canceled_at: null,
        currency: "usd",
        metadata: {},
        discounts: [],
        items: {
          object: "list",
          data: [
            {
              id: "si_http_failure",
              object: "subscription_item",
              current_period_start: BASE_TIMESTAMP_SECONDS,
              current_period_end: BASE_TIMESTAMP_SECONDS + 30 * 86400,
              price: {
                id: "price_http_failure",
                object: "price",
                lookup_key: "wm_pro_monthly",
                unit_amount: 2900,
                currency: "usd",
                tax_behavior: "exclusive",
              },
            },
          ],
        },
      },
    },
  };
}

/** The webhook id the handler derives for the one event above. */
function dispatchIdOf(eventId: string): string {
  return `${eventId}#subscription.active`;
}

function setStripeEnv() {
  process.env.STRIPE_SECRET_KEY = STRIPE_SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WEBHOOK_SECRET;
  customersRetrieve.mockResolvedValue({
    id: "cus_http_failure",
    object: "customer",
    email: CUSTOMER_EMAIL,
  });
}

function failureArgs(overrides: Record<string, unknown> = {}) {
  return {
    webhookId: "wh_failure_001",
    eventType: "subscription.renewed",
    rawPayload: {
      type: "subscription.renewed",
      data: {
        subscription_id: "sub_failure_001",
        payment_id: "pay_failure_001",
        customer: {
          customer_id: "cus_failure_001",
          email: "subscriber@example.com",
        },
        metadata: {
          wm_user_id: "user_failure_001",
          secret: "should-not-be-persisted",
        },
        next_billing_date: "2026-08-23T10:00:00Z",
      },
    },
    timestamp: BASE_TIMESTAMP,
    receivedAt: BASE_TIMESTAMP,
    errorKind: "ValidationError",
    errorMessage: "invalid subscription for subscriber@example.com secret=should-not-be-persisted",
    ...overrides,
  };
}

describe("Stripe webhook failure tracking", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    customersRetrieve.mockReset();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  test("dead-letters an application-invalid subscription received through the HTTP handler", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
    setStripeEnv();
    const t = await makeT();
    const body = JSON.stringify(
      makeStripeSubscriptionEvent("evt_http_failure_001"),
    );
    const webhookId = dispatchIdOf("evt_http_failure_001");

    const response = await t.fetch("/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": await signStripePayload(body) },
      body,
    });
    await t.finishInProgressScheduledFunctions();

    expect(response.status).toBe(500);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      webhookId,
      eventType: "subscription.active",
      providerSubscriptionId: "sub_http_failure",
      providerCustomerId: "cus_http_failure",
      unresolved: true,
      attemptCount: 1,
    });
    expect("rawPayload" in rows[0]).toBe(false);

    const reportLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await t.mutation(
      internal.payments.webhookMutations.reportWebhookFailure,
      {
        webhookId,
        eventType: "subscription.active",
        errorKind: "Error",
        errorMessage: "Cannot resolve userId",
        attemptCount: 1,
        unresolvedCount: 1,
        eventTypes: ["subscription.active"],
      },
    );
    expect(reportLog).toHaveBeenCalledWith(
      expect.stringContaining("unresolvedCount=1"),
    );
  });

  test("queues the production operations signal after the failure commits", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    try {
      vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
      setStripeEnv();
      const t = await makeT();
      const body = JSON.stringify(
        makeStripeSubscriptionEvent("evt_http_signal_001"),
      );
      const webhookId = dispatchIdOf("evt_http_signal_001");

      const response = await t.fetch("/stripe-webhook", {
        method: "POST",
        headers: { "stripe-signature": await signStripePayload(body) },
        body,
      });

      expect(response.status).toBe(500);
      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      const reportJobs = scheduled.filter((job) =>
        job.name.includes("reportWebhookFailure"),
      );
      expect(reportJobs).toHaveLength(1);
      expect(reportJobs[0].args).toEqual([
        expect.objectContaining({
          webhookId,
          eventType: "subscription.active",
          attemptCount: 1,
          unresolvedCount: 1,
          eventTypes: ["subscription.active"],
        }),
      ]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  test("records sanitized context for a malformed subscription event", async () => {
    const t = await makeT();

    await expect(
      t.mutation(internal.payments.webhookMutations.processWebhookEvent, {
        webhookId: "wh_malformed_subscription",
        eventType: "subscription.renewed",
        rawPayload: {
          type: "subscription.renewed",
          data: { payment_id: "pay_malformed", customer: { email: "bad@example.com" } },
        },
        timestamp: BASE_TIMESTAMP,
      }),
    ).rejects.toThrow(/Missing subscription_id/);

    const signal = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({
        webhookId: "wh_malformed_subscription",
        rawPayload: {
          type: "subscription.renewed",
          data: {
            payment_id: "pay_malformed",
            customer: { email: "bad@example.com" },
          },
        },
      }),
    );

    expect(signal).toMatchObject({
      isNew: true,
      attemptCount: 1,
      unresolvedCount: 1,
      eventTypes: ["subscription.renewed"],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      webhookId: "wh_malformed_subscription",
      eventType: "subscription.renewed",
      providerPaymentId: "pay_malformed",
      unresolved: true,
      attemptCount: 1,
      dataKeys: ["customer", "payment_id"],
    });
    expect(rows[0].errorMessage).toBe("invalid subscription for [redacted-email] secret=[redacted]");
    expect("rawPayload" in rows[0]).toBe(false);
  });

  test("updates the same failure row for repeated webhook deliveries", async () => {
    const t = await makeT();

    const first = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    const second = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({
        timestamp: BASE_TIMESTAMP + 5000,
        receivedAt: BASE_TIMESTAMP + 5000,
        errorMessage: "still invalid",
      }),
    );

    expect(first.isNew).toBe(true);
    expect(second).toMatchObject({
      isNew: false,
      attemptCount: 2,
      unresolvedCount: 1,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attemptCount).toBe(2);
    expect(rows[0].lastSeenAt).toBe(BASE_TIMESTAMP + 5000);
  });

  test("keeps one row across overlapping same-ID mutation requests", async () => {
    const t = await makeT();

    // convex-test currently executes top-level functions one at a time, so
    // this proves the idempotent outcome but not a production OCC retry. The
    // shared pre-seeded summary read is the production serialization point.
    const [first, second] = await Promise.all([
      t.mutation(
        internal.payments.webhookMutations.recordWebhookFailure,
        failureArgs(),
      ),
      t.mutation(
        internal.payments.webhookMutations.recordWebhookFailure,
        failureArgs({ errorMessage: "same delivery, concurrent attempt" }),
      ),
    ]);

    expect([first.isNew, second.isNew].sort()).toEqual([false, true]);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attemptCount).toBe(2);

    const summary = await t.query(
      internal.payments.webhookMutations.getWebhookFailureDiagnostics,
      {},
    );
    expect(summary.unresolvedCount).toBe(1);
  });

  test("tolerates and self-heals duplicate summary seed rows", async () => {
    const t = await makeT();
    await t.run(async (ctx) => {
      await ctx.db.insert("paymentWebhookFailureSummary", {
        key: "global",
        unresolvedCount: 0,
        eventTypes: [],
        updatedAt: BASE_TIMESTAMP,
      });
    });

    const signal = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    expect(signal).toMatchObject({
      attemptCount: 1,
      unresolvedCount: 1,
      eventTypes: ["subscription.renewed"],
    });

    const diagnostics = await t.query(
      internal.payments.webhookMutations.getWebhookFailureDiagnostics,
      {},
    );
    expect(diagnostics.unresolvedCount).toBe(1);

    const seed = await t.mutation(
      internal.payments.webhookMutations._seedFailureSummary,
      {},
    );
    expect(seed).toEqual({ seeded: 0, deduped: 1 });
    const summaries = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailureSummary").collect(),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      unresolvedCount: 1,
      eventTypes: [{ eventType: "subscription.renewed", count: 1 }],
    });
  });

  test("keeps distinct webhook IDs separate for the same subscription", async () => {
    const t = await makeT();

    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({ webhookId: "wh_failure_a" }),
    );
    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({ webhookId: "wh_failure_b" }),
    );

    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.providerSubscriptionId)).toEqual([
      "sub_failure_001",
      "sub_failure_001",
    ]);
    const summary = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailureSummary").collect(),
    );
    expect(summary[0]).toMatchObject({
      unresolvedCount: 2,
      eventTypes: [{ eventType: "subscription.renewed", count: 2 }],
    });

    const diagnostics = await t.query(
      internal.payments.webhookMutations.getWebhookFailureDiagnostics,
      { limit: 10 },
    );
    expect(diagnostics).toMatchObject({
      unresolvedCount: 2,
      eventTypes: [{ eventType: "subscription.renewed", count: 2 }],
    });
    expect(diagnostics.failures).toHaveLength(2);
    expect("rawPayload" in diagnostics.failures[0]).toBe(false);
  });

  test("resolves a failure and removes it from the unresolved diagnostic query", async () => {
    const t = await makeT();

    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    await t.mutation(
      internal.payments.webhookMutations.resolveWebhookFailure,
      {
        webhookId: "wh_failure_001",
        resolvedBy: "on-call@example.com",
        resolutionNote: "Reconciled the subscription manually",
      },
    );

    const unresolved = await t.query(
      internal.payments.webhookMutations.listUnresolvedWebhookFailures,
      {},
    );
    expect(unresolved).toHaveLength(0);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows[0]).toMatchObject({
      unresolved: false,
      resolvedBy: "on-call@example.com",
      resolutionNote: "Reconciled the subscription manually",
    });
    expect(rows[0].resolvedAt).toBeTypeOf("number");

    const summary = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailureSummary").collect(),
    );
    expect(summary[0]).toMatchObject({
      unresolvedCount: 0,
      eventTypes: [],
    });
  });

  test("automatically resolves a transient failure after a successful retry", async () => {
    const t = await makeT();

    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    await t.mutation(
      internal.payments.webhookMutations.markWebhookFailureRecovered,
      { webhookId: "wh_failure_001" },
    );

    const unresolved = await t.query(
      internal.payments.webhookMutations.listUnresolvedWebhookFailures,
      {},
    );
    expect(unresolved).toHaveLength(0);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows[0]).toMatchObject({
      unresolved: false,
      resolvedBy: "provider-retry",
      resolutionNote: "Processed successfully on provider retry",
    });
  });

  test("recovers a failure through the signed HTTP retry path", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
    vi.stubEnv("RESEND_API_KEY", "");
    setStripeEnv();
    const t = await makeT();
    const payload = makeStripeSubscriptionEvent("evt_http_recovery_001");
    const subscription = payload.data.object;
    const webhookId = dispatchIdOf(payload.id);

    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        userId: "user_http_recovery",
        providerCustomerId: subscription.customer,
        email: CUSTOMER_EMAIL,
        normalizedEmail: CUSTOMER_EMAIL,
        createdAt: BASE_TIMESTAMP,
        updatedAt: BASE_TIMESTAMP,
      });
    });
    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({
        webhookId,
        eventType: "subscription.active",
        rawPayload: {
          type: "subscription.active",
          data: { subscription_id: subscription.id },
        },
      }),
    );

    const body = JSON.stringify(payload);
    const response = await t.fetch("/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": await signStripePayload(body) },
      body,
    });

    expect(response.status).toBe(200);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      webhookId,
      unresolved: false,
      resolvedBy: "provider-retry",
      resolutionNote: "Processed successfully on provider retry",
    });

    const diagnostics = await t.query(
      internal.payments.webhookMutations.getWebhookFailureDiagnostics,
      {},
    );
    expect(diagnostics.unresolvedCount).toBe(0);
    expect(diagnostics.failures).toHaveLength(0);
  });

  test("moves the event bucket when a redelivery changes event type", async () => {
    const t = await makeT();

    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    const signal = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({
        eventType: "subscription.on_hold",
        rawPayload: {
          type: "subscription.on_hold",
          data: { subscription_id: "sub_failure_001" },
        },
      }),
    );

    expect(signal).toMatchObject({
      isNew: false,
      attemptCount: 2,
      unresolvedCount: 1,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("subscription.on_hold");

    const summary = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailureSummary").collect(),
    );
    expect(summary[0]).toMatchObject({
      unresolvedCount: 1,
      eventTypes: [{ eventType: "subscription.on_hold", count: 1 }],
    });
  });

  test("reopens a resolved incident as a fresh unresolved failure", async () => {
    const t = await makeT();

    await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs(),
    );
    await t.mutation(
      internal.payments.webhookMutations.resolveWebhookFailure,
      {
        webhookId: "wh_failure_001",
        resolvedBy: "on-call@example.com",
      },
    );
    const signal = await t.mutation(
      internal.payments.webhookMutations.recordWebhookFailure,
      failureArgs({
        timestamp: BASE_TIMESTAMP + 5000,
        receivedAt: BASE_TIMESTAMP + 5000,
      }),
    );

    expect(signal).toMatchObject({
      isNew: false,
      attemptCount: 2,
      unresolvedCount: 1,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ unresolved: true, attemptCount: 2 });
    expect(rows[0].resolvedAt).toBeUndefined();
    expect(rows[0].resolvedBy).toBeUndefined();
    expect(rows[0].resolutionNote).toBeUndefined();

    const summary = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailureSummary").collect(),
    );
    expect(summary[0]).toMatchObject({
      unresolvedCount: 1,
      eventTypes: [{ eventType: "subscription.renewed", count: 1 }],
    });
  });

  test("dead-letters an authenticated but schema-invalid payload with 500, not 401", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
    setStripeEnv();
    const t = await makeT();
    // Signed, valid JSON, and still not an event: no `data.object`. The SDK
    // parses without validating, so the handler's own shape guard is the only
    // thing standing between this and a silent 200.
    const webhookId = "evt_http_schema_invalid";
    const body = JSON.stringify({
      id: webhookId,
      object: "event",
      created: BASE_TIMESTAMP_SECONDS,
      type: "customer.subscription.created",
      data: { subscription_id: "sub_schema_invalid" },
    });

    const response = await t.fetch("/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": await signStripePayload(body) },
      body,
    });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toBe("Invalid webhook signature");
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      webhookId,
      eventType: "customer.subscription.created",
      providerSubscriptionId: "sub_schema_invalid",
      errorKind: "WebhookPayloadValidationError",
      unresolved: true,
      attemptCount: 1,
    });
    expect("rawPayload" in rows[0]).toBe(false);
  });

  test("dead-letters an authenticated but unparseable body with 500, not 401", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
    setStripeEnv();
    const t = await makeT();
    const body = "this is not json";

    const response = await t.fetch("/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": await signStripePayload(body) },
      body,
    });

    expect(response.status).toBe(500);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Stripe signs a fresh timestamp on every retry, so a body we cannot
      // read has no stable delivery id; retries collapse onto this sentinel.
      webhookId: "stripe:unparseable-payload",
      eventType: "unknown",
      errorKind: "SyntaxError",
      dataKeys: [],
      unresolved: true,
      attemptCount: 1,
    });
    expect("rawPayload" in rows[0]).toBe(false);
  });

  test("still rejects a bad signature with 401 and records no failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIMESTAMP);
    setStripeEnv();
    const t = await makeT();
    const body = JSON.stringify(
      makeStripeSubscriptionEvent("evt_http_bad_signature"),
    );

    const response = await t.fetch("/stripe-webhook", {
      method: "POST",
      headers: {
        "stripe-signature": `t=${BASE_TIMESTAMP_SECONDS},v1=${"a".repeat(64)}`,
      },
      body,
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid webhook signature");
    const rows = await t.run(async (ctx) =>
      ctx.db.query("paymentWebhookFailures").collect(),
    );
    expect(rows).toHaveLength(0);
  });
});
