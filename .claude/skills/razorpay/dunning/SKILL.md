---
name: dunning
description: Handle failed payments and recover revenue — grace periods, dunning emails, involuntary churn prevention. Use when the user asks about "failed payment handling", "payment recovery", "reduce churn", "dunning emails", "grace period", or needs to recover revenue from declined cards and payment failures.
argument-hint: "[retry|grace-period|email]"
---

# Razorpay Payment Recovery / Dunning

Recover revenue from failed payments without alienating users. This covers grace periods, dunning emails, payment method updates, and automated access revocation.


## Critical Rules

1. **Don't retry payments yourself** — Razorpay auto-retries and custom retries will conflict
2. **Grace period starts from `subscription.halted`**, not from the first `payment.failed`
3. **Multiple `payment.failed` events are normal** — Razorpay sends one per retry attempt, handle idempotently
4. **Track email sends** to prevent spamming users with duplicate dunning emails

## Understanding Razorpay's Built-In Retry

Razorpay handles payment retries automatically:

- Failed subscription payments are retried **3 times over 3 days** by default
- You can configure retry count and interval in Dashboard → Settings → Subscriptions
- After all retries fail, subscription moves to `halted`
- You will receive a `payment.failed` webhook for **each** retry attempt
- When all retries are exhausted, you receive `subscription.halted`

**Do not build custom retry logic on top of this.** Razorpay's retry and a custom retry will fire simultaneously, causing duplicate charges or API errors.

## Database Additions

Add these columns to your subscriptions table:

```typescript
// In your schema (e.g., Drizzle, Prisma, raw SQL)
// subscriptions table additions:
grace_period_end    TIMESTAMP       // When grace period expires (null = no grace period)
dunning_emails_sent VARCHAR[]       // Track which emails were sent, e.g. ["day0", "day3", "day5", "day7"]
```

Drizzle example:

```typescript
import { timestamp, varchar } from "drizzle-orm/pg-core";

// Add to your subscriptions table definition
gracePeriodEnd: timestamp("grace_period_end"),
dunningEmailsSent: varchar("dunning_emails_sent").array().default([]),
```

## Grace Period Pattern

When payment fails, don't revoke access immediately. Grant a grace period so Razorpay can retry and the user has time to update their card.

### Webhook Handler: Set Grace Period on Halt

```typescript
// Inside your webhook event handler (see webhook skill)
case "subscription.halted": {
  // ALL retries failed — start grace period
  const gracePeriodEnd = new Date();
  gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 7); // 7-day grace

  await db
    .update(subscriptions)
    .set({
      status: "halted",
      gracePeriodEnd,
      lastEventId: eventId,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.razorpaySubscriptionId, subscriptionId));

  // Send first dunning email (Day 0 of grace period)
  await sendDunningEmail(subscription, "day0");
  break;
}
```

### Webhook Handler: Clear Grace Period on Successful Payment

```typescript
case "subscription.charged": {
  // Payment succeeded (either retry or user updated card) — clear grace period
  await db
    .update(subscriptions)
    .set({
      status: "active",
      gracePeriodEnd: null,
      dunningEmailsSent: [],  // Reset for next cycle
      lastEventId: eventId,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.razorpaySubscriptionId, subscriptionId));

  if (payment) await createGstInvoice(payment);
  break;
}
```

### Webhook Handler: Idempotent `payment.failed` Handling

```typescript
case "payment.failed": {
  if (!subscription) break;

  // Don't set grace period here — wait for subscription.halted
  // Razorpay sends payment.failed for EACH retry attempt (up to 3)
  // Just log it for debugging
  console.log(
    `Payment failed for subscription ${subscriptionId}`,
    `(attempt ${payment?.error_description || "unknown"})`
  );

  // Optionally update status to reflect pending retry
  // But do NOT revoke access or start grace period yet
  break;
}
```

### Access Check with Grace Period

