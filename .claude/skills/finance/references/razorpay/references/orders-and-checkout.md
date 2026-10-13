# Orders & Standard Checkout (`POST /v1/orders` & `checkout.js`)

Official citations:

- [Create an Order (`POST /v1/orders`)](https://razorpay.com/docs/api/orders/create/)
- [Configure Capture Settings Using Orders API](https://razorpay.com/docs/payments/payments/capture-settings/api/)
- [Standard Checkout Web Integration Steps](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)

## Where It Lives in This Repo

- **Server Order Creation**: `createRazorpayOrder` in [`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts) (called via `createPaymentIntent` in [`lib/payments/index.ts`](../../../../../lib/payments/index.ts)).
- **Client Modal Options**: `buildCheckoutOptions` and `holdTimeoutSeconds` in [`lib/payments/client/checkout-options.ts`](../../../../../lib/payments/client/checkout-options.ts).
- **Client Checkout Component**: [`app/checkout/components/RazorpayCheckout.tsx`](../../../../../app/checkout/components/RazorpayCheckout.tsx).
- **Prefill Normalization**: `normalizeRazorpayContact` and `buildRazorpayPrefill` in [`lib/payments/razorpay-prefill.ts`](../../../../../lib/payments/razorpay-prefill.ts).
- **Client-Return Signature Verification**: `POST /api/checkout/verify-signature` in [`app/api/checkout/verify-signature/route.ts`](../../../../../app/api/checkout/verify-signature/route.ts).
- **Confirmation Pipeline**: `routeCapturedPayment` in [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts) → `handlePaymentSuccess` in [`lib/payments/webhooks/handlers.ts`](../../../../../lib/payments/webhooks/handlers.ts).

---

## 1. End-to-End Flow in This Repo

```
1. Client clicks "Pay with Razorpay" in RazorpayCheckout.tsx
   └─ Sends POST /api/checkout with checkoutData + clientIdempotencyKey
2. Server validates slot/entitlement, computes tax (determineTax, additive 18% GST),
   creates Payment row (paymentStatus = PENDING, amount in integer paise),
   and calls createRazorpayOrder() → POST /v1/orders
3. Server stores order.id ("order_...") in Payment.paymentIntent and returns
   { paymentIntent: { id, amount, currency, customerId }, holdExpiresAt }
4. Client loads https://checkout.razorpay.com/v1/checkout.js and opens modal
   with buildCheckoutOptions({ orderId, amount, currency, customerId, holdExpiresAt, ... })
5. Buyer completes payment in modal:
   ├─ Client path (fast UI feedback): handler() POSTs { razorpay_order_id,
   │  razorpay_payment_id, razorpay_signature } to /api/checkout/verify-signature.
   │  Route verifies HMAC-SHA256(order_id|payment_id, RAZORPAY_SECRET), fetches
   │  live payment via razorpayClient.payments.fetch(razorpay_payment_id) to prove
   │  status === "captured", and runs routeCapturedPayment() inside after().
   └─ Webhook path (durable source of truth): Razorpay POSTs payment.captured
      (and order.paid) to /api/webhooks/razorpay, which verifies x-razorpay-signature,
      logs WebhookEvent idempotently, and runs routeCapturedPayment() inside after().
```

> **ADR 21 Invariant:** `/api/checkout/verify-signature` **never** flips `Payment.paymentStatus = SUCCEEDED` with a bare `updateMany`. Both `/api/checkout/verify-signature` and `/api/webhooks/razorpay` call the exact same idempotent, `Serializable` `routeCapturedPayment()` pipeline so whichever arrives first performs the appointment confirmation, `gatewayPaymentId` stamp, capture-amount parity check, `ConsultantEarnings` creation, and `booking:<paymentId>` ledger posting, and the second arrival is a clean no-op.

---

## 2. Creating an Order (`createRazorpayOrder`)

```ts
// lib/payments/core/razorpay.ts
const order = await withRazorpaySdkTimeout("orders.create", () =>
  razorpayClient.orders.create({
    amount: amount, // integer paise (₹500.00 = 50000)
    currency: settlementCurrency, // "INR" enforced by assertInrSettlement()
    notes: metadata,
    receipt: `receipt_${Date.now()}_${globalThis.crypto.randomUUID().slice(0, 8)}`,
    ...(customerId ? { customer_id: customerId } : {}),
    ...(holdExpiresAt ? { payment: holdCaptureSettings(holdExpiresAt) } : {}),
  }),
);
```

### Verified Official `POST /v1/orders` Constraints

| Field      | Rule (Verified against `razorpay.com/docs/api/orders/create/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amount`   | **Mandatory integer** in smallest currency subunit (paise for INR). **Minimum `100` paise (₹1.00)** enforced directly in `createRazorpayOrder` (`!Number.isSafeInteger(amount) \|\| amount < 100`) — `< 100` fails at Razorpay with `400 BAD_REQUEST_ERROR: "The amount must be at least INR 1.00"`. Under RBI PA-CB guidelines for cross-border / MoneySaver Export inflows, single transactions are capped at **₹25,00,000** (`250_000_000` paise) with mandatory purpose code (`P0802`/`P1009`) and FIRS/e-FIRA reconciliation. |
| `currency` | **Mandatory 3-letter ISO code.** `assertInrSettlement` enforces `"INR"` before calling the SDK so a non-INR billing account cannot mint a foreign-currency order with paise numbers.                                                                                                                                                                                                                                                                                                                                               |
| `receipt`  | **Optional string, max 40 ASCII characters, must be unique.** Razorpay treats `receipt` as an idempotency key: passing a duplicate `receipt` returns `400 BAD_REQUEST_ERROR: "Duplicate request. This request has already been processed."` Our format `receipt_${Date.now()}_${uuid8}` is 29 characters and collision-free (#PM-11).                                                                                                                                                                                              |
| `notes`    | **Optional JSON object of string key-value pairs.** **Max 15 keys, max 256 characters per key/value.** Note: when `notes` is empty, Razorpay's API returns `notes: []` (an empty array) instead of `{}` — `razorpayFetchedPaymentSchema` normalizes `[]` to `{}`.                                                                                                                                                                                                                                                                  |
| `payment`  | Per-order capture settings (`capture: "automatic"`, `capture_options: { automatic_expiry_period, manual_expiry_period, refund_speed: "normal" }`). Floor for `automatic_expiry_period` is **`12` minutes**; ceiling for `manual_expiry_period` is **`7200` minutes (5 days)**. Sized to the booking slot hold via `holdCaptureSettings(holdExpiresAt)` (#1861 L1).                                                                                                                                                                 |

---

## 3. Standard Checkout Options & Modal Lifecycle

Built by `buildCheckoutOptions` in [`lib/payments/client/checkout-options.ts`](../../../../../lib/payments/client/checkout-options.ts):

- **`timeout` (in seconds)**: Bounded to `secondsLeft - 60` before `holdExpiresAt` (refuses to open if `<= 120` seconds of hold remain). Prevents a buyer from starting payment on a slot hold that is about to expire.
- **`modal.ondismiss`**: Fires when the buyer closes the Checkout sheet without paying. Resets `isProcessing` to `false` (closing the sheet fires neither `handler` nor `payment.failed`).
- **`rzp.on("payment.failed", callback)`**: Fires when an in-modal payment attempt fails.
- **`config.display.hide`**: When `ENABLE_CHECKOUT_EMI` is off, passes `{ display: { hide: [{ method: "emi" }], preferences: { show_default_blocks: true } } }` to hide Razorpay's EMI block (#1780).
- **`prefill` (`lib/payments/razorpay-prefill.ts`)**: Passes `{ name, email, contact }`. `normalizeRazorpayContact` strips formatting, validates E.164 (`^\+?[1-9]\d{9,14}$`), and rejects 10+ identical consecutive digits (`9999999999`) because Razorpay test mode rejects repeated-digit phone numbers with an opaque modal error (#717).
- **`retry.max_count` Watch-Out**: Official Razorpay docs note that `retry.max_count` is **not supported on Web Standard Checkout** (it only works in Android/iOS SDKs).

---

## 4. Signature Verification Formula (`order_id|payment_id`)

> **CRITICAL:** One-time Orders and Subscriptions use **opposite** field ordering in their HMAC payload!

| Flow                                       | HMAC-SHA256 Payload String                            | Secret                                                     |
| ------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------- |
| **One-Time Order** _(used in this repo)_   | `${razorpay_order_id}\|${razorpay_payment_id}`        | `RAZORPAY_SECRET` (API Key Secret, **not** Webhook Secret) |
| **Subscription** _(not used in this repo)_ | `${razorpay_payment_id}\|${razorpay_subscription_id}` | `RAZORPAY_SECRET`                                          |

### Safe Verification Pattern (`app/api/checkout/verify-signature/route.ts`)

```ts
const expectedSignature = crypto
  .createHmac("sha256", keySecret)
  .update(`${razorpay_order_id}|${razorpay_payment_id}`)
  .digest("hex");

const sigBuf = Buffer.from(razorpay_signature, "hex");
const expectedBuf = Buffer.from(expectedSignature, "hex");

if (
  sigBuf.length !== expectedBuf.length ||
  !crypto.timingSafeEqual(sigBuf, expectedBuf)
) {
  return NextResponse.json(
    { verified: false, error: "Invalid payment signature" },
    { status: 400 },
  );
}
```

### Why Signature Verification Alone Is Not Enough

1. **The signature covers only `(order_id, payment_id)`** — it says nothing about the captured `amount`, `notes`, or whether the payment is `"captured"` vs still `"authorized"`.
2. Therefore, `/api/checkout/verify-signature` fetches the authoritative payment from Razorpay (`await razorpayClient.payments.fetch(razorpay_payment_id)`), parses it through `razorpayFetchedPaymentSchema`, verifies `gatewayPayment.status === "captured"`, and passes `gatewayPayment.amount` and `gatewayPayment.notes` into `routeCapturedPayment`.
3. Inside `handlePaymentSuccess`, the **capture-amount parity check** verifies that `capturedAmountPaise === payment.amount` before confirming the booking or crediting any wallet/invoice.

---

## 5. `payment.captured` vs `order.paid`

Razorpay emits **both** `payment.captured` and `order.paid` when an order is paid (`order.paid` is the only `order.*` webhook event in Razorpay).

- `payment.captured` carries `payload.payment.entity` (`id: "pay_..."`, `order_id: "order_..."`, `amount`, `notes`).
- `order.paid` carries `contains: ["payment", "order"]` with **both** `payload.order.entity` and `payload.payment.entity` (#1582 F-P0-01).
- In [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts), both events call `routeCapturedPayment`. Because `routeCapturedPayment` is idempotent on `Payment.paymentIntent` / `WalletEntry` / `OrganizationInvoice` / `RecordingPurchase`, receiving both events (plus the client `/api/checkout/verify-signature` call) is completely safe.

---

## 6. Cancelling / Expiring Abandoned Orders (`cancelRazorpayOrder`)

Razorpay Orders have **no cancel endpoint** (`orders` remain in `created` or `attempted` indefinitely if unpaid).

- When `scripts/payments/cleanup-abandoned-payments.ts` sweeps expired `PENDING` payments, it calls `cancelRazorpayOrder(orderId)` in [`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts).
- `cancelRazorpayOrder` calls `razorpayClient.orders.fetchPayments(orderId)` and checks whether any payment on the order has `status === "authorized"` or `"captured"`.
- Only when `cancelRazorpayOrder` returns `"no_live_payment"` does the sweeper expire the `Payment` row and release the slot hold (#1861 L2).

---

## 7. GST & Tax Invoicing Note

- Our checkout pricing (`determineTax` in [`lib/payments/tax/tax-engine.ts`](../../../../../lib/payments/tax/tax-engine.ts), SAC `999293`) adds **18% GST** on top of the base price for Indian buyers (and for non-Indian buyers when `hasValidPlatformLut()` is `false`), or charges **0% GST** for international exports under a valid platform LUT (`buyerCountry !== "IN"` with `hasValidPlatformLut()`). Never back-calculate GST from a gross total with `amount / 1.18`.
- **Never use `razorpay.invoices.create()` (`POST /v1/invoices`) for GST invoices**: official Razorpay docs explicitly state _"You can only create non-GST Invoices via APIs"_ (`tax_rate`, `sac_code`, `hsn_code` cannot be set via API). See [`gst-invoicing.md`](gst-invoicing.md).
