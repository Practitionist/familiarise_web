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

| File                                                                                                                                                                      | Responsibility                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts)                                                                                           | `postRefund` (raw `fetch` with `X-Refund-Idempotency` and HTTP 409 conflict handling), `capturedPaymentIdOfOrder`, `createRazorpayRefund`, `getRazorpayRefund`, `listRazorpayRefunds`, `isRazorpayUnknownRefundIdError`, `isRazorpayUnknownOrderError`.                                                                                           |
| [`lib/payments/operations/refund.ts`](../../../../../lib/payments/operations/refund.ts)                                                                                   | Two-phase refund reservation (`pending_<uuid>`), `applyRefundCascade` (ledger reversal, `ConsultantEarnings` / `OrganizationEarnings` CAS clawback, TDS 194-O reversal, GST `CreditNote` minting).                                                                                                                                                |
| [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts) & [`app/api/webhooks/utils.ts`](../../../../../app/api/webhooks/utils.ts) | Routes `refund.created`, `refund.processed`, `refund.failed`, and `refund.speed_changed`. Resolves `payment_id` (`pay_...`) → `order_id` (`order_...`) via `Payment.gatewayPaymentId` index and executes `handleRefundCreated` with in-place `pending_<uuid>` placeholder adoption via `metadata.reservationId` and before-capture `DeferSignal`. |
| [`scripts/refunds/reconcile-pending-refunds.ts`](../../../../../scripts/refunds/reconcile-pending-refunds.ts)                                                             | Three-pass refund reconciler: (1) binds/retires `pending_<uuid>` placeholders via `notes.reservationId`, (2) polls real `rfnd_...` `PENDING` rows via `getRefund`, (3) re-drives stranded `SUCCEEDED` rows with `cascadedAt: null`.                                                                                                               |

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
   - **Allowed characters**: **Alphanumeric (`A-Za-z0-9`), hyphens (`-`), and underscores (`_`) only**.
   - **Caller contract**: We pass `Refund.id` (the Prisma row ID created in Phase 1) as `idempotencyKey` and embed `metadata: { reservationId: Refund.id }` (`notes.reservationId` on Razorpay). `postRefund` validates `IDEMPOTENCY_KEY_PATTERN` and fails closed (`REFUND_IDEMPOTENCY_KEY_INVALID`).
2. **Duplicate Request Behavior & Two Distinct `409 Conflict` Cases**:
   - **Completed duplicate (same key + same body)**: Returns `200 OK` with the original refund entity.
   - **In-flight concurrent duplicate (`409 Conflict`)**: `"Another request with the same idempotency key is still in progress."` `postRefund` waits `1,000 ms` and retries once so a race resolves to the original refund.
   - **Payload mismatch (`409 Conflict`)**: `"Different request with the same idempotency key has already been processed."` Retrying will never succeed; `postRefund` immediately throws `RefundError(..., "REFUND_IDEMPOTENCY_KEY_REUSED")`.
3. **`receipt` Field Quirk**:
   - If `receipt` is passed on `POST /v1/payments/:id/refund`, Razorpay treats `receipt` as an additional idempotency key scoped to that `payment_id` and rejects duplicates with `400 BAD_REQUEST_ERROR`.

---

## 3. Resolving `order_id` ↔ `payment_id` (`capturedPaymentIdOfOrder`)

Razorpay refunds are created against a **Payment ID (`pay_...`)**, whereas `Payment.paymentIntent` stores the **Order ID (`order_...`)**:

- **Outbound (`createRazorpayRefund`)**:
  - If `paymentIntentId.startsWith("pay_")`, refunds that exact `pay_...` ID.
  - Otherwise, calls `capturedPaymentIdOfOrder(razorpayClient, orderId)` (`razorpayClient.orders.fetchPayments(orderId)`) and selects `payments.items.find((p) => p.status === "captured")`. Never select `items[0]` blindly because failed checkout attempts share the same `order_id`.
- **Inbound Webhooks (`refund.created`, `refund.processed`, `refund.failed`)**:
  - Webhook payloads carry `payload.refund.entity.payment_id` (`pay_...`), not `order_id`.
  - `razorpay-dispatch.ts` queries `prisma.payment.findFirst({ where: { gatewayPaymentId: refundEvent.payment_id } })` first, calling `razorpayClient.payments.fetch(refundEvent.payment_id)` only as a fallback when `gatewayPaymentId` is unpopulated.

---

## 4. Partial vs. Full Refund Guard

On `POST /v1/payments/:id/refund`, **omitting `amount` refunds the ENTIRE payment**.

