# Razorpay Payment Architecture

## Overview

This document explains how payments flow through our system using Razorpay. If you're new to the team, read this to understand how money moves from customer to consultant.

### Quick Summary

```
Customer pays Rs.1,000
        |
        v
   [ RAZORPAY ] --- takes Rs.30 (3% gateway fee)
        |
        v
   [ PLATFORM ] --- Rs.970 received
        |
        +---> Platform keeps Rs.194 (20% commission)
        |
        +---> Consultant gets Rs.776 (80%)
```

---

## The Big Picture

### Who's Involved?

```
+------------------+     +------------------+     +------------------+
|    CONSULTEE     |     |   FAMILIARISE    |     |   CONSULTANT     |
|    (Customer)    |     |    (Platform)    |     |    (Expert)      |
+------------------+     +------------------+     +------------------+
        |                        |                        |
        | Books consultation     |                        |
        | Pays Rs.1,000          |                        |
        +----------------------->|                        |
                                 |                        |
                                 | Deducts commission     |
                                 | Sends Rs.776           |
                                 +----------------------->|
                                 |                        |
                                 |                  Money in bank!
```

### What Razorpay Does For Us

```
+----------------------------------------------------------------+
|                        RAZORPAY SERVICES                        |
+----------------------------------------------------------------+
|                                                                |
|  +-- Payment Collection                                        |
|  |   +-- Accept cards, UPI, netbanking                         |
|  |   +-- Handle 3D Secure authentication                       |
|  |   +-- Fraud detection                                       |
|  |                                                             |
|  +-- Payment Processing                                        |
|  |   +-- Authorize and capture payments                        |
|  |   +-- Handle refunds                                        |
|  |   +-- Currency conversion (if needed)                       |
|  |                                                             |
|  +-- Payouts (via Route)                                       |
|      +-- Linked accounts for consultants                       |
|      +-- Automated transfers                                   |
|      +-- Bank settlement                                       |
|                                                                |
+----------------------------------------------------------------+
```

---

## Payment Flow - Step by Step

### Step 1: Customer Initiates Payment

```
+-------------+                      +-------------+
|  Customer   |                      | Familiarise |
|  Browser    |                      |   Server    |
+------+------+                      +------+------+
       |                                    |
       |  1. Click "Book Consultation"      |
       |----------------------------------->|
       |                                    |
       |  2. Server creates Razorpay Order  |
       |                                    |
       |  3. Return order_id + amount       |
       |<-----------------------------------|
       |                                    |
```

### Step 2: Customer Pays via Razorpay Checkout

```
+-------------+                      +-------------+
|  Customer   |                      |  Razorpay   |
|  Browser    |                      |  Checkout   |
+------+------+                      +------+------+
       |                                    |
       |  1. Open checkout modal            |
       |----------------------------------->|
       |                                    |
       |  2. Customer enters card/UPI       |
       |  3. 3D Secure if needed            |
       |                                    |
       |  4. Payment authorized             |
       |<-----------------------------------|
       |                                    |
       |  Returns: payment_id, order_id     |
       |           signature                |
       |                                    |
```

### Step 3: Payment Verification & Capture

```
+-------------+          +-------------+          +-------------+
|  Customer   |          | Familiarise |          |  Razorpay   |
|  Browser    |          |   Server    |          |    API      |
+------+------+          +------+------+          +------+------+
       |                        |                        |
       |  1. Send payment_id    |                        |
       |----------------------->|                        |
       |                        |                        |
       |                        |  2. Verify signature   |
       |                        |----------------------->|
       |                        |                        |
       |                        |  3. Capture payment    |
       |                        |----------------------->|
       |                        |                        |
       |                        |  4. Payment captured!  |
       |                        |<-----------------------|
       |                        |                        |
       |  5. Booking confirmed  |                        |
       |<-----------------------|                        |
```

### Step 4: Webhook Notification

```
+-------------+          +-------------+
|  Razorpay   |          | Familiarise |
|   Server    |          |   Server    |
+------+------+          +------+------+
       |                        |
       |  1. POST /webhooks/razorpay
       |     Event: payment.captured
       |----------------------->|
       |                        |
       |                        |  2. Verify signature
       |                        |  3. Update database
       |                        |  4. Create earnings record
       |                        |  5. Send confirmation email
       |                        |
       |  HTTP 200 OK           |
       |<-----------------------|
```

---

## Revenue Split Breakdown

### The Math (On Rs.1,000 Payment)

