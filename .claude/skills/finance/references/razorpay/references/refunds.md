# Razorpay Refunds — Raw HTTP Idempotency, Two-Phase Reservation & Reconciliation

Official citations:
- [Refunds API Overview](https://razorpay.com/docs/payments/refunds/apis/)
- [Create a Normal Refund (`POST /v1/payments/:id/refund`)](https://razorpay.com/docs/api/refunds/create-normal/)
- [Create an Instant Refund (`speed: "optimum"`)](https://razorpay.com/docs/api/refunds/create-instant/)
- [Idempotent Normal Refunds (`X-Refund-Idempotency`)](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/)
- [Idempotent Instant Refunds (`X-Refund-Idempotency`)](https://razorpay.com/docs/api/refunds/instant-refunds-idempotent/)
- [Refund Entity & Speed Fields](https://razorpay.com/docs/api/refunds/entity/)
- [Refund Webhooks](https://razorpay.com/docs/webhooks/refunds/)

## Where It Lives in This Repo

| File | Responsibility |
|---|---|
| [`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts) | `postRefund` (raw `fetch` with `X-Refund-Idempotency` and HTTP 409 conflict handling), `capturedPaymentIdOfOrder`, `createRazorpayRefund`, `getRazorpayRefund`, `listRazorpayRefunds`, `isRazorpayUnknownRefundIdError`, `isRazorpayUnknownOrderError`. |
| [`lib/payments/operations/refund.ts`](../../../../../lib/payments/operations/refund.ts) | Two-phase refund reservation (`pending_<uuid>`), `applyRefundCascade` (ledger reversal, `ConsultantEarnings` / `OrganizationEarnings` CAS clawback, TDS 194-O reversal, GST `CreditNote` minting). |
| [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts) | Routes `refund.created`, `refund.processed`, `refund.failed`, and `refund.speed_changed`. Resolves `payment_id` (`pay_...`) → `order_id` (`order_...`) via `Payment.gatewayPaymentId` index before calling `handleRefundCreated`. |
| [`scripts/refunds/reconcile-pending-refunds.ts`](../../../../../scripts/refunds/reconcile-pending-refunds.ts) | Three-pass refund reconciler: (1) binds/retires `pending_<uuid>` placeholders via `notes.reservationId`, (2) polls real `rfnd_...` `PENDING` rows via `getRefund`, (3) re-drives stranded `SUCCEEDED` rows with `cascadedAt: null`. |

---

## 1. Why `postRefund` Uses Raw `fetch` Instead of `razorpay-node`

Every refund request must be idempotent so a network timeout or retry never refunds the buyer twice. Razorpay supports the `X-Refund-Idempotency` HTTP header on `POST /v1/payments/:id/refund`, **but `razorpay-node` v2.9.6 cannot send it**:
- In `node_modules/razorpay/dist/api.js`, `getValidHeaders()` whitelists **only** `X-Razorpay-Account` and `Content-Type` and silently strips every other header.
- Furthermore, `payments.refund(paymentId, params)` in `razorpay-node` has no `headers` parameter.

Therefore, `postRefund` in [`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts) calls `fetch("https://api.razorpay.com/v1/payments/${paymentId}/refund")` directly with Basic Auth, `AbortSignal.timeout(30_000)`, and `X-Refund-Idempotency`.

---

## 2. Verified `X-Refund-Idempotency` Rules & HTTP 409 Handling

From [Official Razorpay Idempotent Refunds Docs](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/):

1. **Key Format (`IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{10,}$/`)**:
   - **Minimum length**: **10 characters** (shorter keys fail with `400 BAD_REQUEST_ERROR: "The idempotency key must be at least 10 characters long."`).
   - **Allowed characters**: **Alphanumeric (`A-Za-z0-9`), hyphens (`-`), and underscores (`_`) only** (`"The idempotency key must only contain alphanumeric characters, underscores and hyphens."`).
   - **Our caller contract (`#1352`)**: We pass `Refund.id` (the Prisma row UUID/CUID created in Phase 1) as `idempotencyKey`. `postRefund` validates `IDEMPOTENCY_KEY_PATTERN` and fails closed (`REFUND_IDEMPOTENCY_KEY_INVALID`) rather than stripping invalid characters or omitting the header.
2. **Duplicate Request Behavior & Two Distinct `409 Conflict` Cases (`#1451`)**:
   - **Completed duplicate (same key + same body)**: Returns `200 OK` with the original refund entity.
   - **In-flight concurrent duplicate (`409 Conflict`)**: `"Another request with the same idempotency key is still in progress."` `postRefund` waits `1,000 ms` and retries once so a race resolves to the original refund.
   - **Payload mismatch (`409 Conflict`)**: `"Different request with the same idempotency key has already been processed."` Retrying will never succeed; `postRefund` immediately throws `RefundError(..., "REFUND_IDEMPOTENCY_KEY_REUSED")`.
3. **Bonus Official Quirk — `receipt` Also Acts as an Idempotency Key**:
   - Official docs (`https://razorpay.com/docs/api/refunds/create-normal/`) state that if `receipt` is passed on `POST /v1/payments/:id/refund`, Razorpay treats `receipt` as an idempotency key scoped to that `payment_id` and rejects duplicate `receipt` values with `400 BAD_REQUEST_ERROR`.

---

## 3. Resolving `order_id` ↔ `payment_id` (`capturedPaymentIdOfOrder`)

Razorpay refunds are created against a **Payment ID (`pay_...`)**, whereas `Payment.paymentIntent` stores the **Order ID (`order_...`)** (except for duplicate-capture overflow rows, which store `pay_...` directly).

- **Outbound (`createRazorpayRefund`)**:
  - If `paymentIntentId.startsWith("pay_")`, refunds that exact `pay_...` ID.
  - Otherwise, calls `capturedPaymentIdOfOrder(razorpayClient, orderId)` (`razorpayClient.orders.fetchPayments(orderId)`) and selects `payments.items.find((p) => p.status === "captured")`.
  - **Never fall back to `payments.items[0]`**: an order can have failed payment attempts before the captured one!
- **Inbound Webhooks (`refund.created`, `refund.processed`, `refund.failed`)**:
  - Webhook payloads only carry `payload.refund.entity.payment_id` (`pay_...`), not `order_id`.
  - `razorpay-dispatch.ts` queries `prisma.payment.findFirst({ where: { gatewayPaymentId: refundEvent.payment_id } })` first (#1353), falling back to `razorpayClient.payments.fetch(refundEvent.payment_id)` only for legacy rows missing `gatewayPaymentId`.

---

## 4. Partial vs. Full Refund Guard (`#1584 P2-P0-01`)

On `POST /v1/payments/:id/refund`, **omitting `amount` refunds the ENTIRE payment**.
- Never write `amount: amount || undefined` — if `amount` is `0` or `NaN`, `|| undefined` silently promotes it to a 100% full refund!
- `createRazorpayRefund` enforces:
  ```ts
  if (amount === undefined || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new RefundError(
      `Refund amount must be a positive whole number of paise (got ${String(amount)})`,
      "INVALID_AMOUNT",
      "RAZORPAY",
    );
  }
  ```

---

## 5. Refund `speed`, `speed_requested`, and `speed_processed`

From [Official Razorpay Refund Entity Docs](https://razorpay.com/docs/api/refunds/entity/):

| Field | Where It Appears | Valid Values | Meaning |
|---|---|---|---|
| `speed` | Request body (`POST /v1/payments/:id/refund`) | `"normal"` \| `"optimum"` | `"normal"` (default): 5–7 working days, no refund fee. `"optimum"`: attempts Instant Refund (IMPS/NEFT/UPI) for a small fee; automatically falls back to `"normal"` if unsupported. **Passing `"instant"` in the request fails with `400 BAD_REQUEST_ERROR`!** |
| `speed_requested` | Refund entity response & webhook | `"normal"` \| `"optimum"` | Echoes the requested mode. Never `"instant"`. |
| `speed_processed` | Refund entity response & webhook | `"normal"` \| `"instant"` *(mock JSON in docs also shows `"optimum"`)* | How the refund was actually processed. If `speed_requested` was `"optimum"` and instant rail was unavailable, `speed_processed` becomes `"normal"` and `refund.speed_changed` webhook fires. |

### Refund Fee Policy (Verified)
- **Original Gateway Fee Is Non-Refundable**: When a payment is refunded (normal or instant), Razorpay **does not return** the original ~2% + 18% GST gateway capture fee.
- **Instant Refund Fee**: `speed: "optimum"` charges an additional instant-refund fee deducted from the merchant balance (credited back if instant refund falls back to normal 5–7 day processing). Our platform uses default `"normal"` speed (`postRefund` omits `speed`).

---

## 6. Two-Phase Refund Reservation & 3-Pass Reconciliation

### Two-Phase Reservation (`lib/payments/operations/refund.ts`)
1. **Phase 1 (Serializable DB Tx)**: Checks refundable balance, inserts a `Refund` row with `status: PENDING` and `refundId: "pending_<uuid>"`, saving the row's primary key `Refund.id`.
2. **Phase 2 (External HTTP Call)**: Calls `createRazorpayRefund` with `idempotencyKey = Refund.id` and `metadata: { reservationId: Refund.id, ... }`.
3. **Phase 3 (DB Finalization)**: Binds the returned `rfnd_...` ID onto the `Refund` row; once `status === "processed"` (either synchronously or via `refund.processed` webhook), runs `applyRefundCascade` inside a `Serializable` transaction.

### 3-Pass Reconciler (`scripts/refunds/reconcile-pending-refunds.ts`)
1. **Pass 1 (`pending_<uuid>` Placeholders > 1h old)**:
   - Calls `listRefunds(paymentIntent)` (`razorpayClient.payments.fetchMultipleRefund`).
   - Matches by `gr.metadata?.reservationId === refund.id` (or unambiguous single-amount fallback for pre-#676 rows).
   - If matched, binds `rfnd_...` (handling `P2002` if the webhook already inserted the `rfnd_...` row by deleting the superseded placeholder).
   - If no match exists at the gateway after **24 hours**, transitions the placeholder to `FAILED` so the refundable balance is restored.
2. **Pass 2 (Real `rfnd_...` `PENDING` Rows > 1h old)**:
   - Polls `getRazorpayRefund(refund.refundId)` (`razorpayClient.refunds.fetch`).
   - **Never ages out locally** while Razorpay still reports `"pending"` (normal bank refunds take 5–7 business days).
   - Only marks `FAILED` if Razorpay reports `"failed"` or returns `400 BAD_REQUEST_ERROR` / `input_validation_failed` (`isRazorpayUnknownRefundIdError`).
3. **Pass 3 (`redriveStrandedRefunds`)**:
   - Finds `Refund` rows with `status = 'SUCCEEDED' AND cascadedAt IS NULL` (>10 min old, up to 3 attempts) and re-drives `applyRefundCascade`.