- Never write `amount: amount || undefined` — if `amount` is `0` or `NaN`, `|| undefined` promotes it to a 100% full refund.
- `createRazorpayRefund` strictly enforces `Number.isSafeInteger(amount) && amount > 0`.

---

## 5. Refund `speed`, `speed_requested`, and `speed_processed`

From [Official Razorpay Refund Entity Docs](https://razorpay.com/docs/api/refunds/entity/):

| Field             | Where It Appears                              | Valid Values              | Meaning                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `speed`           | Request body (`POST /v1/payments/:id/refund`) | `"normal"` \| `"optimum"` | `"normal"` (default): 5–7 working days, no refund fee. `"optimum"`: attempts Instant Refund (IMPS/NEFT/UPI) for a fee; falls back to `"normal"` if unsupported. **Passing `"instant"` in the request fails with `400 BAD_REQUEST_ERROR`!** |
| `speed_requested` | Refund entity response & webhook              | `"normal"` \| `"optimum"` | Echoes requested mode. Never `"instant"`.                                                                                                                                                                                                  |
| `speed_processed` | Refund entity response & webhook              | `"normal"` \| `"instant"` | Actual execution rail; triggers informational `refund.speed_changed` when `"optimum"` falls back to `"normal"`.                                                                                                                            |

---

## 6. Two-Phase Reservation, In-Place Webhook Adoption & 3-Pass Reconciliation

### Two-Phase Reservation & In-Place Placeholder Adoption (`handleRefundCreated`)

1. **Phase 1 (Serializable DB Tx)**: Validates remaining refundable balance and creates a `Refund` row with `status: PENDING` and `refundId: "pending_<uuid>"`.
2. **Phase 2 (External Gateway Call)**: Calls `createRazorpayRefund` with `idempotencyKey = Refund.id` and `metadata: { reservationId: Refund.id }` (persisted by Razorpay in `refund.entity.notes.reservationId`).
3. **In-Place Adoption on Webhook Race (`handleRefundCreated`)**:
   - Because Razorpay frequently fires `refund.created` / `refund.processed` **before** the post-gateway bind step of the outbound HTTP call finishes writing `rfnd_...` (or when that final DB update crashes after Razorpay accepts the request), inserting a fresh `Refund` row on the webhook would leave both `pending_<uuid>` and `rfnd_...` in Postgres — double-counting refunded paise against the payment's refundable ceiling!
   - Inside its Serializable transaction (`tx`), `handleRefundCreated` checks `refund.entity.notes?.reservationId` (and unambiguous `pending_%` rows matching `paymentId` + `amount`) before creating any new record. When a matching `pending_<uuid>` placeholder exists, `handleRefundCreated` **adopts it in place** by updating `refundId = rfnd_...`, advancing `status` via CAS, and executing `applyRefundCascade(tx, ...)` atomically under `PG_POOL_MAX=1`.
4. **Out-of-Order Before-Capture Deferral (`DeferSignal`)**:
   - If `refund.created` or `refund.processed` arrives before `payment.captured` writes the `Payment` row, `handleRefundCreated` returns `new DeferSignal(...)` so `sweep-stuck-webhook-events` re-drives it cleanly once capture settles.

### 3-Pass Reconciler (`scripts/refunds/reconcile-pending-refunds.ts`)

1. **Pass 1 (`pending_<uuid>` Placeholders > 1h old)**: Matches via `gr.metadata?.reservationId === refund.id`, binds `rfnd_...` (or deletes the placeholder on `P2002` if a concurrent webhook already bound it), and expires unmatched placeholders after 24h.
2. **Pass 2 (Real `rfnd_...` `PENDING` Rows > 1h old)**: Polls `getRazorpayRefund(refund.refundId)` without artificial local aging while bank rails report `"pending"`; marks `FAILED` only on gateway `"failed"` or `isRazorpayUnknownRefundIdError`.
3. **Pass 3 (`redriveStrandedRefunds`)**: Re-drives `SUCCEEDED` rows with `cascadedAt: null` (>10 min old) through `applyRefundCascade`.

---

## Deprecated & Superseded Approaches

- **Creating a Separate `rfnd_...` Row in `handleRefundCreated` Without Checking `metadata.reservationId`**: Superseded by in-place adoption of `pending_<uuid>` rows (`notes.reservationId === Refund.id`), eliminating duplicate `Refund` records and false over-refund ceiling violations during webhook-before-HTTP-return races.
- **Throwing on Refund-Before-Capture Arrival**: Superseded by `DeferSignal` so early refund webhooks wait cleanly for `payment.captured` rather than recording false processing errors.
