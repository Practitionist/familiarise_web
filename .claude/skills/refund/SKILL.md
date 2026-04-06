---
description: Implement Razorpay refunds — full refunds, partial refunds, refund webhooks, status tracking. Use when the user asks to "process a refund", "refund a payment", "issue a partial refund", "handle refund webhooks", or needs to return money to customers.
argument-hint: "[full|partial|webhook]"
---

# Razorpay Refunds

Three patterns: **full refund** (return entire payment), **partial refund** (return a portion), and **webhook-driven status tracking** (react to refund lifecycle events).

## Full Refund API Route

```typescript
// app/api/billing/refund/route.ts
import Razorpay from "razorpay";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  const { paymentId, reason } = await request.json();

  // Verify the payment belongs to this user
  const payment = await getPaymentByRazorpayId(paymentId, user.id);
  if (!payment) {
    return Response.json({ error: "Payment not found" }, { status: 404 });
  }

  // Full refund — omit amount to refund the entire payment
  const refund = await razorpay.payments.refund(paymentId, {
    notes: {
      userId: user.id,
      reason: reason || "Customer requested refund",
    },
  });

  // Store refund record in DB
  await db.insert(refunds).values({
    razorpayRefundId: refund.id,
    razorpayPaymentId: paymentId,
    userId: user.id,
    amountPaise: refund.amount,
    status: refund.status, // "created" initially
    speed: refund.speed_requested, // "normal" or "optimized"
  });

  return Response.json({
    refundId: refund.id,
    amount: refund.amount,
    status: refund.status,
  });
}
```

## Partial Refund Pattern

```typescript
// app/api/billing/partial-refund/route.ts
export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  const { paymentId, amountPaise, reason } = await request.json();

  // Verify the payment belongs to this user
  const payment = await getPaymentByRazorpayId(paymentId, user.id);
  if (!payment) {
    return Response.json({ error: "Payment not found" }, { status: 404 });
  }

  // Calculate cumulative refunds to prevent over-refunding
  const existingRefunds = await db
    .select({ total: sql<number>`COALESCE(SUM(${refunds.amountPaise}), 0)` })
    .from(refunds)
    .where(
      and(
        eq(refunds.razorpayPaymentId, paymentId),
        ne(refunds.status, "failed") // Exclude failed refunds from total
      )
    );

  const totalRefundedPaise = existingRefunds[0]?.total ?? 0;
  const remainingPaise = payment.amountPaise - totalRefundedPaise;

  if (amountPaise > remainingPaise) {
    return Response.json(
      {
        error: "Refund amount exceeds remaining refundable amount",
        remainingPaise,
        requestedPaise: amountPaise,
      },
      { status: 400 }
    );
  }

  // Partial refund — pass specific amount in paise
  const refund = await razorpay.payments.refund(paymentId, {
    amount: amountPaise, // Amount in paise (e.g., 5000 for Rs 50)
    notes: {
      userId: user.id,
      reason: reason || "Partial refund",
    },
  });

  await db.insert(refunds).values({
    razorpayRefundId: refund.id,
    razorpayPaymentId: paymentId,
    userId: user.id,
    amountPaise: refund.amount,
    status: refund.status,
    speed: refund.speed_requested,
  });

  return Response.json({
    refundId: refund.id,
    amount: refund.amount,
    status: refund.status,
    totalRefunded: totalRefundedPaise + refund.amount,
    remaining: payment.amountPaise - totalRefundedPaise - refund.amount,
  });
}
```

## Refund Webhook Events

Add these cases to your existing webhook handler (see `webhook` skill for the full handler pattern):

```typescript
// Inside your webhook event handler switch statement
async function handleRefundEvent(eventType: string, event: any) {
  const refundEntity = event.payload?.refund?.entity;
  const paymentEntity = event.payload?.payment?.entity;

  if (!refundEntity) return;

  switch (eventType) {
    // ── Refund Initiated ────────────────────────────────────
    case "payment.refund.created": {
      // Refund has been created — update or insert record
      await upsertRefund({
        razorpayRefundId: refundEntity.id,
        razorpayPaymentId: refundEntity.payment_id,
        amountPaise: refundEntity.amount,
        status: "created",
        speed: refundEntity.speed_requested,
      });
      break;
    }

    // ── Refund Completed (money returned to customer) ───────
    case "payment.refund.processed": {
      await updateRefundStatus(refundEntity.id, "processed");

      // Revoke access if this was a full refund
      if (paymentEntity && refundEntity.amount === paymentEntity.amount) {
        const userId = paymentEntity.notes?.userId || refundEntity.notes?.userId;
        if (userId) {
          await revokeAccessForPayment(userId, refundEntity.payment_id);
        }
      }
      break;
    }

    // ── Refund Failed ───────────────────────────────────────
    case "payment.refund.failed": {
      await updateRefundStatus(refundEntity.id, "failed");
      // Alert admin — manual intervention may be needed
      await notifyAdmin({
        type: "refund_failed",
        refundId: refundEntity.id,
        paymentId: refundEntity.payment_id,
        amount: refundEntity.amount,
      });
      break;
    }
  }
}

async function upsertRefund(data: {
  razorpayRefundId: string;
  razorpayPaymentId: string;
  amountPaise: number;
  status: string;
  speed: string;
}) {
  await db
    .insert(refunds)
    .values({
      razorpayRefundId: data.razorpayRefundId,
      razorpayPaymentId: data.razorpayPaymentId,
      amountPaise: data.amountPaise,
      status: data.status,
      speed: data.speed,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [refunds.razorpayRefundId],
      set: {
        status: data.status,
        updatedAt: new Date(),
      },
    });
}

async function updateRefundStatus(razorpayRefundId: string, status: string) {
  await db
    .update(refunds)
    .set({ status, updatedAt: new Date() })
    .where(eq(refunds.razorpayRefundId, razorpayRefundId));
}
```

