import type Stripe from "stripe";
import { describe, expect, test } from "vitest";
import {
  stripeEventNeedsCustomer,
  translateStripeEvent,
} from "../payments/stripeWebhookEvents";

/**
 * The translator is pure — no database, no network, no clock — so every case
 * here is a literal Stripe payload in and a literal internal payload out. The
 * fixtures carry only the fields the translator reads; Stripe's own types
 * describe hundreds more, so the builders cast at the boundary rather than
 * spell out payloads nothing under test looks at.
 */

const PERIOD_START_SECONDS = Date.parse("2026-07-01T00:00:00Z") / 1000;
const PERIOD_END_SECONDS = Date.parse("2026-08-01T00:00:00Z") / 1000;
const CANCELLED_AT_SECONDS = Date.parse("2026-07-20T12:00:00Z") / 1000;

interface SubscriptionOverrides {
  status?: string;
  customer?: unknown;
  lookupKey?: string | null;
  priceId?: string;
  unitAmount?: number | null;
  currency?: string;
  taxBehavior?: string;
  canceledAt?: number | null;
  metadata?: Record<string, string> | null;
  discounts?: unknown[];
  items?: unknown;
}

function makeSubscription(
  overrides: SubscriptionOverrides = {},
): Stripe.Subscription {
  const {
    status = "active",
    customer = "cus_translate",
    lookupKey = "wm_pro_monthly",
    priceId = "price_translate",
    unitAmount = 2900,
    currency = "usd",
    taxBehavior = "exclusive",
    canceledAt = null,
    metadata = { wm_user_id: "user_1" },
    discounts = [],
    items,
  } = overrides;

  return {
    id: "sub_translate",
    object: "subscription",
    status,
    customer,
    canceled_at: canceledAt,
    metadata,
    discounts,
    items: items ?? {
      object: "list",
      data: [
        {
          id: "si_translate",
          object: "subscription_item",
          current_period_start: PERIOD_START_SECONDS,
          current_period_end: PERIOD_END_SECONDS,
          price: {
            id: priceId,
            object: "price",
            lookup_key: lookupKey,
            unit_amount: unitAmount,
            currency,
            tax_behavior: taxBehavior,
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

function makeEvent(
  type: string,
  object: unknown,
  previousAttributes?: unknown,
): Stripe.Event {
  return {
    id: "evt_translate",
    object: "event",
    type,
    created: PERIOD_START_SECONDS,
    data: { object, previous_attributes: previousAttributes },
  } as unknown as Stripe.Event;
}

interface InvoiceOverrides {
  billingReason?: string;
  subscription?: unknown;
  subscriptionMetadata?: Record<string, string>;
  amountPaid?: number;
  amountDue?: number;
  currency?: string;
  customer?: unknown;
  customerEmail?: string | null;
  metadata?: Record<string, string> | null;
  payments?: unknown;
  lines?: unknown;
}

function makeInvoice(overrides: InvoiceOverrides = {}): Stripe.Invoice {
  const {
    billingReason = "subscription_cycle",
    subscription = "sub_translate",
    subscriptionMetadata,
    amountPaid = 2900,
    amountDue = 2900,
    currency = "usd",
    customer = "cus_translate",
    customerEmail = "buyer@example.com",
    metadata = {},
    payments,
    lines,
  } = overrides;

  return {
    id: "in_translate",
    object: "invoice",
    billing_reason: billingReason,
    amount_paid: amountPaid,
    amount_due: amountDue,
    currency,
    customer,
    customer_email: customerEmail,
    metadata,
    parent: {
      type: "subscription_details",
      subscription_details: {
        subscription,
        metadata: subscriptionMetadata,
      },
    },
    payments: payments ?? {
      object: "list",
      data: [{ payment: { payment_intent: "pi_translate" } }],
    },
    lines: lines ?? {
      object: "list",
      data: [
        {
          id: "il_translate",
          period: { start: PERIOD_START_SECONDS, end: PERIOD_END_SECONDS },
        },
      ],
    },
  } as unknown as Stripe.Invoice;
}

/** The single translated event, or a readable failure when there is not exactly one. */
function onlyEvent(translation: ReturnType<typeof translateStripeEvent>) {
  expect(translation.kind).toBe("dispatch");
  if (translation.kind !== "dispatch") throw new Error("not a dispatch");
  expect(translation.events).toHaveLength(1);
  return translation.events[0];
}

describe("translateStripeEvent — subscription status drives the event", () => {
  test.each([
    ["active", "subscription.active", "active"],
    ["trialing", "subscription.active", "active"],
    ["past_due", "subscription.on_hold", "on_hold"],
    ["unpaid", "subscription.on_hold", "on_hold"],
    ["paused", "subscription.on_hold", "on_hold"],
    ["canceled", "subscription.cancelled", "cancelled"],
    ["incomplete_expired", "subscription.expired", "expired"],
  ])(
    "maps status %s to %s",
    (status, expectedEventType, expectedStatusWord) => {
      const event = makeEvent(
        "customer.subscription.updated",
        makeSubscription({ status }),
      );

      const translated = onlyEvent(translateStripeEvent(event));

      expect(translated.eventType).toBe(expectedEventType);
      expect(translated.data.status).toBe(expectedStatusWord);
    },
  );

  test("ignores incomplete, because nothing has been paid for yet", () => {
    const event = makeEvent(
      "customer.subscription.created",
      makeSubscription({ status: "incomplete" }),
    );

    const translation = translateStripeEvent(event);

    expect(translation).toEqual({
      kind: "ignored",
      reason: "subscription status incomplete has no lifecycle meaning",
    });
  });

  test("ignores an unrecognised status instead of guessing", () => {
    const event = makeEvent(
      "customer.subscription.updated",
      makeSubscription({ status: "some_future_status" }),
    );

    expect(translateStripeEvent(event)).toEqual({
      kind: "ignored",
      reason: "subscription status some_future_status has no lifecycle meaning",
    });
  });

  test("treats a deleted subscription as cancelled whatever its status says", () => {
    const event = makeEvent(
      "customer.subscription.deleted",
      makeSubscription({ status: "active" }),
    );

    const translated = onlyEvent(translateStripeEvent(event));

    expect(translated.eventType).toBe("subscription.cancelled");
    expect(translated.data.status).toBe("cancelled");
  });
});

describe("translateStripeEvent — the subscription payload", () => {
  test("reads the billing period off the subscription item, in milliseconds", () => {
    const event = makeEvent(
      "customer.subscription.created",
      makeSubscription(),
    );

    const translated = onlyEvent(translateStripeEvent(event));

    expect(translated.data.previous_billing_date).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(translated.data.next_billing_date).toBe("2026-08-01T00:00:00.000Z");
  });

  test("carries the price lookup key as product_id", () => {
    const event = makeEvent(
      "customer.subscription.created",
      makeSubscription({ lookupKey: "wm_api_business_annual" }),
    );

    expect(onlyEvent(translateStripeEvent(event)).data.product_id).toBe(
      "wm_api_business_annual",
    );
  });

  test("falls back to the price id when a price has no lookup key", () => {
    const event = makeEvent(
      "customer.subscription.created",
      makeSubscription({ lookupKey: null, priceId: "price_unkeyed" }),
    );

    expect(onlyEvent(translateStripeEvent(event)).data.product_id).toBe(
      "price_unkeyed",
    );
  });

  test("uppercases the currency and reads the tax behaviour", () => {
    const event = makeEvent(
      "customer.subscription.created",
      makeSubscription({ currency: "eur", taxBehavior: "inclusive" }),
    );

    const translated = onlyEvent(translateStripeEvent(event));

    expect(translated.data.currency).toBe("EUR");
    expect(translated.data.tax_inclusive).toBe(true);
    expect(translated.data.recurring_pre_tax_amount).toBe(2900);
  });

  test("accepts the customer as a bare id or as an expanded object", () => {
    const bare = onlyEvent(
      translateStripeEvent(
        makeEvent(
          "customer.subscription.created",
          makeSubscription({ customer: "cus_bare" }),
        ),
      ),
    );
    const expanded = onlyEvent(
      translateStripeEvent(
        makeEvent(
          "customer.subscription.created",
          makeSubscription({
            customer: { id: "cus_expanded", object: "customer" },
          }),
        ),
      ),
    );

    expect(bare.data.customer).toEqual({
      customer_id: "cus_bare",
      email: undefined,
    });
    expect(expanded.data.customer).toEqual({
      customer_id: "cus_expanded",
      email: undefined,
    });
  });

  test("passes the caller's looked-up email through", () => {
    const event = makeEvent(
      "customer.subscription.created",
      makeSubscription(),
    );

    const translated = onlyEvent(
      translateStripeEvent(event, { customerEmail: "buyer@example.com" }),
    );

    expect(translated.data.customer).toEqual({
      customer_id: "cus_translate",
      email: "buyer@example.com",
    });
  });

  test("emits the cancellation timestamp as an ISO string, and null-safely", () => {
    const cancelled = onlyEvent(
      translateStripeEvent(
        makeEvent(
          "customer.subscription.deleted",
          makeSubscription({ canceledAt: CANCELLED_AT_SECONDS }),
        ),
      ),
    );
    const live = onlyEvent(
      translateStripeEvent(
        makeEvent("customer.subscription.created", makeSubscription()),
      ),
    );

    expect(cancelled.data.cancelled_at).toBe("2026-07-20T12:00:00.000Z");
    expect(live.data.cancelled_at).toBeUndefined();
  });

  test("reports the first discount, or null when there is none", () => {
    const discounted = onlyEvent(
      translateStripeEvent(
        makeEvent(
          "customer.subscription.created",
          makeSubscription({ discounts: [{ id: "di_translate" }] }),
        ),
      ),
    );
    const plain = onlyEvent(
      translateStripeEvent(
        makeEvent("customer.subscription.created", makeSubscription()),
      ),
    );

    expect(discounted.data.discount_id).toBe("di_translate");
    expect(plain.data.discount_id).toBeNull();
  });

  test("defaults absent metadata to an empty object", () => {
    const event = makeEvent(
      "customer.subscription.created",
      makeSubscription({ metadata: null }),
    );

    expect(onlyEvent(translateStripeEvent(event)).data.metadata).toEqual({});
  });

  test("survives a subscription with no items", () => {
    const event = makeEvent(
      "customer.subscription.created",
      makeSubscription({ items: { object: "list", data: [] } }),
    );

    const translated = onlyEvent(translateStripeEvent(event));

    expect(translated.data.product_id).toBe("");
    expect(translated.data.previous_billing_date).toBeUndefined();
    expect(translated.data.next_billing_date).toBeUndefined();
    expect(translated.data.currency).toBeUndefined();
  });
});

describe("translateStripeEvent — plan changes", () => {
  test("reports a different lookup key as a plan change", () => {
    const event = makeEvent(
      "customer.subscription.updated",
      makeSubscription({ lookupKey: "wm_api_monthly" }),
      { items: { data: [{ price: { lookup_key: "wm_pro_monthly" } }] } },
    );

    const translated = onlyEvent(translateStripeEvent(event));

    expect(translated.eventType).toBe("subscription.plan_changed");
    expect(translated.data.product_id).toBe("wm_api_monthly");
    expect(translated.data.status).toBe("active");
  });

  test("does not report a renewal as a plan change", () => {
    const event = makeEvent(
      "customer.subscription.updated",
      makeSubscription({ lookupKey: "wm_pro_monthly" }),
      { items: { data: [{ price: { lookup_key: "wm_pro_monthly" } }] } },
    );

    expect(onlyEvent(translateStripeEvent(event)).eventType).toBe(
      "subscription.active",
    );
  });

  test("does not report a quantity edit as a plan change", () => {
    const event = makeEvent(
      "customer.subscription.updated",
      makeSubscription(),
      { items: { data: [{ quantity: 1 }] } },
    );

    expect(onlyEvent(translateStripeEvent(event)).eventType).toBe(
      "subscription.active",
    );
  });

  test("does not report a plan change on a subscription going on hold", () => {
    const event = makeEvent(
      "customer.subscription.updated",
      makeSubscription({ status: "past_due", lookupKey: "wm_api_monthly" }),
      { items: { data: [{ price: { lookup_key: "wm_pro_monthly" } }] } },
    );

    expect(onlyEvent(translateStripeEvent(event)).eventType).toBe(
      "subscription.on_hold",
    );
  });

  test("does not report a plan change on the first subscription event", () => {
    const event = makeEvent(
      "customer.subscription.created",
      makeSubscription({ lookupKey: "wm_api_monthly" }),
      { items: { data: [{ price: { lookup_key: "wm_pro_monthly" } }] } },
    );

    expect(onlyEvent(translateStripeEvent(event)).eventType).toBe(
      "subscription.active",
    );
  });
});

describe("translateStripeEvent — invoices", () => {
  test("splits a renewal into money received and a new billing period", () => {
    const translation = translateStripeEvent(
      makeEvent("invoice.paid", makeInvoice()),
    );

    expect(translation.kind).toBe("dispatch");
    if (translation.kind !== "dispatch") throw new Error("not a dispatch");
    expect(translation.events.map((e) => e.eventType)).toEqual([
      "payment.succeeded",
      "subscription.renewed",
    ]);
    expect(translation.events[1].data).toMatchObject({
      subscription_id: "sub_translate",
      previous_billing_date: "2026-07-01T00:00:00.000Z",
      next_billing_date: "2026-08-01T00:00:00.000Z",
    });
  });

  test("treats the first invoice of a subscription as payment only", () => {
    const translation = translateStripeEvent(
      makeEvent(
        "invoice.paid",
        makeInvoice({ billingReason: "subscription_create" }),
      ),
    );

    expect(onlyEvent(translation).eventType).toBe("payment.succeeded");
  });

  test("does not emit a renewal when the invoice names no subscription", () => {
    const translation = translateStripeEvent(
      makeEvent("invoice.paid", makeInvoice({ subscription: null })),
    );

    const translated = onlyEvent(translation);
    expect(translated.eventType).toBe("payment.succeeded");
    expect(translated.data.subscription_id).toBeUndefined();
  });

  test("stores the payment intent id, so a later refund can find this row", () => {
    const translation = translateStripeEvent(
      makeEvent("invoice.paid", makeInvoice({ billingReason: "manual" })),
    );

    expect(onlyEvent(translation).data.payment_id).toBe("pi_translate");
  });

  test("falls back to the charge id, then to the invoice id", () => {
    const charged = onlyEvent(
      translateStripeEvent(
        makeEvent(
          "invoice.paid",
          makeInvoice({
            billingReason: "manual",
            payments: {
              object: "list",
              data: [{ payment: { charge: "ch_translate" } }],
            },
          }),
        ),
      ),
    );
    const bare = onlyEvent(
      translateStripeEvent(
        makeEvent(
          "invoice.paid",
          makeInvoice({
            billingReason: "manual",
            payments: { object: "list", data: [] },
          }),
        ),
      ),
    );

    expect(charged.data.payment_id).toBe("ch_translate");
    // `payments` is optional on the Stripe type, so the invoice id is the floor.
    expect(bare.data.payment_id).toBe("in_translate");
  });

  test("prefers the subscription's metadata over the invoice's own", () => {
    const translation = translateStripeEvent(
      makeEvent(
        "invoice.paid",
        makeInvoice({
          billingReason: "manual",
          subscriptionMetadata: { wm_user_id: "user_from_subscription" },
          metadata: { wm_user_id: "user_from_invoice" },
        }),
      ),
    );

    expect(onlyEvent(translation).data.metadata).toEqual({
      wm_user_id: "user_from_subscription",
    });
  });

  test("maps a failed payment to the amount due", () => {
    const translation = translateStripeEvent(
      makeEvent(
        "invoice.payment_failed",
        makeInvoice({ amountPaid: 0, amountDue: 4900 }),
      ),
    );

    const translated = onlyEvent(translation);
    expect(translated.eventType).toBe("payment.failed");
    expect(translated.data.total_amount).toBe(4900);
    expect(translated.data.currency).toBe("USD");
    expect(translated.data.status).toBeUndefined();
  });

  test("marks a 3DS challenge as requiring customer action", () => {
    const translation = translateStripeEvent(
      makeEvent("invoice.payment_action_required", makeInvoice()),
    );

    const translated = onlyEvent(translation);
    expect(translated.eventType).toBe("payment.processing");
    expect(translated.data.status).toBe("requires_customer_action");
  });

  test("carries the invoice's own email when the caller looked none up", () => {
    const translation = translateStripeEvent(
      makeEvent("invoice.payment_failed", makeInvoice()),
    );

    expect(onlyEvent(translation).data.customer).toEqual({
      customer_id: "cus_translate",
      email: "buyer@example.com",
    });
  });
});

describe("translateStripeEvent — refunds and disputes", () => {
  test("keys a refund on the payment intent, not the charge", () => {
    const event = makeEvent("charge.refunded", {
      id: "ch_translate",
      object: "charge",
      payment_intent: "pi_translate",
      amount_refunded: 2900,
      currency: "usd",
      customer: "cus_translate",
      billing_details: { email: "buyer@example.com" },
      metadata: {},
    });

    const translated = onlyEvent(translateStripeEvent(event));

    expect(translated.eventType).toBe("refund.succeeded");
    expect(translated.data).toMatchObject({
      payment_id: "pi_translate",
      total_amount: 2900,
      currency: "USD",
    });
  });

  test("falls back to the charge id when a refund has no payment intent", () => {
    const event = makeEvent("charge.refunded", {
      id: "ch_translate",
      object: "charge",
      payment_intent: null,
      amount_refunded: 2900,
      currency: "usd",
    });

    expect(onlyEvent(translateStripeEvent(event)).data.payment_id).toBe(
      "ch_translate",
    );
  });

  test.each([
    ["charge.dispute.created", "needs_response", "dispute.opened"],
    ["charge.dispute.closed", "won", "dispute.won"],
    ["charge.dispute.closed", "lost", "dispute.lost"],
    ["charge.dispute.closed", "warning_closed", "dispute.closed"],
  ])("maps %s with status %s to %s", (type, status, expected) => {
    const event = makeEvent(type, {
      id: "dp_translate",
      object: "dispute",
      status,
      payment_intent: "pi_translate",
      charge: "ch_translate",
      amount: 2900,
      currency: "usd",
      metadata: {},
    });

    const translated = onlyEvent(translateStripeEvent(event));

    expect(translated.eventType).toBe(expected);
    expect(translated.data.payment_id).toBe("pi_translate");
    expect(translated.data.total_amount).toBe(2900);
  });

  test("keys a dispute on the charge when there is no payment intent", () => {
    const event = makeEvent("charge.dispute.created", {
      id: "dp_translate",
      object: "dispute",
      status: "needs_response",
      charge: "ch_translate",
      amount: 2900,
      currency: "usd",
    });

    expect(onlyEvent(translateStripeEvent(event)).data.payment_id).toBe(
      "ch_translate",
    );
  });
});

describe("translateStripeEvent — everything else", () => {
  test("names the event it ignored, so a newly enabled type shows up in the logs", () => {
    const event = makeEvent("payment_intent.succeeded", { id: "pi_translate" });

    expect(translateStripeEvent(event)).toEqual({
      kind: "ignored",
      reason: "unmapped Stripe event payment_intent.succeeded",
    });
  });
});

describe("stripeEventNeedsCustomer", () => {
  test("asks for the customer only when the event can send mail", () => {
    const created = makeEvent(
      "customer.subscription.created",
      makeSubscription(),
    );

    expect(stripeEventNeedsCustomer(created)).toBe("cus_translate");
  });

  test("reads the id off an expanded customer object", () => {
    const event = makeEvent(
      "customer.subscription.updated",
      makeSubscription({ customer: { id: "cus_expanded", object: "customer" } }),
    );

    expect(stripeEventNeedsCustomer(event)).toBe("cus_expanded");
  });

  test("keeps the fetch off the path for a subscription going on hold", () => {
    const event = makeEvent(
      "customer.subscription.updated",
      makeSubscription({ status: "past_due" }),
    );

    expect(stripeEventNeedsCustomer(event)).toBeNull();
  });

  test("keeps the fetch off the path for invoices and disputes", () => {
    expect(
      stripeEventNeedsCustomer(makeEvent("invoice.paid", makeInvoice())),
    ).toBeNull();
    expect(
      stripeEventNeedsCustomer(
        makeEvent("customer.subscription.deleted", makeSubscription()),
      ),
    ).toBeNull();
  });
});