```
+------------------------------------------------------------------+
|                    PAYMENT BREAKDOWN                              |
+------------------------------------------------------------------+
|                                                                   |
|  Customer Pays:                    Rs. 1,000.00                   |
|                                    ============                   |
|                                                                   |
|  STEP 1: Gateway Fee                                              |
|  +-- Razorpay charges: 2% + 18% GST                               |
|  +-- 2% of 1000 = Rs.20                                           |
|  +-- 18% GST on Rs.20 = Rs.3.60                                   |
|  +-- Total gateway fee: Rs.23.60 (~2.36%)                         |
|                                                                   |
|  Simplified: We use 3% for calculations                           |
|  Gateway Fee: Rs.30                                               |
|                                                                   |
|  Net Amount to Platform: Rs.970                                   |
|                                                                   |
|  STEP 2: Platform Commission                                      |
|  +-- 20% of Rs.970 = Rs.194                                       |
|                                                                   |
|  STEP 3: Consultant Earnings                                      |
|  +-- 80% of Rs.970 = Rs.776                                       |
|                                                                   |
+------------------------------------------------------------------+

Summary Table:
+------------------+----------+--------------+
| Party            | Amount   | Percentage   |
+------------------+----------+--------------+
| Razorpay         | Rs.30    | 3% of total  |
| Familiarise      | Rs.194   | 20% of net   |
| Consultant       | Rs.776   | 80% of net   |
+------------------+----------+--------------+
| Total            | Rs.1000  | 100%         |
+------------------+----------+--------------+
```

### Commission by Tier

```
+----------+------------------+--------------+-----------+
| Tier     | Price Range      | Commission   | Consultant|
+----------+------------------+--------------+-----------+
| Budget   | Rs.299 - 999     | 20%          | 77.6%     |
| Everyday | Rs.1000 - 2999   | 20%          | 77.6%     |
| Premium  | Rs.3000 - 9999   | 18%          | 79.5%     |
| Luxury   | Rs.10000+        | 15%          | 82.4%     |
+----------+------------------+--------------+-----------+

Higher tier = Lower commission = Happy top consultants!
```

---

## Payment States

### State Machine

```
                    +----------+
                    | CREATED  |  Order created, waiting for payment
                    +----+-----+
                         |
                         | Customer initiates payment
                         v
                    +----------+
                    |AUTHORIZED|  Payment authorized, funds reserved
                    +----+-----+
                         |
           +-------------+-------------+
           |                           |
           | Auto-capture              | Manual capture timeout
           v                           v
      +----------+               +----------+
      | CAPTURED |               |  FAILED  |  Authorization expired
      +----+-----+               +----------+
           |
           | Refund requested
           v
      +----------+
      | REFUNDED |  Money returned to customer
      +----------+
```

### State Descriptions

```
+------------+----------------------------------------------------+
| State      | Description                                        |
+------------+----------------------------------------------------+
| CREATED    | Order exists, customer hasn't paid yet             |
| AUTHORIZED | Customer's card charged, funds on hold             |
| CAPTURED   | Funds successfully captured, money is ours         |
| FAILED     | Payment failed (declined, expired, error)          |
| REFUNDED   | Full/partial refund issued to customer             |
+------------+----------------------------------------------------+
```

---

## Webhook Events

### Key Events We Handle

```
+------------------------+----------------------------------------+
| Event                  | When It Fires                          |
+------------------------+----------------------------------------+
| payment.authorized     | Payment authorized, awaiting capture   |
| payment.captured       | Payment successfully captured          |
| payment.failed         | Payment failed                         |
| refund.created         | Refund initiated                       |
| refund.processed       | Refund completed                       |
+------------------------+----------------------------------------+
```

### Webhook Payload Example

```json
{
  "event": "payment.captured",
  "payload": {
    "payment": {
      "entity": {
        "id": "pay_xxxxxxxxxxxxx",
        "order_id": "order_xxxxxxxxxxxxx",
        "amount": 100000,
        "currency": "INR",
        "status": "captured",
        "method": "upi",
        "email": "customer@example.com",
        "contact": "+919876543210",
        "created_at": 1234567890
      }
    }
  }
}
```

### What We Do On Each Event

```
payment.captured:
+-- Verify webhook signature
+-- Find order in database
+-- Update payment status to CAPTURED
+-- Create ConsultantEarnings record
+-- Calculate: gross, gateway fee, platform fee, net
+-- Set hold period (24 hours)
+-- Send confirmation email to customer
+-- Notify consultant

payment.failed:
+-- Update payment status to FAILED
+-- Send failure email to customer
+-- Release any held inventory

refund.processed:
+-- Update payment status to REFUNDED
+-- Update earnings status to REFUNDED
+-- Restore consultant's available balance (if already paid)
+-- Notify both parties
```