```typescript
// lib/billing/access.ts
export async function hasActiveAccess(userId: string): Promise<boolean> {
  const sub = await getActiveSubscriptionByUserId(userId);
  if (!sub) return false;

  // Active subscription — full access
  if (sub.status === "active") return true;

  // Halted but within grace period — still allow access
  if (
    sub.status === "halted" &&
    sub.gracePeriodEnd &&
    new Date() < sub.gracePeriodEnd
  ) {
    return true;
  }

  return false;
}
```

### UI: Show Grace Period Warning

```typescript
// components/grace-period-banner.tsx
"use client";

export function GracePeriodBanner({
  gracePeriodEnd,
}: {
  gracePeriodEnd: Date | null;
}) {
  if (!gracePeriodEnd) return null;

  const daysLeft = Math.ceil(
    (gracePeriodEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  if (daysLeft <= 0) return null;

  return (
    <div style={{ padding: 16, background: "#fef3c7", borderRadius: 8 }}>
      <p>
        <strong>Payment issue:</strong> Your last payment failed.
        {daysLeft > 1
          ? ` You have ${daysLeft} days to update your payment method.`
          : " This is your last day — update your payment method now."}
      </p>
      <a href="/billing/update-payment">Update payment method</a>
    </div>
  );
}
```

## Dunning Email Sequence

Send a sequence of emails during the grace period. Integrate with your email provider (Resend, Postmark, SES, etc.).

### Email Schedule

| Day | Trigger | Subject | Tone |
|-----|---------|---------|------|
| 0 | `subscription.halted` | "Payment failed — we'll keep trying" | Informational |
| 3 | Cron job | "Action needed: update your payment method" | Urgent |
| 5 | Cron job | "Last chance — access ends in 2 days" | Final warning |
| 7 | Cron job (revocation) | "Access revoked — resubscribe to continue" | Post-revocation |

### Dunning Email Sender (with dedup)

```typescript
// lib/billing/dunning-emails.ts
type DunningStep = "day0" | "day3" | "day5" | "day7";

const DUNNING_SUBJECTS: Record<DunningStep, string> = {
  day0: "Payment failed — we'll keep trying",
  day3: "Action needed: update your payment method",
  day5: "Last chance — access ends in 2 days",
  day7: "Access revoked — resubscribe to continue",
};

export async function sendDunningEmail(
  subscription: Subscription,
  step: DunningStep
) {
  // Dedup check — don't send the same email twice
  if (subscription.dunningEmailsSent?.includes(step)) {
    return;
  }

  const user = await getUserById(subscription.userId);
  if (!user?.email) return;

  // Send email via your provider
  await sendEmail({
    to: user.email,
    subject: DUNNING_SUBJECTS[step],
    // Include link to update payment method
    updatePaymentUrl: `${process.env.NEXT_PUBLIC_APP_URL}/billing/update-payment`,
  });

  // Mark as sent
  await db
    .update(subscriptions)
    .set({
      dunningEmailsSent: [...(subscription.dunningEmailsSent || []), step],
    })
    .where(eq(subscriptions.id, subscription.id));
}
```

## Update Payment Method Flow

Razorpay does not support direct card updates for existing subscriptions. Use the **deferred cancellation** pattern (see plan-change skill).

### Pattern: Cancel Old, Create New with Same Plan

```typescript
// app/api/billing/update-payment/route.ts
export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) return new Response("Unauthorized", { status: 401 });

  try {
    const current = await getActiveOrHaltedSubscription(user.id);
    if (!current) {
      return Response.json({ error: "No subscription found" }, { status: 400 });
    }

    // Create a NEW subscription with the SAME plan
    const subscription = await razorpay.subscriptions.create({
      plan_id: current.razorpayPlanId,
      total_count: totalCountFor(current.planKey),
      quantity: 1,
      customer_notify: 1,
      notes: {
        userId: user.id,
        planKey: current.planKey,
        replacesSubscription: current.razorpaySubscriptionId, // Signals webhook
        reason: "payment_method_update",
      },
    });

    // DO NOT cancel old subscription here — webhook handles it after payment
    // This prevents access loss if user abandons the new checkout

    return Response.json({
      shortUrl: subscription.short_url,
      subscriptionId: subscription.id,
    });
  } catch (error) {
    console.error("Failed to create update-payment subscription:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}
```

