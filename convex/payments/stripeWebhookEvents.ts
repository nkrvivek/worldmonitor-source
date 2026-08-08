/**
 * Stripe event -> the internal webhook vocabulary this codebase already speaks.
 *
 * WHY A TRANSLATOR AND NOT A REWRITE. Everything downstream of
 * payments/webhookMutations.ts:processWebhookEvent — the handlers in
 * subscriptionHelpers.ts, the `active`/`on_hold`/`cancelled`/`expired`
 * subscription words, the `processing`/`requires_customer_action` payment
 * words, the stored `rawPayload` on every historical row — is written in one
 * vocabulary. Stripe speaks another. Translating at the edge keeps one
 * vocabulary in the database, keeps old rows readable next to new ones, and
 * leaves the handlers' tests meaningful. The provider seam is this file.
 *
 * TWO NAMING SYSTEMS, ONE DIRECTION. Stripe names an event after what
 * happened to the object (`customer.subscription.updated`); we name it after
 * the lifecycle state it puts the account in (`subscription.on_hold`). So the
 * dispatch decision is made on the subscription's `status`, not on the event
 * name — `customer.subscription.updated` becomes any of four internal events
 * depending on the status it carries.
 *
 * ONE DELIVERY CAN BE TWO EVENTS. A renewal is one `invoice.paid` from Stripe
 * but two facts for us: money arrived, and the billing period moved. So the
 * return type is a list, and the caller dispatches each element under its own
 * webhook id.
 *
 * PURE ON PURPOSE. No database, no network, no clock. The one thing this file
 * cannot do — read the buyer's email address, which Stripe sends as a bare
 * customer id — is exposed as `stripeEventNeedsCustomer` so the HTTP action
 * can fetch it and pass it back in. Keeping the fetch out here is what lets
 * every mapping below be tested against a literal payload.
 *
 * TIMESTAMPS. Stripe counts unix SECONDS. Every date this file emits is an
 * ISO string, because toEpochMs in subscriptionHelpers.ts passes a raw number
 * through unchanged and would read 1767225600 as 1970.
 *
 * PRODUCT IDS ARE LOOKUP KEYS. `product_id` carries the Stripe price's
 * `lookup_key`, matching CatalogEntry.providerPriceId — price ids differ
 * between test and live mode, lookup keys do not. resolvePlanKey reads that
 * field to find the plan.
 */

import type Stripe from "stripe";

/** One internal event, shaped the way processWebhookEvent consumes it. */
export interface TranslatedWebhookEvent {
  eventType: string;
  data: Record<string, unknown>;
}

export type StripeEventTranslation =
  | { kind: "dispatch"; events: TranslatedWebhookEvent[] }
  | { kind: "ignored"; reason: string };

export interface TranslateStripeEventOptions {
  /**
   * Email of the Stripe customer on this event, when the caller looked it up.
   * handleSubscriptionActive sends the welcome mail to it; every other path
   * treats it as optional.
   */
  customerEmail?: string;
}

/**
 * Subscription status -> internal event. `incomplete` is deliberately absent:
 * the first payment has not landed yet, so there is nothing to grant and
 * nothing to revoke. Anything else unknown is reported as ignored rather than
 * guessed at.
 */
const SUBSCRIPTION_EVENT_BY_STATUS: Readonly<Record<string, string>> = {
  active: "subscription.active",
  trialing: "subscription.active",
  past_due: "subscription.on_hold",
  unpaid: "subscription.on_hold",
  paused: "subscription.on_hold",
  canceled: "subscription.cancelled",
  incomplete_expired: "subscription.expired",
};

/** `subscription.on_hold` -> `on_hold`, the word handleSubscriptionUpdated reads. */
function statusWordOf(internalEventType: string): string {
  return internalEventType.slice("subscription.".length);
}

