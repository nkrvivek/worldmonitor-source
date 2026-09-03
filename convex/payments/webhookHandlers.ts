import Stripe from "stripe";
import { httpAction, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { requireEnv } from "../lib/env";
import { createStripeClient } from "../lib/stripe";
import {
  stripeEventNeedsCustomer,
  translateStripeEvent,
} from "./stripeWebhookEvents";

/** Same window Stripe's own SDK defaults to. */
const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/**
 * Dead-letter key for a body that verified but did not parse. Stripe signs a
 * new timestamp on every retry, so a delivery we cannot parse has no stable
 * id to key an incident on. Retries of the same garbage therefore collapse
 * onto one row and raise its attempt count, which is what we want from an
 * incident marker.
 */
const UNPARSEABLE_WEBHOOK_ID = "stripe:unparseable-payload";

/** Same idea for a body that parsed but is not shaped like a Stripe event. */
const MALFORMED_WEBHOOK_ID = "stripe:malformed-event";

/**
 * Pulls the `t=` element out of a `stripe-signature` header for the failure
 * report. A signature failure that is really a clock problem looks like any
 * other one until you can see the timestamp Stripe signed, so it is worth
 * carrying even though nothing else reads it. Returns undefined rather than
 * guessing when the header is not in the documented shape.
 */
function timestampFromSignatureHeader(header: string): string | undefined {
  for (const element of header.split(",")) {
    const [key, value] = element.trim().split("=");
    if (key === "t" && value) return value;
  }
  return undefined;
}

/**
 * Surfaces a webhook signature failure to Convex auto-Sentry by throwing a
 * structured error. Called via `ctx.scheduler.runAfter(0,...)` from the
 * signature-failure catch path so:
 *   - the HTTP response (401) is sent immediately, unaffected
 *   - the scheduled throw runs after the response and is captured by
 *     Convex's automatic Sentry integration
 *   - no SDK install is required in the Convex backend
 *
 * Why `internalMutation` and not `internalAction`: Convex auto-retries
 * failed actions per its scheduler retry policy, which would produce N
 * duplicate Sentry events per signature failure during outages.
 * Mutations are NOT auto-retried — exactly one Sentry event per failed
 * signature check. Don't "simplify" this to an action.
 *
 * Without this, a botched secret rotation could 401 every Stripe webhook
 * silently for hours — same observability gap shape as the canary OCC
 * bug (WORLDMONITOR-PA), just on a different surface.
 */
export const reportWebhookSignatureFailure = internalMutation({
  args: {
    webhookId: v.optional(v.string()),
    webhookTimestamp: v.optional(v.string()),
    errorMessage: v.string(),
  },
  handler: async (_ctx, { webhookId, webhookTimestamp, errorMessage }) => {
    throw new Error(
      `[webhook] Stripe signature verification failed (webhookId=${webhookId ?? "<missing>"}, ts=${webhookTimestamp ?? "<missing>"}): ${errorMessage}`,
    );
  },
});

/**
 * Stripe webhook HTTP action.
 *
 * Stripe names an event after the object that changed; we name ours after the
 * lifecycle state the account lands in. `payments/stripeWebhookEvents.ts` does
 * that translation and nothing else, so this file keeps only the parts that
 * need IO: verify, fetch the one customer record we sometimes need, dispatch,
 * and record failures.
 *
 * Two properties of the translation shape this handler:
 *   - one Stripe delivery can become two internal events (a renewal invoice is
 *     both a payment and a renewal), so dispatch is a loop, and each element
 *     gets its own idempotency key `${event.id}#${eventType}`. A partial
 *     failure then retries only the half that failed.
 *   - some Stripe events map to nothing we track. Those return 200 without a
 *     database write — an unmapped event is not a failure.
 *
 * `constructEventAsync` verifies the signature and parses the body in one
 * call. A signature failure is a credentials failure (401); anything else it
 * throws is an authenticated body we could not read, which is a provider-side
 * defect (dead-letter + 500). Telling them apart is what keeps a bad payload
 * from being reported as a bad secret.
 */
export const webhookHandler = httpAction(async (ctx, request) => {
  // 1. Read the webhook secret and the single Stripe signature header.
  const webhookSecret = requireEnv("STRIPE_WEBHOOK_SECRET");
  const signatureHeader = request.headers.get("stripe-signature");

  if (!signatureHeader) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  // 2. Raw body — signature verification needs the bytes as sent.
  const body = await request.text();

  // Verification itself does not use the API key, but the customer lookup in
  // step 5 does, and a deployment without STRIPE_SECRET_KEY cannot serve
  // checkout either. Constructing here makes that misconfiguration fail loudly
  // on the first delivery instead of silently dropping welcome mail.
  const stripe = createStripeClient(process.env);

  // Shared failure persistence: record the sanitized projection, then queue
  // the production ops signal after the row commits. Both the parse catch
  // (step 3) and the processing catch (step 6) use it; a degraded failure
  // write never changes the provider-facing 500.
  const persistFailureAndSignal = async (failure: {
    webhookId: string;
    eventType: string;
    rawPayload: unknown;
    timestamp: number;
    errorKind: string;
    errorMessage: string;
  }): Promise<void> => {
    try {
      const signal = await ctx.runMutation(
        internal.payments.webhookMutations.recordWebhookFailure,
        {
          webhookId: failure.webhookId,
          eventType: failure.eventType,
          rawPayload: failure.rawPayload,
          timestamp: failure.timestamp,
          receivedAt: Date.now(),
          errorKind: failure.errorKind,
          errorMessage: failure.errorMessage,
        },
      );

      // `convex-test` cannot safely await a scheduler write started by an HTTP
      // action, so keep this test-only guard aligned with the existing Redis
      // scheduler guards in subscriptionHelpers.ts. Production attempts to
      // queue the structured auto-Sentry signal after the failure row commits;
      // a scheduler failure is logged and does not alter the provider-facing
      // retry response.
      if (process.env.NODE_ENV !== "test") {
        // sentry-coverage-ok: the scheduled mutation emits a structured
        // console.error after the failure row commits, so Convex auto-Sentry
        // receives an ops signal without changing the provider-facing 500.
        try {
          await ctx.scheduler.runAfter(
            0,
            internal.payments.webhookMutations.reportWebhookFailure,
            {
              webhookId: failure.webhookId,
              eventType: failure.eventType,
              errorKind: signal.errorKind,
              errorMessage: signal.errorMessage,
              attemptCount: signal.attemptCount,
              unresolvedCount: signal.unresolvedCount,
              eventTypes: signal.eventTypes,
            },
          );
        } catch (scheduleErr) {
          // sentry-coverage-ok: the caller's own console.error still reaches
          // Convex auto-Sentry; a scheduler hiccup is best-effort and must
          // not change the provider-facing 500.
          console.error("[webhook] reportWebhookFailure schedule failed:", scheduleErr);
        }
      }
    } catch (recordErr) {
      // sentry-coverage-ok: the caller's own console.error still reaches
      // Convex auto-Sentry. The retry contract is more important than the
      // observability bonus — keep returning 500 if the failure write is
      // degraded.
      console.error("[webhook] Failed to persist Stripe webhook failure:", recordErr);
    }
  };

  // 3. Verify and parse. 401 is reserved for credentials that do not verify;
  //    an authenticated body we cannot read dead-letters and returns 500 so
  //    the retry exhausts into a repairable incident instead of a mislabeled
  //    401. Stripe tags its own errors on `.type`, which survives any client
  //    seam a test puts in front of the SDK.
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signatureHeader,
      webhookSecret,
      WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isSignatureFailure =
      (error as { type?: string } | null)?.type ===
      "StripeSignatureVerificationError";

    if (!isSignatureFailure) {
      await persistFailureAndSignal({
        webhookId: UNPARSEABLE_WEBHOOK_ID,
        eventType: "unknown",
        // Never the raw body text: only the parsed structure's identifiers and
        // shape keys are extracted downstream, and an unreadable body has
        // neither.
        rawPayload: null,
        timestamp: Date.now(),
        errorKind:
          error instanceof Error && error.name
            ? error.name
            : "WebhookPayloadValidationError",
        errorMessage,
      });
      // sentry-coverage-ok: failure details are persisted above and the
      // scheduled report mutation provides the structured Sentry signal.
      console.error("Webhook payload validation failed:", error);
      return new Response("Invalid webhook payload", { status: 500 });
    }

    // sentry-coverage-ok: the scheduled mutation below throws a
    // structured error that Convex auto-Sentry captures. Required because
    // we MUST 401 (not 500) to Stripe here — re-throwing would trigger a
    // retry-storm. See scripts/check-sentry-coverage.mjs for the marker.
    console.error("Webhook signature verification failed:", error);
    // Surface to Sentry via a scheduled mutation throw — runs AFTER the
    // 401 response so Stripe's contract is preserved.
    //
    // Wrapped in its own try/catch: a scheduler infrastructure hiccup
    // here MUST NOT block the 401 path. Without this guard, a thrown
    // `runAfter` would surface as an uncaught 500 to Stripe, triggering
    // exactly the retry-storm this whole pattern exists to prevent.
    try {
      await ctx.scheduler.runAfter(
        0,
        internal.payments.webhookHandlers.reportWebhookSignatureFailure,
        {
          webhookId: undefined,
          webhookTimestamp: timestampFromSignatureHeader(signatureHeader),
          errorMessage,
        },
      );
    } catch (scheduleErr) {
      // Best-effort — log and continue. The 401 below is the
      // contract-critical path; Sentry capture is the bonus.
      console.error(
        "[webhook] reportWebhookSignatureFailure schedule failed:",
        scheduleErr,
      );
    }
    return new Response("Invalid webhook signature", { status: 401 });
  }

  // 4. A signed body still has to look like an event. The SDK parses JSON but
  //    validates nothing, so a signed request from a misconfigured relay would
  //    otherwise arrive as an event with no type and be quietly ignored.
  const eventId = typeof event?.id === "string" && event.id ? event.id : null;
  const eventName = typeof event?.type === "string" ? event.type : null;
  const eventObject = (event?.data as { object?: unknown } | undefined)?.object;
  if (!eventId || !eventName || typeof eventObject !== "object" || !eventObject) {
    await persistFailureAndSignal({
      webhookId: eventId ?? MALFORMED_WEBHOOK_ID,
      eventType: eventName ?? "unknown",
      rawPayload: event ?? null,
      timestamp: Date.now(),
      errorKind: "WebhookPayloadValidationError",
      errorMessage: "Stripe event is missing id, type, or data.object",
    });
    // sentry-coverage-ok: failure details are persisted above and the
    // scheduled report mutation provides the structured Sentry signal.
    console.error("Webhook payload validation failed: event shape is not usable");
    return new Response("Invalid webhook payload", { status: 500 });
  }

  // Stripe stamps `created` in unix seconds.
  const eventTimestamp = event.created * 1000;

  // 5. Welcome and reactivation mail needs an address, and a subscription
  //    object carries only the customer id. One conditional read, and a
  //    failure here costs an email rather than the delivery — the entitlement
  //    write below does not depend on it.
  let customerEmail: string | undefined;
  const customerIdNeedingEmail = stripeEventNeedsCustomer(event);
  if (customerIdNeedingEmail) {
    try {
      const customer = await stripe.customers.retrieve(customerIdNeedingEmail);
      if (!("deleted" in customer)) {
        customerEmail = customer.email ?? undefined;
      }
    } catch (error) {
      console.warn(
        `[webhook] could not read Stripe customer ${customerIdNeedingEmail} — ` +
          `processing ${event.type} without an email address:`,
        error,
      );
    }
  }

  const translation = translateStripeEvent(event, { customerEmail });
  if (translation.kind === "ignored") {
    console.log(`[webhook] ${translation.reason} (event ${event.id})`);
    return new Response(null, { status: 200 });
  }

  // 6. Dispatch each translated event under its own idempotency key. On
  //    handler failure the mutation throws, rolling back partial writes; we
  //    record a sanitized failure projection before returning 500 so Stripe
  //    retries without losing the repair context.
  const dispatches = translation.events.map((translated) => ({
    webhookId: `${event.id}#${translated.eventType}`,
    eventType: translated.eventType,
    rawPayload: {
      type: translated.eventType,
      timestamp: new Date(eventTimestamp).toISOString(),
      data: translated.data,
      provider: "stripe",
      provider_event_id: event.id,
      provider_event_type: event.type,
    },
  }));

  for (const dispatch of dispatches) {
    try {
      await ctx.runMutation(
        internal.payments.webhookMutations.processWebhookEvent,
        {
          webhookId: dispatch.webhookId,
          eventType: dispatch.eventType,
          rawPayload: dispatch.rawPayload,
          timestamp: eventTimestamp,
        },
      );
    } catch (error) {
      const errorKind =
        error instanceof Error && error.name
          ? error.name
          : "WebhookProcessingError";

      await persistFailureAndSignal({
        webhookId: dispatch.webhookId,
        eventType: dispatch.eventType,
        rawPayload: dispatch.rawPayload,
        timestamp: eventTimestamp,
        errorKind,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      // sentry-coverage-ok: failure details are persisted above and the
      // scheduled report mutation provides the structured Sentry signal.
      console.error("Webhook processing failed:", error);
      return new Response("Internal processing error", { status: 500 });
    }
  }

  // 7. Recovery is deliberately outside the processing-failure catch. If this
  // bookkeeping mutation is transiently unavailable, the provider should
  // retry the delivery, but that recovery error must not be recorded as a
  // new processing incident after billing state already committed.
  try {
    for (const dispatch of dispatches) {
      await ctx.runMutation(
        internal.payments.webhookMutations.markWebhookFailureRecovered,
        { webhookId: dispatch.webhookId },
      );
    }
  } catch (error) {
    console.error("[webhook] Failed to mark Stripe webhook failure recovered:", error);
    return new Response("Internal processing error", { status: 500 });
  }

  // 8. Return 200 on success (synchronous processing complete)
  return new Response(null, { status: 200 });
});
