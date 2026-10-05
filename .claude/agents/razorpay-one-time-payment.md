---
name: razorpay-one-time-payment
description: Works on this repo's Razorpay Order + Standard Checkout + saved-card payment flow (lib/payments/core/razorpay.ts, lib/payments/index.ts, app/api/checkout/route.ts, app/api/payments/razorpay/callback/route.ts). Use when modifying checkout, order creation, saved cards, or signature verification.
tools: Glob, Grep, Read, Edit, Write, Bash, BashOutput, TodoWrite
model: inherit
color: cyan
---

## Before you start

**Read these first under `.claude/skills/finance/`:**
1. `references/razorpay/references/orders-and-checkout.md` — Orders API limits, Standard Checkout options, signature verification, and 3-day vs 5-day auto-capture nuances.
2. `references/razorpay/references/customers-and-saved-cards.md` — `ensureRazorpayCustomer`, `fail_existing: 0`, RBI CoFT tokenization, and GDPR erasure.
3. `references/razorpay/references/this-repo.md` and `references/doctrine.md` — single-writer confirmation pipeline (`routeCapturedPayment` / `handlePaymentSuccess`), funding-leg sum identity, and `PG_POOL_MAX=1`.

**CRITICAL — Do NOT scaffold `app/api/billing/create-order` or `lib/razorpay.ts`.**
This repo already has a complete checkout, order creation, saved-card customer provisioning, callback verification, and webhook confirmation pipeline. Always work within the existing files.

---

## How Checkout & Order Payments Work in This Repo

1. **Client & Saved-Card Customer (`lib/payments/core/razorpay.ts`)**:
   - `razorpayClient`: Nullable singleton initialized from `RAZORPAY_KEY_ID` + `RAZORPAY_SECRET`, guarded in production by `assertNoTestKeysInLiveProduction()`.
   - `ensureRazorpayCustomer({ userId, email, name, phone })`: Lazily creates or fetches the user's `cust_...` via `POST /v1/customers` with `fail_existing: 0` and persists `User.razorpayCustomerId` via a conditional `updateMany({ where: { id: userId, razorpayCustomerId: null } })`. Best-effort (`null` on error so checkout is never blocked).
2. **Order Creation (`lib/payments/index.ts`, `app/api/checkout/route.ts`)**:
   - Computes price and funding legs (`PaymentLeg`) in `BigInt` paise.
   - Calls `razorpayClient.orders.create({ amount, currency: "INR", receipt, notes })` **outside** any Prisma `$transaction` (respecting `PG_POOL_MAX=1`).
   - Constraints:
     - `amount`: integer in paise (`>= 100` paise for INR).
     - `receipt`: max **40 ASCII characters**, deterministic per payment attempt (acts as order-level idempotency key on Razorpay).
     - `notes`: max **15 key-value pairs**, max **256 characters** per value.
   - Returns `{ orderId, amount, currency, keyId, customerId }` to the frontend so Standard Checkout can open with `order_id` and optional `customer_id`.
3. **Client-Side Standard Checkout (`checkout.razorpay.com/v1/checkout.js`)**:
   - Passes `key` (`NEXT_PUBLIC_RAZORPAY_KEY_ID`), `order_id`, `customer_id` (if available, enabling RBI-compliant saved cards), `prefill`, `handler`, and `modal.ondismiss`.
   - Do **not** rely on `retry: { enabled: true, max_count: N }` to enforce a retry cap on web Standard Checkout — Razorpay documents `retry.max_count` as an Android/iOS SDK feature only.
4. **Server-Side Signature Verification (`lib/payments/core/razorpay.ts`, `app/api/payments/razorpay/callback/route.ts`)**:
   - Checkout handler/callback receives `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`.
   - Verified with `verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)` using **`RAZORPAY_SECRET`** (never `RAZORPAY_WEBHOOK_SECRET`):
     ```typescript
     const body = `${orderId}|${paymentId}`;
     const expectedSignature = crypto
       .createHmac("sha256", secret)
       .update(body)
       .digest("hex");

     const expectedBuffer = Buffer.from(expectedSignature, "utf8");
     const receivedBuffer = Buffer.from(signature, "utf8");
     if (expectedBuffer.length !== receivedBuffer.length) {
       return false;
     }
     return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
     ```
   - **Never call `crypto.timingSafeEqual` without checking `expectedBuffer.length === receivedBuffer.length` first** — mismatched buffer lengths throw an uncaught `RangeError`.
5. **Single-Writer Payment Confirmation (`routeCapturedPayment` / `handlePaymentSuccess`)**:
   - Both the client callback route and the `payment.captured` / `order.paid` webhook route converge into the single-writer confirmation pipeline inside a Serializable Prisma `$transaction` with a CAS-in-WHERE guard on `Payment.paymentStatus`.
   - Never mutate `Payment.paymentStatus = "SUCCEEDED"` directly in a route handler.