### Alternative: Use `short_url` for Retry

If the halted subscription's `short_url` is still valid, the user can retry payment there without creating a new subscription. However, `short_url` is only available at creation time and cannot be retrieved later.

```typescript
// If you stored the short_url at creation time:
if (current.shortUrl) {
  return Response.json({ shortUrl: current.shortUrl });
}
// Otherwise, fall back to cancel-and-recreate pattern above
```

## Cron Job: Grace Period Expiry and Email Scheduling

Create an API route that a cron service calls periodically.

### Route: Process Dunning

```typescript
// app/api/billing/cron/dunning/route.ts
export async function GET(request: Request) {
  // Verify cron secret (prevent unauthorized access)
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();

  // 1. Find all subscriptions in grace period
  const haltedSubs = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "halted"),
        isNotNull(subscriptions.gracePeriodEnd)
      )
    );

  for (const sub of haltedSubs) {
    const gracePeriodEnd = new Date(sub.gracePeriodEnd!);
    const haltedAt = new Date(gracePeriodEnd);
    haltedAt.setDate(haltedAt.getDate() - 7); // Reverse-calculate halt date

    const daysSinceHalt = Math.floor(
      (now.getTime() - haltedAt.getTime()) / (1000 * 60 * 60 * 24)
    );

    // 2. Send dunning emails based on schedule
    if (daysSinceHalt >= 3) await sendDunningEmail(sub, "day3");
    if (daysSinceHalt >= 5) await sendDunningEmail(sub, "day5");

    // 3. Revoke access if grace period expired
    if (now >= gracePeriodEnd) {
      await sendDunningEmail(sub, "day7");
      await revokeAccess(sub.userId);

      // Clear grace period (dunning complete)
      await db
        .update(subscriptions)
        .set({
          gracePeriodEnd: null,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, sub.id));
    }
  }

  return Response.json({
    processed: haltedSubs.length,
    timestamp: now.toISOString(),
  });
}
```

### Vercel Cron Configuration

```json
// vercel.json
{
  "crons": [
    {
      "path": "/api/billing/cron/dunning",
      "schedule": "0 9 * * *"
    }
  ]
}
```

This runs daily at 9 AM UTC. Adjust timing based on your user base's timezone.

## Full Dunning Timeline

```
Day -3 to 0:  Razorpay auto-retries (you receive payment.failed for each attempt)
Day 0:        subscription.halted → Set gracePeriodEnd = now + 7 days → Send "payment failed" email
Day 0-7:      User has access (grace period) → Show banner in UI
Day 3:        Cron sends "update your card" email
Day 5:        Cron sends "last chance" email
Day 7:        Cron revokes access → Sends "access revoked" email
Day 7+:       User must resubscribe (update-payment flow creates new subscription)
```

## Gotchas

1. **Don't retry payments yourself**: Razorpay auto-retries 3 times over 3 days. Custom retries on top of this will conflict and may cause duplicate charges.
2. **`subscription.halted` is your signal**: This means ALL Razorpay retries failed. Start your grace period here, not on the first `payment.failed`.
3. **Multiple `payment.failed` events**: Razorpay sends one per retry attempt (up to 3). Don't start grace period or send emails on each one.
4. **`subscription.charged` clears everything**: If the user updates their card and payment succeeds, you get `subscription.charged`. Clear grace period and reset dunning state.
5. **Track email sends**: Store which dunning emails were sent. The cron job runs daily and will re-process the same subscriptions — dedup prevents spam.
6. **No direct card update API**: Razorpay subscriptions don't support swapping the payment method. Use the deferred cancellation pattern (cancel old + create new with same plan).
7. **`short_url` is ephemeral**: You cannot retrieve it after subscription creation. If you want to offer "retry payment" via `short_url`, store it when you first create the subscription.
8. **Cron auth is mandatory**: Always verify a secret on your cron endpoint. Without it, anyone can trigger dunning processing by hitting the URL.
