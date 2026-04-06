---
description: Build a production-grade Razorpay webhook handler — signature verification, idempotency, 12+ event types, race condition handling. Use when the user asks to "handle webhooks", "build a webhook handler", "process payment events", "verify webhook signatures", or needs to react to Razorpay subscription and payment lifecycle events.
argument-hint: "[subscriptions|payments|all]"
---

# Razorpay Webhook Handler

Build a webhook handler that survives production chaos: duplicate events, race conditions, out-of-order delivery, and partial failures.


## Critical Rules

1. **Always return 200** for events you don't handle — Razorpay retries on non-2xx
2. **Verify signature FIRST** before any processing
3. **Idempotency is mandatory** — Razorpay uses at-least-once delivery
4. **Never trust event order** — `subscription.charged` may arrive before `subscription.activated`

## Signature Verification

```typescript
import crypto from "crypto";

function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // MUST use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false; // Length mismatch = invalid
  }
}
```

## Full Webhook Route

```typescript
// app/api/billing/webhook/route.ts
import crypto from "crypto";

export async function POST(request: Request) {
  // 1. Read raw body (NOT parsed JSON — signature is computed on raw string)
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature");

  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  // 2. Verify signature
  const isValid = verifyWebhookSignature(
    rawBody,
    signature,
    process.env.RAZORPAY_WEBHOOK_SECRET!
  );

  if (!isValid) {
    return new Response("Invalid signature", { status: 400 });
  }

  // 3. Parse event
  const event = JSON.parse(rawBody);
  const eventType = event.event;

  // 4. Extract event ID (prefer header over payload)
  const eventId = request.headers.get("x-razorpay-event-id") || event.id || null;

  // 5. Extract subscription ID (multi-path — different event types store it differently)
  const subscriptionId = extractSubscriptionId(event);
  if (!subscriptionId) {
    // Non-subscription event (standalone payment, order, etc.) — acknowledge and skip
    return new Response("OK", { status: 200 });
  }

  // 6. Idempotency check (multi-layer)
  const subscription = await getSubscriptionByRazorpayId(subscriptionId);

  // Layer 1: Exact event ID match (same event delivered twice)
  if (subscription?.lastEventId === eventId && eventId) {
    return new Response("Already processed", { status: 200 });
  }

  // Layer 2: Check processed_events table for this event ID
  // Razorpay can send the same logical event with different event IDs on retry
  if (eventId) {
    const alreadyProcessed = await db
      .select()
      .from(processedWebhookEvents)
      .where(eq(processedWebhookEvents.eventId, eventId))
      .limit(1);
    if (alreadyProcessed.length > 0) {
      return new Response("Already processed", { status: 200 });
    }
  }

  // 7. Handle event
  try {
    await handleEvent(eventType, event, subscription, eventId);

    // Record processed event for idempotency
    if (eventId) {
      await db.insert(processedWebhookEvents).values({
        eventId,
        eventType,
        subscriptionId,
        processedAt: new Date(),
      }).onConflictDoNothing();  // Safe if duplicate insert races
    }
  } catch (error) {
    console.error("Webhook processing error:", error);
    // Still return 200 to prevent retries on app errors
    // Log for manual investigation
  }

  return new Response("OK", { status: 200 });
}

// Subscription ID lives in different places depending on event type
function extractSubscriptionId(event: any): string | null {
  return (
    event.payload?.subscription?.entity?.id ||
    event.payload?.payment?.entity?.subscription_id ||
    event.payload?.invoice?.entity?.subscription_id ||
    null
  );
}
```

## Event Handler