/** Stripe sends a reference as either a bare id or the expanded object. */
function idOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/** Unix seconds -> ISO string. See the TIMESTAMPS note in the module header. */
function isoFromUnixSeconds(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** Stripe lowercases currency codes; the rest of this codebase stores "USD". */
function upperCurrency(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.toUpperCase()
    : undefined;
}

function metadataOf(value: unknown): Record<string, string> {
  return (value as Record<string, string> | null) ?? {};
}

function lookupKeyOfPrice(price: Stripe.Price | null | undefined): string {
  return price?.lookup_key ?? price?.id ?? "";
}

function firstItemOf(
  subscription: Stripe.Subscription,
): Stripe.SubscriptionItem | undefined {
  return subscription.items?.data?.[0];
}

/**
 * Translate a Stripe subscription into the payload shape
 * subscriptionHelpers.ts reads (DodoSubscriptionData).
 *
 * Billing periods live on the subscription ITEM in this API version
 * (2026-07-29.dahlia) — there are no top-level period fields on the
 * subscription. Reading them off the subscription silently yields undefined,
 * which handleSubscriptionRenewed would then store as "no next billing date".
 */
function subscriptionPayload(
  subscription: Stripe.Subscription,
  statusWord: string,
  customerEmail?: string,
): Record<string, unknown> {
  const item = firstItemOf(subscription);
  const price = item?.price;
  return {
    subscription_id: subscription.id,
    product_id: lookupKeyOfPrice(price),
    status: statusWord,
    customer: {
      customer_id: idOf(subscription.customer),
      email: customerEmail,
    },
    previous_billing_date: isoFromUnixSeconds(item?.current_period_start),
    next_billing_date: isoFromUnixSeconds(item?.current_period_end),
    cancelled_at: isoFromUnixSeconds(subscription.canceled_at),
    // The identity bridge checkout.ts writes into subscription_data.metadata
    // (wm_user_id, wm_user_id_sig, wm_plan_key, affonso_referral) arrives here.
    metadata: metadataOf(subscription.metadata),
    recurring_pre_tax_amount: price?.unit_amount ?? undefined,
    currency: upperCurrency(price?.currency),
    tax_inclusive: price?.tax_behavior === "inclusive",
    discount_id: idOf(subscription.discounts?.[0]) ?? null,
  };
}

/**
 * True when `previous_attributes` proves the price changed. Stripe includes
 * `items` in previous_attributes for quantity edits and ordinary renewals too,
 * so requiring a readable and DIFFERENT lookup key is what keeps a renewal
 * from being reported as a plan change.
 */
function isPlanChange(
  subscription: Stripe.Subscription,
  previousAttributes: unknown,
): boolean {
  const previousItems = (
    previousAttributes as {
      items?: { data?: Array<{ price?: Stripe.Price | null }> };
    } | null
  )?.items?.data;
  const previousKey = previousItems?.[0]?.price
    ? lookupKeyOfPrice(previousItems[0].price)
    : "";
  if (!previousKey) return false;
  return previousKey !== lookupKeyOfPrice(firstItemOf(subscription)?.price);
}

/** The subscription an invoice belongs to. There is no top-level field for this. */
function subscriptionIdOfInvoice(invoice: Stripe.Invoice): string | undefined {
  return idOf(invoice.parent?.subscription_details?.subscription);
}

/**
 * The id to store as providerPaymentId. Prefer the PaymentIntent, because a
 * later refund or dispute carries that same id and nothing else linking back
 * to this invoice — see the inheritance note in subscriptionHelpers.ts.
 * `invoice.payments` is optional on the type, so the invoice id is the floor.
 */
function paymentIdOfInvoice(invoice: Stripe.Invoice): string {
  const payment = invoice.payments?.data?.[0]?.payment;
  return (
    idOf(payment?.payment_intent) ?? idOf(payment?.charge) ?? invoice.id ?? ""
  );
}

function invoicePaymentPayload(
  invoice: Stripe.Invoice,
  amount: number,
  status?: string,
): Record<string, unknown> {
  return {
    payment_id: paymentIdOfInvoice(invoice),
    status,
    total_amount: amount,
    currency: upperCurrency(invoice.currency),
    subscription_id: subscriptionIdOfInvoice(invoice),
    customer: {
      customer_id: idOf(invoice.customer),
      email: invoice.customer_email ?? undefined,
    },
    // Subscription metadata carries the identity bridge; the invoice's own
    // metadata is usually empty but is the better fallback than nothing.
    metadata:
      invoice.parent?.subscription_details?.metadata ??
      metadataOf(invoice.metadata),
  };
}

/**
 * A renewal payload for handleSubscriptionRenewed. It needs the subscription
 * id and the new period only — not the price — so the period comes off the
 * invoice line rather than requiring a second Stripe call.
 */
function renewalPayload(
  invoice: Stripe.Invoice,
  subscriptionId: string,
  customerEmail?: string,
): Record<string, unknown> {
  const line = invoice.lines?.data?.[0];
  return {
    subscription_id: subscriptionId,
    product_id: "",
    customer: {
      customer_id: idOf(invoice.customer),
      email: customerEmail ?? invoice.customer_email ?? undefined,
    },
    previous_billing_date: isoFromUnixSeconds(line?.period?.start),
    next_billing_date: isoFromUnixSeconds(line?.period?.end),
    metadata:
      invoice.parent?.subscription_details?.metadata ??
      metadataOf(invoice.metadata),
  };
}

function dispatch(
  events: Array<TranslatedWebhookEvent>,
): StripeEventTranslation {
  return { kind: "dispatch", events };
}

/**
 * The customer id whose email this event needs, or null when it needs none.
 * Only the paths that can send a welcome or reactivation mail
 * (handleSubscriptionActive) do; everything else already has what it needs, so
 * this keeps the fetch off the hot path.
 */
export function stripeEventNeedsCustomer(event: Stripe.Event): string | null {
  if (
    event.type !== "customer.subscription.created" &&
    event.type !== "customer.subscription.updated"
  ) {
    return null;
  }
  const subscription = event.data.object as Stripe.Subscription;
  const internalEventType = SUBSCRIPTION_EVENT_BY_STATUS[subscription.status];
  if (internalEventType !== "subscription.active") return null;
  return idOf(subscription.customer) ?? null;
}

/**
 * Map one Stripe event onto zero, one, or two internal events.
 *
 * Anything not listed is ignored with a stated reason rather than dropped
 * silently — the caller logs the reason, so a newly-enabled Stripe event type
 * shows up in the logs instead of vanishing.
 */
export function translateStripeEvent(
  event: Stripe.Event,
  options: TranslateStripeEventOptions = {},
): StripeEventTranslation {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const internalEventType =
        SUBSCRIPTION_EVENT_BY_STATUS[subscription.status];
      if (!internalEventType) {
        return {
          kind: "ignored",
          reason: `subscription status ${subscription.status} has no lifecycle meaning`,
        };
      }
      const planChanged =
        event.type === "customer.subscription.updated" &&
        internalEventType === "subscription.active" &&
        isPlanChange(subscription, event.data.previous_attributes);
      const eventType = planChanged
        ? "subscription.plan_changed"
        : internalEventType;
      return dispatch([
        {
          eventType,
          data: subscriptionPayload(
            subscription,
            statusWordOf(internalEventType),
            options.customerEmail,
          ),
        },
      ]);
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      return dispatch([
        {
          eventType: "subscription.cancelled",
          data: subscriptionPayload(
            subscription,
            "cancelled",
            options.customerEmail,
          ),
        },
      ]);
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const events: TranslatedWebhookEvent[] = [
        {
          eventType: "payment.succeeded",
          data: invoicePaymentPayload(invoice, invoice.amount_paid ?? 0),
        },
      ];
      // A renewal is money AND a new billing period. The first invoice of a
      // subscription arrives as billing_reason "subscription_create" and is
      // NOT a renewal — handleSubscriptionActive already set that period.
      const subscriptionId = subscriptionIdOfInvoice(invoice);
      if (invoice.billing_reason === "subscription_cycle" && subscriptionId) {
        events.push({
          eventType: "subscription.renewed",
          data: renewalPayload(invoice, subscriptionId, options.customerEmail),
        });
      }
      return dispatch(events);
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      return dispatch([
        {
          eventType: "payment.failed",
          data: invoicePaymentPayload(invoice, invoice.amount_due ?? 0),
        },
      ]);
    }

    case "invoice.payment_action_required": {
      // 3DS / SCA. derivePaymentEventStatus reads `status` on this one event
      // type only, and turns it into the requires_customer_action row the
      // duplicate-payment guard looks for.
      const invoice = event.data.object as Stripe.Invoice;
      return dispatch([
        {
          eventType: "payment.processing",
          data: invoicePaymentPayload(
            invoice,
            invoice.amount_due ?? 0,
            "requires_customer_action",
          ),
        },
      ]);
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      return dispatch([
        {
          eventType: "refund.succeeded",
          data: {
            // No Stripe refund, charge, or payment-intent payload carries a
            // subscription id. This is the PaymentIntent id the matching
            // invoice.paid row was stored under, which is what lets
            // subscriptionHelpers inherit the subscription from it.
            payment_id: idOf(charge.payment_intent) ?? charge.id,
            total_amount: charge.amount_refunded,
            currency: upperCurrency(charge.currency),
            customer: {
              customer_id: idOf(charge.customer),
              email: charge.billing_details?.email ?? undefined,
            },
            metadata: metadataOf(charge.metadata),
          },
        },
      ]);
    }

    case "charge.dispute.created":
    case "charge.dispute.closed": {
      const dispute = event.data.object as Stripe.Dispute;
      const eventType =
        event.type === "charge.dispute.created"
          ? "dispute.opened"
          : dispute.status === "won"
            ? "dispute.won"
            : dispute.status === "lost"
              ? "dispute.lost"
              : "dispute.closed";
      return dispatch([
        {
          eventType,
          data: {
            payment_id:
              idOf(dispute.payment_intent) ?? idOf(dispute.charge) ?? dispute.id,
            total_amount: dispute.amount,
            currency: upperCurrency(dispute.currency),
            metadata: metadataOf(dispute.metadata),
          },
        },
      ]);
    }

    default:
      return { kind: "ignored", reason: `unmapped Stripe event ${event.type}` };
  }
}