---

## Code Flow

### 1. Create Order (Backend)

```typescript
// app/api/payments/create-order/route.ts

import razorpay from "@/lib/payments/core/razorpay";

export async function POST(req: Request) {
  const { appointmentId, amount } = await req.json();

  // Create Razorpay order
  const order = await razorpay.orders.create({
    amount: amount * 100, // Convert to paise
    currency: "INR",
    receipt: `appt_${appointmentId}`,
    notes: {
      appointmentId,
    },
  });

  // Save order in database
  await prisma.payment.create({
    data: {
      appointmentId,
      amount: amount * 100,
      currency: "INR",
      gateway: "RAZORPAY",
      gatewayOrderId: order.id,
      status: "PENDING",
    },
  });

  return Response.json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    key: process.env.RAZORPAY_KEY_ID,
  });
}
```

### 2. Customer Checkout (Frontend)

```typescript
// components/checkout/RazorpayCheckout.tsx

function initiatePayment(orderData: OrderData) {
  const options = {
    key: orderData.key,
    amount: orderData.amount,
    currency: orderData.currency,
    order_id: orderData.orderId,
    name: "Familiarise",
    description: "Consultation Booking",
    handler: async function (response: RazorpayResponse) {
      // Send to backend for verification
      await verifyPayment({
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_order_id: response.razorpay_order_id,
        razorpay_signature: response.razorpay_signature,
      });
    },
    prefill: {
      email: user.email,
      contact: user.phone,
    },
  };

  const rzp = new window.Razorpay(options);
  rzp.open();
}
```

### 3. Verify & Capture (Backend)

```typescript
// app/api/payments/verify/route.ts

import crypto from "crypto";

export async function POST(req: Request) {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } =
    await req.json();

  // Verify signature
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
    .update(body)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Capture payment (if not auto-captured)
  const payment = await razorpay.payments.capture(
    razorpay_payment_id,
    amount,
    "INR",
  );

  // Update database
  await prisma.payment.update({
    where: { gatewayOrderId: razorpay_order_id },
    data: {
      gatewayPaymentId: razorpay_payment_id,
      status: "CAPTURED",
    },
  });

  return Response.json({ success: true });
}
```

### 4. Handle Webhook (Backend)

```typescript
// app/api/webhooks/razorpay/route.ts

export async function POST(req: Request) {
  const body = await req.text();
  const signature = req.headers.get("x-razorpay-signature")!;

  // Verify webhook
  if (!verifyRazorpayWebhook(body, signature)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = JSON.parse(body);

  switch (event.event) {
    case "payment.captured":
      await handlePaymentCaptured(event.payload.payment.entity);
      break;
    case "payment.failed":
      await handlePaymentFailed(event.payload.payment.entity);
      break;
    case "refund.processed":
      await handleRefundProcessed(event.payload.refund.entity);
      break;
  }

  return Response.json({ received: true });
}
```

---

## Error Handling

### Common Errors

```
+-----------------------------+----------------------------------------+
| Error                       | What To Do                             |
+-----------------------------+----------------------------------------+
| BAD_REQUEST_ERROR           | Check request parameters               |
| GATEWAY_ERROR               | Retry or contact Razorpay support      |
| SERVER_ERROR                | Our server issue, check logs           |
| PAYMENT_FAILED              | Customer's payment method declined     |
| SIGNATURE_MISMATCH          | Verify webhook secret is correct       |
+-----------------------------+----------------------------------------+
```

### Retry Strategy

```
For transient errors (GATEWAY_ERROR, SERVER_ERROR):

Attempt 1: Immediate
Attempt 2: After 1 second
Attempt 3: After 5 seconds
Attempt 4: After 30 seconds
Attempt 5: After 5 minutes

After 5 attempts: Log error, alert team, manual intervention
```

---

## Testing Checklist

```
[ ] Order creation works
[ ] Checkout modal opens
[ ] Test card payment succeeds
[ ] Test UPI payment succeeds
[ ] Failed payment handled correctly
[ ] Webhook received and processed
[ ] Earnings record created
[ ] Refund flow works
[ ] Error handling works
```

---

## Related Documents

- [01-setup.md](./01-setup.md) - Initial Razorpay setup
- [03-payout-flow.md](./03-payout-flow.md) - Consultant payouts
- [Razorpay API Docs](https://razorpay.com/docs/api/)