```typescript
async function handleEvent(
  eventType: string,
  event: any,
  subscription: Subscription | null,
  eventId: string | null
) {
  const entity = event.payload?.subscription?.entity;
  const payment = event.payload?.payment?.entity;

  switch (eventType) {
    // ── AUTHENTICATED: Card authorized, NOT payment confirmed ──
    case "subscription.authenticated": {
      // DO NOT grant access here! This only means the card was authorized.
      // The user's card is verified but NO money has been charged yet.
      // Wait for subscription.activated to confirm actual payment.
      if (!subscription) {
        // Auto-create DB record from webhook if it doesn't exist yet
        if (entity?.notes?.userId && entity?.notes?.planKey) {
          await createSubscriptionRecord({
            userId: entity.notes.userId,
            planKey: entity.notes.planKey,
            razorpaySubscriptionId: entity.id,
            razorpayPlanId: entity.plan_id,
            status: "authenticated",  // NOT "active"
          });
        }
      } else {
        await updateSubscriptionStatus(subscription, "authenticated", entity, eventId);
      }
      break;
    }

    // ── ACTIVATED: Payment confirmed — THIS is where you grant access ──
    case "subscription.activated": {
      // THIS is the real event. Money has been charged. Grant access NOW.
      await activateSubscription(subscription, entity, eventId);
      if (payment) {
        await createGstInvoice(payment, subscription); // Non-blocking — calls Razorpay Invoice API
      }
      break;
    }

    // ── Renewal ────────────────────────────────────────────
    case "subscription.charged": {
      // This is a renewal payment — mark active, create GST invoice
      await updateSubscriptionStatus(subscription, "active", entity, eventId);
      if (payment) await createGstInvoice(payment, subscription);
      break;
    }

    // ── Pending (careful — don't downgrade from active) ───
    case "subscription.pending": {
      if (subscription?.status === "active") {
        // Already active — don't downgrade to pending
        return;
      }
      await updateSubscriptionStatus(subscription, "pending", entity, eventId);
      break;
    }

    // ── Pause / Resume ─────────────────────────────────────
    case "subscription.paused": {
      await updateSubscriptionStatus(subscription, "paused", entity, eventId);
      await revokeAccessIfNoOtherSubs(subscription);
      break;
    }
    case "subscription.resumed": {
      await updateSubscriptionStatus(subscription, "active", entity, eventId);
      await grantAccess(subscription);
      break;
    }

    // ── Cancellation / Completion / Halt ───────────────────
    case "subscription.cancelled":
    case "subscription.completed":
    case "subscription.halted": {
      const status = eventType.split(".")[1]; // "cancelled" | "completed" | "halted"
      await updateSubscriptionStatus(subscription, status, entity, eventId);
      await revokeAccessIfNoOtherSubs(subscription);
      break;
    }

    // ── Plan Change Detection ──────────────────────────────
    case "subscription.updated": {
      if (entity?.plan_id) {
        const newPlanKey = planKeyFor(entity.plan_id);
        if (newPlanKey && subscription) {
          await updateSubscriptionPlan(subscription, newPlanKey, entity.plan_id);
        }
      }
      break;
    }

    // ── Payment Failures ───────────────────────────────────
    case "payment.failed": {
      if (subscription) {
        await updateSubscriptionStatus(subscription, "halted", entity, eventId);
        // Only revoke if this is a renewal failure (not initial payment)
        if (subscription.status === "active") {
          await revokeAccessIfNoOtherSubs(subscription);
        }
      }
      break;
    }

    // ── Fallback Authorization ─────────────────────────────
    case "payment.authorized": {
      // Late authorization — activate if still in authenticated state
      if (subscription?.status === "authenticated") {
        await activateSubscription(subscription, entity, eventId);
      }
      break;
    }

    default:
      // Unknown event — acknowledge, don't process
      break;
  }
}
```

## Optimistic Locking Pattern

Prevent race conditions when two webhook events arrive simultaneously:

```typescript
async function updateSubscriptionStatus(
  subscription: Subscription | null,
  newStatus: string,
  entity: any,
  eventId: string | null
) {
  if (!subscription) return;

  // Extract current period end (Razorpay uses different field names)
  const periodEnd = entity?.current_period_end || entity?.current_end || entity?.end_at;
  const currentPeriodEnd = periodEnd ? new Date(periodEnd * 1000) : null;

  // Optimistic lock: only update if lastEventId matches what we read
  const updated = await db
    .update(subscriptions)
    .set({
      status: newStatus,
      currentPeriodEnd,
      lastEventId: eventId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(subscriptions.id, subscription.id),
        // Optimistic lock — fails if another webhook updated first
        subscription.lastEventId
          ? eq(subscriptions.lastEventId, subscription.lastEventId)
          : isNull(subscriptions.lastEventId)
      )
    );

  if (!updated.rowCount) {
    // Optimistic lock failed — re-read and check
    const fresh = await getSubscriptionByRazorpayId(subscription.razorpaySubscriptionId);
    if (fresh?.lastEventId === eventId) {
      return; // Already processed by the other webhook — safe to skip
    }
    // Different event won the race — retry without optimistic lock
    // (This event is newer, so it should win)
    await db
      .update(subscriptions)
      .set({ status: newStatus, currentPeriodEnd, lastEventId: eventId, updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));
  }
}
```

## Access Revocation Guard

When cancelling/pausing, check if user has OTHER active subscriptions:

```typescript
async function revokeAccessIfNoOtherSubs(subscription: Subscription | null) {
  if (!subscription) return;
  const hasOther = await hasActiveSubscription(subscription.userId);
  if (!hasOther) {
    await revokeAccess(subscription.userId);
  }
}
```

Why: Users can have multiple subscriptions (e.g., day pass + monthly). Only revoke when ALL are inactive.

## Auto-Create from Webhook (Plan Changes)

When a plan change webhook arrives but the new subscription isn't in the DB yet:

```typescript
// Inside subscription.activated handler
if (!subscription && entity?.notes?.userId && entity?.notes?.planKey) {
  // Webhook-driven plan change — auto-create DB row
  subscription = await createSubscriptionRecord({
    userId: entity.notes.userId,
    planKey: entity.notes.planKey,
    razorpaySubscriptionId: entity.id,
    razorpayPlanId: entity.plan_id,
    status: "active",
  });

  // Cancel old subscription if noted
  if (entity.notes.replacesSubscription) {
    try {
      await razorpay.subscriptions.cancel(entity.notes.replacesSubscription, true);
    } catch { /* Best-effort */ }
    await markSubscriptionCancelled(entity.notes.replacesSubscription);
  }
}
```

## GST Invoice Creation (Non-Blocking)

Razorpay subscription payments do NOT auto-generate GST invoices. You must create them yourself
via the Razorpay Invoice API with proper line items (base amount, CGST, SGST as separate items).

```typescript
async function createGstInvoice(payment: any, subscription: any) {
  try {
    const amountPaise = payment.amount;
    const basePaise = Math.round(amountPaise / 1.18);
    const gstPaise = amountPaise - basePaise;
    const cgstPaise = Math.floor(gstPaise / 2);
    const sgstPaise = gstPaise - cgstPaise;

    // Create invoice via Razorpay Invoice API — subscriptions don't auto-generate GST invoices
    const invoice = await razorpay.invoices.create({
      type: "invoice",
      customer_id: subscription?.razorpayCustomerId,
      line_items: [
        {
          name: "Subscription - Base Amount",
          amount: basePaise,
          currency: "INR",
          quantity: 1,
        },
        {
          name: "CGST @ 9%",
          amount: cgstPaise,
          currency: "INR",
          quantity: 1,
        },
        {
          name: "SGST @ 9%",
          amount: sgstPaise,
          currency: "INR",
          quantity: 1,
        },
      ],
      notes: {
        paymentId: payment.id,
        subscriptionId: payment.subscription_id,
        sacCode: "998314",
      },
    });

    // Store in DB with Razorpay invoice ID
    await db.insert(gstInvoices).values({
      userId: payment.notes?.userId,
      razorpayInvoiceId: invoice.id,
      razorpayPaymentId: payment.id,
      razorpaySubscriptionId: payment.subscription_id,
      amountPaise,
      basePaise,
      cgstPaise,
      sgstPaise,
    });
  } catch (error) {
    // Log but don't block — charge already succeeded
    console.error("GST invoice creation failed:", error);
  }
}
```

## Events Reference

| Event | When | Action |
|-------|------|--------|
| `subscription.authenticated` | Card authorized, NO payment yet | Save to DB as "authenticated" — **DO NOT grant access** |
| `subscription.activated` | **First payment confirmed** | **Grant access NOW** + create GST invoice |
| `subscription.charged` | Recurring payment succeeds | Mark active (renewal) + GST |
| `subscription.pending` | Payment attempt pending | Update status (don't downgrade from active) |
| `subscription.paused` | Admin pauses | Mark paused, maybe revoke access |
| `subscription.resumed` | Admin resumes | Mark active, restore access |
| `subscription.cancelled` | User/admin cancels | Mark cancelled, maybe revoke |
| `subscription.completed` | All cycles done | Mark completed, maybe revoke |
| `subscription.halted` | Payment failed repeatedly | Mark halted, maybe revoke |
| `subscription.updated` | Plan changed | Detect new plan_id |
| `payment.failed` | Payment attempt fails | Mark halted if renewal |
| `payment.authorized` | Late authorization | Fallback activation |

## Gotchas

1. **`subscription.authenticated` ≠ `subscription.activated`**: This is the #1 mistake. `authenticated` means the card was verified — NO money charged. `activated` means first payment succeeded. **Only grant access on `activated`**. If you grant on `authenticated`, users get free access when their payment fails.
2. **Read raw body, not JSON**: Signature is computed on the raw string. Use `request.text()`, not `request.json()`.
3. **Always return 200**: Even for events you don't handle. Non-2xx triggers retries.
4. **Event ID sources**: Prefer `x-razorpay-event-id` header over `event.id` in payload.
5. **`current_period_end` field names**: Try `current_period_end`, then `current_end`, then `end_at`. All are Unix seconds.
6. **Don't downgrade from active**: `subscription.pending` may arrive after `subscription.activated`. Check current status before updating.
7. **At-least-once delivery**: The same event may be delivered multiple times. Use both `lastEventId` on the subscription AND a `processed_webhook_events` table for belt-and-suspenders idempotency.
8. **Race conditions are real**: Two events for the same subscription can arrive within milliseconds. Use optimistic locking.
9. **Subscription ID location varies**: Different event types put it in different places. Check all three paths.
10. **Idempotency must survive retries**: Razorpay can resend with a different event ID. Your `processedWebhookEvents` table catches this. Without it, the same charge can grant access twice or create duplicate invoices.
