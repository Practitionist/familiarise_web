---
description: Implement Razorpay refunds — full refunds, partial refunds, refund webhooks, status tracking. Use when the user asks to "process a refund", "refund a payment", "issue a partial refund", "handle refund webhooks", or needs to return money to customers.
argument-hint: "[full|partial|webhook]"
---

# Razorpay Refunds

Three patterns: **full refund** (return entire payment), **partial refund** (return a portion), and **webhook-driven status tracking** (react to refund lifecycle events).

## Full Refund API Route

```typescript
// app/api/billing/refund/route.ts
import { razorpay } from "@/lib/razorpay"; // Use the shared singleton client

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  const { paymentId, reason } = await request.json();

  // Verify the payment belongs to this user
  const payment = await getPaymentByRazorpayId(paymentId, user.id);
  if (!payment) {
    return Response.json({ error: "Payment not found" }, { status: 404 });
  }

  // Full refund — omit amount to refund the entire payment.
  // X-Refund-Idempotency (key >=10 chars) prevents a double refund on network retry.
  // SDK caveat: razorpay-node (<=2.9.6) helper methods CANNOT send per-request headers —
  // payments.refund(id, params, thirdArg) treats the 3rd argument as a callback and the
  // header is silently dropped. Call the REST endpoint directly to send the header:
  const res = await fetch(
    `https://api.razorpay.com/v1/payments/${paymentId}/refund`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
          ).toString("base64"),
        "Content-Type": "application/json",
        "X-Refund-Idempotency": `refund-${paymentId}`, // >=10 chars, unique per logical refund
      },
      body: JSON.stringify({
        notes: {
          userId: user.id,
          reason: reason || "Customer requested refund",
        },
      }),
    }
  );
  if (!res.ok) {
    return Response.json({ error: "Refund failed" }, { status: 502 });
  }
  const refund = await res.json();

  // Store refund record in DB
  await db.insert(refunds).values({
    razorpayRefundId: refund.id,
    razorpayPaymentId: paymentId,
    userId: user.id,
    amountPaise: refund.amount,
    status: refund.status, // "pending" initially
    speedRequested: refund.speed_requested, // "normal" or "optimum"
    speedProcessed: refund.speed_processed, // "normal" or "instant" — how it actually settled
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

  // Partial refund — pass specific amount in paise.
  // Direct REST call (not razorpay.payments.refund) so X-Refund-Idempotency is actually
  // sent — the SDK (<=2.9.6) silently drops a headers object passed as the 3rd argument.
  const res = await fetch(
    `https://api.razorpay.com/v1/payments/${paymentId}/refund`,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
          ).toString("base64"),
        "Content-Type": "application/json",
        "X-Refund-Idempotency": `refund-${paymentId}-${amountPaise}`,
      },
      body: JSON.stringify({
        amount: amountPaise, // Amount in paise (e.g., 5000 for Rs 50)
        notes: {
          userId: user.id,
          reason: reason || "Partial refund",
        },
      }),
    }
  );
  if (!res.ok) {
    return Response.json({ error: "Refund failed" }, { status: 502 });
  }
  const refund = await res.json();

  await db.insert(refunds).values({
    razorpayRefundId: refund.id,
    razorpayPaymentId: paymentId,
    userId: user.id,
    amountPaise: refund.amount,
    status: refund.status,
    speedRequested: refund.speed_requested,
    speedProcessed: refund.speed_processed,
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
    case "refund.created": {
      // Refund has been created — update or insert record
      await upsertRefund({
        razorpayRefundId: refundEntity.id,
        razorpayPaymentId: refundEntity.payment_id,
        amountPaise: refundEntity.amount,
        status: "pending",
        speedRequested: refundEntity.speed_requested,
        speedProcessed: refundEntity.speed_processed,
      });
      break;
    }

    // ── Refund Completed (money returned to customer) ───────
    case "refund.processed": {
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
    case "refund.failed": {
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

    // ── Refund Speed Changed (e.g. instant fell back to normal) ──
    case "refund.speed_changed": {
      // Razorpay re-evaluated the refund speed — persist the new processed speed
      await updateRefundSpeedProcessed(
        refundEntity.id,
        refundEntity.speed_processed
      );
      break;
    }
  }
}

async function upsertRefund(data: {
  razorpayRefundId: string;
  razorpayPaymentId: string;
  amountPaise: number;
  status: string;
  speedRequested: string;
  speedProcessed: string;
}) {
  await db
    .insert(refunds)
    .values({
      razorpayRefundId: data.razorpayRefundId,
      razorpayPaymentId: data.razorpayPaymentId,
      amountPaise: data.amountPaise,
      status: data.status,
      speedRequested: data.speedRequested,
      speedProcessed: data.speedProcessed,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [refunds.razorpayRefundId],
      set: {
        status: data.status,
        speedProcessed: data.speedProcessed,
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

async function updateRefundSpeedProcessed(
  razorpayRefundId: string,
  speedProcessed: string
) {
  await db
    .update(refunds)
    .set({ speedProcessed, updatedAt: new Date() })
    .where(eq(refunds.razorpayRefundId, razorpayRefundId));
}
```

## Refund Status Tracking

Refund lifecycle: `pending` -> `processed` (success) or `pending` -> `failed`

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
    if (refund.status === "pending") {
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
    status: text("status").notNull().default("pending"), // pending | processed | failed
    speedRequested: text("speed_requested"), // "normal" | "optimum"
    speedProcessed: text("speed_processed"), // "normal" | "instant" — how it actually settled
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
| `refund.created` | Refund initiated | Store/update refund record |
| `refund.processed` | Money returned to customer | Mark processed, revoke access if full refund |
| `refund.failed` | Refund failed | Mark failed, alert admin |
| `refund.speed_changed` | Razorpay re-evaluated refund speed | Update stored `speed_processed` |

## Gotchas

1. **API calls use `RAZORPAY_KEY_SECRET`, not webhook secret**: The `razorpay.payments.refund()` call authenticates with `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`. The `RAZORPAY_WEBHOOK_SECRET` is only for verifying incoming webhook signatures.
2. **Partial refund sum limit**: The sum of all refund amounts for a payment cannot exceed the original payment amount. Razorpay will reject the API call if you try to over-refund. Always validate on your side first.
3. **Refund speed — "optimum" vs "normal"**: `speed_requested: "optimum"` requests an instant refund for the customer (money back in minutes) but Razorpay charges an extra fee. `"normal"` refunds take 5-7 business days. Default is `"normal"` unless you request otherwise. The response carries `speed_processed` (`normal` | `instant`) telling you how it actually settled — store both, since an `optimum` request can still fall back to `normal`.
4. **Test mode vs live mode timing**: Test-mode refunds typically process immediately, but this is not a documented guarantee. Live-mode `normal` refunds take 5-7 business days. Do not build flows that assume instant processing — always react to the `refund.processed` webhook.
5. **6-month refund window**: Razorpay does not allow refunds on payments older than 6 months. The API call will fail. Check payment age before attempting a refund.
6. **Subscription payment refund does NOT cancel the subscription**: Refunding a subscription charge only returns money — the subscription remains active and will charge again on the next cycle. You must cancel the subscription separately via `razorpay.subscriptions.cancel()`.
7. **Amount is always in paise**: 100 paise = 1 INR. A refund of Rs 50 requires `amount: 5000`. Forgetting this is the most common billing bug.
8. **Idempotency on webhooks**: Razorpay may send the same refund webhook multiple times. Use `razorpayRefundId` as the unique key with `onConflictDoUpdate` to handle duplicates.
9. **Idempotency on refund creation**: Pass the `X-Refund-Idempotency` header (key >=10 chars) on the create-refund call. If a network error causes a retry, Razorpay returns the original refund instead of issuing a second one — without it, a retry can double-refund the customer. **SDK caveat**: razorpay-node (<=2.9.6) cannot send per-request headers — `payments.refund(id, params, x)` treats `x` as a callback and drops it silently. Use a direct REST call (as in the patterns above) when you need the header.