## Refund Status Tracking

Refund lifecycle: `created` -> `processed` (success) or `created` -> `failed`

```typescript
// app/api/billing/refund-status/route.ts
export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request);
  const { searchParams } = new URL(request.url);
  const paymentId = searchParams.get("paymentId");

  if (!paymentId) {
    return Response.json({ error: "paymentId required" }, { status: 400 });
  }

  // Get all refunds for this payment from DB
  const paymentRefunds = await db
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.razorpayPaymentId, paymentId),
        eq(refunds.userId, user.id)
      )
    )
    .orderBy(desc(refunds.createdAt));

  // Optionally fetch latest status from Razorpay API
  // (useful if webhooks are delayed)
  for (const refund of paymentRefunds) {
    if (refund.status === "created") {
      try {
        const rzpRefund = await razorpay.refunds.fetch(refund.razorpayRefundId);
        if (rzpRefund.status !== refund.status) {
          await updateRefundStatus(refund.razorpayRefundId, rzpRefund.status);
          refund.status = rzpRefund.status;
        }
      } catch {
        // Use cached status if API fails
      }
    }
  }

  return Response.json({ refunds: paymentRefunds });
}
```

## Database Schema

```typescript
// db/schema.ts (Drizzle ORM)
import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const refunds = pgTable(
  "refunds",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    razorpayRefundId: text("razorpay_refund_id").notNull(),
    razorpayPaymentId: text("razorpay_payment_id").notNull(),
    userId: text("user_id").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    status: text("status").notNull().default("created"), // created | processed | failed
    speed: text("speed"), // "normal" | "optimized"
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    razorpayRefundIdx: uniqueIndex("razorpay_refund_idx").on(table.razorpayRefundId),
    paymentIdx: uniqueIndex("payment_refund_idx").on(table.razorpayPaymentId, table.razorpayRefundId),
  })
);
```

## Webhook Events Reference

| Event | When | Action |
|-------|------|--------|
| `payment.refund.created` | Refund initiated | Store/update refund record |
| `payment.refund.processed` | Money returned to customer | Mark processed, revoke access if full refund |
| `payment.refund.failed` | Refund failed | Mark failed, alert admin |

## Gotchas

1. **API calls use `RAZORPAY_KEY_SECRET`, not webhook secret**: The `razorpay.payments.refund()` call authenticates with `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`. The `RAZORPAY_WEBHOOK_SECRET` is only for verifying incoming webhook signatures.
2. **Partial refund sum limit**: The sum of all refund amounts for a payment cannot exceed the original payment amount. Razorpay will reject the API call if you try to over-refund. Always validate on your side first.
3. **Refund speed — "optimized" vs "normal"**: `"optimized"` refunds are instant for the customer (money back in minutes) but Razorpay charges an extra fee. `"normal"` refunds take 5-7 business days. Default is `"normal"` unless you request otherwise.
4. **Test mode vs live mode timing**: Test mode refunds process instantly (`created` -> `processed` immediately). Live mode refunds take 5-7 business days. Do not build flows that assume instant processing.
5. **6-month refund window**: Razorpay does not allow refunds on payments older than 6 months. The API call will fail. Check payment age before attempting a refund.
6. **Subscription payment refund does NOT cancel the subscription**: Refunding a subscription charge only returns money — the subscription remains active and will charge again on the next cycle. You must cancel the subscription separately via `razorpay.subscriptions.cancel()`.
7. **Amount is always in paise**: 100 paise = 1 INR. A refund of Rs 50 requires `amount: 5000`. Forgetting this is the most common billing bug.
8. **Idempotency on webhooks**: Razorpay may send the same refund webhook multiple times. Use `razorpayRefundId` as the unique key with `onConflictDoUpdate` to handle duplicates.
