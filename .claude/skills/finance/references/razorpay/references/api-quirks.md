# Razorpay API & `razorpay-node` v2.9.6 Quirks (Verified)

Every quirk in this file has been verified against either `node_modules/razorpay` (v2.9.6), our production codebase (`lib/payments/`), or official Razorpay documentation (`https://razorpay.com/docs/`).

---

## 1. `razorpay-node` v2.9.6 SDK Quirks

### 1.1 Custom Headers Are Silently Stripped (`getValidHeaders()`)
In `node_modules/razorpay/dist/api.js`, `getValidHeaders()` whitelists **only** `X-Razorpay-Account` and `Content-Type`:
- Passing `X-Refund-Idempotency` or `X-Payout-Idempotency` via `new Razorpay({ headers: ... })` or per-call options is **silently dropped**.
- Furthermore, `razorpay.payments.refund(paymentId, params)` does not accept a `headers` parameter at all.
- **How we handle it**: Both `postRefund` in [`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts) and `RazorpayPayoutsService` in [`lib/payments/payouts/razorpay-payouts.ts`](../../../../../lib/payments/payouts/razorpay-payouts.ts) use native `fetch` against `https://api.razorpay.com/v1` with Basic Auth (`Buffer.from("${keyId}:${keySecret}").toString("base64")`).

### 1.2 No Built-in Request Timeout in `razorpay-node`
`razorpay-node` exposes no socket or request timeout option. A hung connection to `api.razorpay.com` would stall an `after()` webhook callback or a cron job indefinitely.
- **How we handle it**:
  - All SDK calls in `lib/payments/core/razorpay.ts` are wrapped in `withRazorpaySdkTimeout(op, call, 30_000)` (`ensureRazorpayCustomer` uses `8_000` ms because it runs under the checkout slot lock).
  - All raw `fetch` calls (`postRefund`, `razorpay-disputes.ts`, `razorpay-payouts.ts`) pass `signal: AbortSignal.timeout(...)`.
  - `withRazorpaySdkTimeout` also runs through the Redis circuit breaker (`getRazorpayCircuitBreaker`), using `shouldTripRazorpayCircuitBreaker` so `4xx` client/validation errors (except `429`) **never** trip the breaker (#697 INF-3).

### 1.3 `BAD_REQUEST_ERROR` Covers Almost Every 4xx Condition
Razorpay returns `error.code === "BAD_REQUEST_ERROR"` for:
- Invalid/expired API credentials (`HTTP 401`)
- Unknown `order_...`, `rfnd_...`, or `disp_...` IDs (`HTTP 400`, `reason: "input_validation_failed"`) — Razorpay often returns **HTTP 400 instead of HTTP 404** when looking up an ID it has never seen or a test-mode ID queried with live keys!
- Duplicate `receipt` or invalid `notes` / `amount` (`HTTP 400`)
- Idempotency key payload mismatch (`HTTP 409`)

**How we handle it (`handleRazorpayError` in `lib/payments/core/razorpay.ts`, `#1437`)**:
- Never report every `BAD_REQUEST_ERROR` as `"Authentication failed"`. Only treat it as `AUTH_ERROR` when `statusCode === 401` or `/authentic/i.test(description || reason)`.
- Use `isRazorpayUnknownRefundIdError`, `isRazorpayUnknownDisputeIdError`, and `isUnknownOrderId` in reconcilers to distinguish terminal unknown IDs (`400 input_validation_failed` / `404`) from transient gateway errors (`5xx` / `429`).

### 1.4 `error` Envelope Can Arrive as `{ error: undefined }` (`#1353`)
Checking `"error" in err` on a failed SDK/HTTP response is unsafe because `{ error: undefined }` satisfies `"error" in err` and then throws a `TypeError` when reading `err.error.code`. Always use `readRazorpayErrorBody(error)` which guards `typeof body === "object" && body !== null`.

---

## 2. Orders, Checkout & Payments API Quirks

### 2.1 Empty `notes` Returns `[]` (Empty Array), Not `{}`
When an Order or Payment has no notes, Razorpay's API returns `"notes": []` (an empty JSON array) rather than `"notes": {}`, and may echo numeric or boolean values if set externally.
- **How we handle it**: `razorpayFetchedPaymentSchema` in [`schemas/webhooks/razorpay.ts`](../../../../../schemas/webhooks/razorpay.ts) accepts `z.array(z.never()).transform(() => ({}))` and coerces `string | number | boolean` values to `String`.

### 2.2 `notes` and `receipt` Hard Limits
- **`notes`**: Maximum **15 key-value pairs**, maximum **256 characters** per key and per value (`https://razorpay.com/docs/api/understand/#notes`).
- **`receipt`**: Maximum **40 ASCII characters**, must be unique per order (`https://razorpay.com/docs/api/orders/create/`). Razorpay treats `receipt` as an idempotency key on both Orders (`POST /v1/orders`) and Refunds (`POST /v1/payments/:id/refund`), rejecting duplicates with `400 BAD_REQUEST_ERROR`.

### 2.3 Official Doc Discrepancy: Uncaptured Payment Auto-Refund Window (3 Days vs. 5 Days / `7200` Min)
Razorpay's own official documentation contains two different figures for how long an `authorized` payment can remain uncaptured before Razorpay auto-refunds it:
- [Payment Life Cycle (`/docs/payments/payments/`)](https://razorpay.com/docs/payments/payments/) and [Dashboard Capture Settings (`/docs/payments/payments/capture-settings/`)](https://razorpay.com/docs/payments/payments/capture-settings/) state **3 days**.
- [Configure Capture Settings Using Orders API (`/docs/payments/payments/capture-settings/api/`)](https://razorpay.com/docs/payments/payments/capture-settings/api/) states **5 days (`7200` minutes)** as both the default and maximum for `manual_expiry_period` (with a **12-minute** minimum for `automatic_expiry_period`).
- **How we handle it (`holdCaptureSettings` in `lib/payments/core/razorpay.ts`)**: We configure per-order `payment.capture = "automatic"` with `automatic_expiry_period` and `manual_expiry_period` clamped between `MIN_CAPTURE_WINDOW_MINUTES = 12` and `MAX_CAPTURE_WINDOW_MINUTES = 7200` sized to the slot hold (`holdExpiresAt`), so slow authorizations after a slot hold expires are automatically voided/refunded by Razorpay (#1861 L1).

### 2.4 UPI In-App Retry: `payment.failed` Followed by `payment.captured` on the Same `pay_...`
In UPI apps (Google Pay, PhonePe, Paytm), a user whose first PIN/bank attempt fails can tap "Retry" **inside the UPI app** on the same payment request.
- Razorpay emits `payment.failed` first, and if the in-app retry succeeds a minute later, emits `payment.captured` for the **same `order_id` (and `payment_id`)**.
- **Rule**: `handlePaymentFailure` must never permanently delete the `Payment` row or prevent a subsequent `payment.captured` webhook from confirming the payment if the slot is still available (or triggering an automatic refund if the slot was already taken).

### 2.5 Test Mode Rejects Repeated-Digit Phone Numbers (`9999999999`)
Passing `prefill.contact: "9999999999"` or `"+919999999999"` into Standard Checkout in Test Mode causes Razorpay's backend to reject the payment attempt with an opaque `"Invalid mobile number"` error inside the modal.
- **How we handle it**: `normalizeRazorpayContact` in [`lib/payments/razorpay-prefill.ts`](../../../../../lib/payments/razorpay-prefill.ts) strips any phone number matching `/(\d)\1{9,}/` before passing `prefill.contact` (#717). Use `9876543210` in tests and docs.

### 2.6 `retry.max_count` Does Not Work on Web Checkout
In [Standard Checkout Options](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/), Razorpay explicitly warns: *"Web Integration does not support the `max_count` parameter. It is applicable only in Android and iOS SDKs."* Only `retry.enabled: boolean` works on web.

---

## 3. Refunds, Disputes & RazorpayX Quirks

### 3.1 Refund `speed` vs `speed_requested` vs `speed_processed`
- Request parameter `speed` and response field `speed_requested` only ever use `"normal"` or `"optimum"`. Passing `speed: "instant"` in a refund request fails with `400 BAD_REQUEST_ERROR`!
- Response field `speed_processed` reports `"normal"` or `"instant"` (though Razorpay's mock JSON examples on `/docs/api/refunds/fetch-all/` also show `"optimum"`, so type schemas should accept `"normal" | "instant" | "optimum"`).

### 3.2 Refund Omitting `amount` Refunds 100% of the Payment
On `POST /v1/payments/:id/refund`, `amount` is optional. If `amount` is `undefined`, Razorpay issues a **full refund**. Never write `amount: amount || undefined` (`createRazorpayRefund` requires `Number.isSafeInteger(amount) && amount > 0`, `#1584`).

### 3.3 RazorpayX `X-Payout-Idempotency` Is Bounded to 4–36 Characters
Whereas `X-Refund-Idempotency` requires `>= 10` characters of `[A-Za-z0-9_-]`, RazorpayX's `X-Payout-Idempotency` (mandatory since 15 March 2025) requires **4 to 36 characters** of `[A-Za-z0-9 _-]` and rejects longer keys with HTTP 400. Always pass payout idempotency keys through `boundPayoutIdempotencyKey()` (`lib/payments/payouts/razorpay-payouts.ts`).

### 3.4 RazorpayX Payout `purpose` Uses Spaces (`"vendor bill"`), Not Underscores
RazorpayX's built-in system purposes are `"refund"`, `"cashback"`, `"payout"`, `"salary"`, `"utility bill"`, and `"vendor bill"`. Passing `"vendor_bill"` or `"utility_bill"` fails unless a custom purpose with an underscore was manually created in the RazorpayX Dashboard.

### 3.5 RazorpayX `payout.initiated` Means `status: "processing"`
RazorpayX does **not** have a `payout.processing` webhook event name. When a payout transitions to `status: "processing"`, RazorpayX fires **`payout.initiated`**. Also, top-level `failure_reason` on the payout entity is deprecated in favor of `status_details: { description, source, reason }`.

### 3.6 RazorpayX Account Validation `status: "completed"` Can Mean `"invalid"`
On `POST /v1/fund_accounts/validations` (and `fund_account.validation.completed` webhooks), `status: "completed"` only means the bank check finished — an invalid bank account still returns `status: "completed"` with `results.account_status: "invalid"`. Always check `summariseFundAccountValidation(raw).accountStatus === "valid"`.
