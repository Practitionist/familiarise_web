---
description: Implement one-time payments with Razorpay — orders, invoices, HMAC verification, day passes, credits. Use when the user asks to "add a one-time purchase", "implement single payment", "create a day pass", "sell credits", or needs a non-recurring payment flow.
argument-hint: "[order|invoice]"
---

# Razorpay One-Time Payments

Two flows for one-time payments: **Order flow** (Razorpay JS SDK popup) and **Invoice flow** (hosted page). Both require server-side HMAC verification.

## One-Time Payments vs Subscriptions: Completely Different Checkout

This is a common source of confusion. One-time payments and subscriptions use **entirely different APIs and checkout experiences**:

| | One-Time Payment | Subscription |
|---|---|---|
| **API** | Orders API (`razorpay.orders.create`) | Subscriptions API (`razorpay.subscriptions.create`) |
| **Checkout UI** | JS SDK popup (`new Razorpay({...}).open()`) | Hosted page redirect (`short_url`) |
| **Client script** | `checkout.js` loaded via `<Script>` tag | No client script needed |
| **Verification** | Client-side HMAC (`order_id\|payment_id`) | Webhook (`subscription.activated`) |
| **Payment confirmation** | Immediate — `handler` callback fires | Async — webhook fires minutes later |
| **Where it runs** | Inline popup on your page | Separate Razorpay-hosted page |
| **Key used for HMAC** | `RAZORPAY_KEY_SECRET` (API secret) | `RAZORPAY_WEBHOOK_SECRET` (webhook secret) |

**Do NOT mix these up.** You cannot use `short_url` for one-time orders, and you cannot use the JS SDK popup for subscriptions (it technically works but breaks on mobile/popup blockers).

## Flow 1: Order + JS SDK (Recommended for UX)

### Create Order (Server)

```typescript
// app/api/billing/create-order/route.ts
export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  const { productKey, amountPaise } = await request.json();

  try {
    const order = await razorpay.orders.create({
      amount: amountPaise,       // Amount in paise (e.g., 11682 for Rs 116.82)
      currency: "INR",
      receipt: `${productKey}_${user.id}_${Date.now()}`,
      notes: {
        userId: user.id,
        productKey,
      },
    });

    return Response.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Failed to create order:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}
```

### Client-Side Checkout

```typescript
const handlePayment = async () => {
  // 1. Create order
  const res = await fetch("/api/billing/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productKey: "day_pass", amountPaise: 11682 }),
  });
  const order = await res.json();

  // 2. Open Razorpay popup
  const rzp = new window.Razorpay({
    key: order.keyId,
    amount: order.amount,
    currency: order.currency,
    order_id: order.orderId,
    name: "Your App",
    description: "Day Pass",
    handler: async (response: any) => {
      // 3. Verify on server
      const verifyRes = await fetch("/api/billing/verify-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
        }),
      });
      if (verifyRes.ok) {
        window.location.href = "/success";
      }
    },
    theme: { color: "#3b82f6" },
  });
  rzp.open();
};
```

**Note**: Add `<Script src="https://checkout.razorpay.com/v1/checkout.js" />` to your layout.

### Verify Payment (Server)

```typescript
// app/api/billing/verify-payment/route.ts
import crypto from "crypto";

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await request.json();

  // ORDER FLOW signature: HMAC(secret, "order_id|payment_id")
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  const isValid = crypto.timingSafeEqual(
    Buffer.from(expectedSignature, "hex"),
    Buffer.from(razorpay_signature, "hex")
  );

  if (!isValid) {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Payment verified — grant access
  await grantDayPass(user.id, razorpay_order_id, razorpay_payment_id);

  return Response.json({ success: true });
}
```

## Flow 2: Invoice (Hosted Page)

For invoice-based payments (no JS SDK needed):

### Verify Invoice Payment

```typescript
// INVOICE FLOW signature: HMAC(secret, "invoice_id|invoice_receipt|invoice_status|payment_id")
const signaturePayload = [
  invoiceId,
  invoiceReceipt ?? "",     // Use ?? "" for optional fields!
  invoiceStatus ?? "",
  paymentId,
].join("|");

const expectedSignature = crypto
  .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
  .update(signaturePayload)
  .digest("hex");
```

**CRITICAL**: Use `?? ""` for optional fields. If `invoiceReceipt` or `invoiceStatus` is undefined, the signature will be wrong.

## GST Calculation (18%)

**IMPORTANT**: Razorpay does NOT calculate GST for you — not for subscriptions, not for one-time payments. Your displayed price should include GST, and you must break it out yourself for invoicing. To create a proper GST invoice, use the Razorpay Invoice API (`razorpay.invoices.create()`) with separate line items for base amount, CGST, and SGST.

```typescript
function calculateGst(amountPaise: number) {
  const basePaise = Math.round(amountPaise / 1.18);
  const gstPaise = amountPaise - basePaise;
  const cgstPaise = Math.floor(gstPaise / 2);
  const sgstPaise = gstPaise - cgstPaise;  // Handles odd paise

  return { basePaise, cgstPaise, sgstPaise };
}

// Example: Rs 116.82 (Rs 99 + 18% GST)
// calculateGst(11682) → { basePaise: 9900, cgstPaise: 891, sgstPaise: 891 }
```

## Day Pass Pattern (24h Access)

```typescript
async function grantDayPass(userId: string, orderId: string, paymentId: string) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24h

  await db.insert(dayPasses).values({
    userId,
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId,
    amountPaise: 11682,
    startedAt: now,
    expiresAt,
  }).onConflictDoUpdate({
    target: [dayPasses.userId],  // One per user
    set: { razorpayOrderId: orderId, razorpayPaymentId: paymentId, startedAt: now, expiresAt },
  });

  // Grant access tier
  await updateUserAccess(userId, "day_pass");
}
```

## Gotchas

1. **Completely different from subscriptions**: One-time payments use the Orders API + JS SDK popup. Subscriptions use the Subscriptions API + hosted checkout page. Do not mix the two — they have different APIs, different checkout UIs, different verification methods, and different secrets.
2. **Two different signature formats**: Order flow = `order_id|payment_id`. Invoice flow = `invoice_id|receipt|status|payment_id`. Using the wrong format = silent failure.
3. **`?? ""` for optional invoice fields**: Missing fields in the signature payload produce wrong HMAC. Always default to empty string.
4. **`timingSafeEqual` requires same length**: Catch errors from length mismatch — treat as invalid.
5. **Verify key**: Order flow uses `RAZORPAY_KEY_SECRET` (your API key secret), NOT `RAZORPAY_WEBHOOK_SECRET`. These are different secrets for different purposes!
6. **Race condition**: Check purchase status AFTER signature verification, not before. Prevents double-grant between concurrent requests.
7. **Razorpay JS SDK script**: Must be loaded via `<Script>` tag, not `import`. It attaches to `window.Razorpay`. This script is ONLY for one-time payments, not subscriptions.
8. **Payment confirmation is immediate**: Unlike subscriptions (which rely on async webhooks), one-time payments confirm in the `handler` callback. You verify the HMAC signature server-side and grant access right away.
