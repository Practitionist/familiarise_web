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

| File                                                                                                                                                                      | Responsibility                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`lib/payments/core/razorpay.ts`](../../../../../lib/payments/core/razorpay.ts)                                                                                           | `postRefund` (raw `fetch` with `X-Refund-Idempotency` and HTTP 409 conflict handling), `capturedPaymentIdOfOrder`, `createRazorpayRefund`, `getRazorpayRefund`, `listRazorpayRefunds`, `listRazorpayRefundsCreatedBetween`, `isRazorpayUnknownRefundIdError`, `isRazorpayUnknownOrderError`.                                            |
| [`lib/payments/operations/refund.ts`](../../../../../lib/payments/operations/refund.ts)                                                                                   | Two-phase refund reservation (`pending_<uuid>`), `applyRefundCascade` (ledger reversal, `ConsultantEarnings` / `OrganizationEarnings` CAS clawback, TDS 194-O reversal, GST `CreditNote` minting).                                                                                                                                      |
| [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts) & [`app/api/webhooks/utils.ts`](../../../../../app/api/webhooks/utils.ts) | Routes `refund.created`, `refund.processed`, `refund.failed`, and `refund.speed_changed`. Resolves `payment_id` (`pay_...`) → `order_id` (`order_...`) via `Payment.gatewayPaymentId` index and executes `handleRefundCreated` with placeholder adoption (`pending_<uuid>`) via `notes.reservationId` and before-capture `DeferSignal`. |
| [`scripts/refunds/reconcile-pending-refunds.ts`](../../../../../scripts/refunds/reconcile-pending-refunds.ts)                                                             | Three-pass refund reconciler: (1) binds/retires `pending_<uuid>` placeholders via `notes.reservationId`, (2) polls real `rfnd_...` `PENDING` rows via `getRefund`, (3) replays stranded `SUCCEEDED` rows with `cascadedAt: null`.                                                                                                       |

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
   - **Caller contract**: We pass `Refund.id` (the Prisma row ID created in Phase 1) as `idempotencyKey` and embed `metadata: { reservationId: Refund.id }` (serialized on Razorpay as `notes.reservationId`). `postRefund` validates `IDEMPOTENCY_KEY_PATTERN` and fails closed (`REFUND_IDEMPOTENCY_KEY_INVALID`).
2. **Duplicate Request Behavior & Two Distinct `409 Conflict` Cases**:
   - **Completed duplicate (same key + same body)**: Returns `200 OK` with the original refund entity.
   - **In-flight concurrent duplicate (`409 Conflict`)**: `"Another request with the same idempotency key is still in progress."` `postRefund` waits `1,000 ms` and retries once so a race resolves to the original refund.
   - **Payload mismatch (`409 Conflict`)**: `"Different request with the same idempotency key has already been processed."` Retrying will never succeed; `postRefund` immediately throws `RefundError(..., "REFUND_IDEMPOTENCY_KEY_REUSED")`.
3. **`receipt` Field Quirk**:
   - If `receipt` is passed on `POST /v1/payments/:id/refund`, Razorpay treats `receipt` as an additional idempotency key scoped to that `payment_id` and rejects duplicates with `400 BAD_REQUEST_ERROR`.
   - **Where we send one**: only the late-capture refund in `handlePaymentSuccess` (`lateCaptureRefundKeys`), as `late_capture_<pay_id>` alongside `Refund.dedupeKey` `late-capture:<pay_id>`, so the webhook, `reconcile-payment-status` and the Request-again re-check converge on one refund. A duplicate is a definitive refusal (`BAD_REQUEST_ERROR`), so the second reservation is marked `FAILED` and moves no money. The header stays the reservation id: keyed on the payment id, a retry after a definitive refusal would carry a new `notes.reservationId` and hit the payload-mismatch `409` for good.

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

| Field             | Where It Appears                              | Valid Values                             | Meaning                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `speed`           | Request body (`POST /v1/payments/:id/refund`) | `"normal"` \| `"optimum"`                | `"normal"` (default): 5–7 working days, no refund fee. `"optimum"`: attempts Instant Refund (IMPS/NEFT/UPI) for a fee; falls back to `"normal"` if unsupported. **Passing `"instant"` in the request fails with `400 BAD_REQUEST_ERROR`!** |
| `speed_requested` | Refund entity response & webhook              | `"normal"` \| `"optimum"`                | Echoes requested mode. Never `"instant"`.                                                                                                                                                                                                  |
| `speed_processed` | Refund entity response & webhook              | `"normal"` \| `"instant"` \| `"optimum"` | Actual execution rail (`"optimum"` may echo transiently before bank rail downgrade); triggers `refund.speed_changed` when `"optimum"` falls back to `"normal"` (persisted on `Refund.metadata`).                                           |

---

## 6. Two-Phase Reservation, Placeholder Adoption & 3-Pass Reconciliation

### Two-Phase Reservation & Placeholder Adoption (`handleRefundCreated`)

1. **Phase 1 (Serializable DB Tx)**: Validates remaining refundable balance and creates a `Refund` row with `status: PENDING` and `refundId: "pending_<uuid>"`.
2. **Phase 2 (External Gateway Call)**: Calls `createRazorpayRefund` with `idempotencyKey = Refund.id` and `metadata: { reservationId: Refund.id }` (persisted by Razorpay in `refund.entity.notes.reservationId`).
3. **Placeholder Adoption on Webhook Race (`handleRefundCreated`)**:
   - Because Razorpay frequently fires `refund.created` / `refund.processed` **before** the post-gateway bind step of the outbound HTTP call finishes writing `rfnd_...` (or when that final DB update crashes after Razorpay accepts the request), inserting a fresh `Refund` row on the webhook would leave both `pending_<uuid>` and `rfnd_...` in Postgres — double-counting refunded paise against the payment's refundable ceiling!
   - Inside its Serializable transaction (`tx`), `handleRefundCreated` checks `notes?.reservationId` (`where: { id: reservationId, paymentId: payment.id, amount: refundAmountPaise, refundId: { startsWith: "pending_" } }`) before creating any new record. When a matching `pending_<uuid>` placeholder exists, `handleRefundCreated` adopts that reservation row directly by updating `refundId = rfnd_...`, advancing `status` via CAS, and executing `applyRefundCascade(tx, ...)` atomically under `PG_POOL_MAX=1`.
4. **Out-of-Order Before-Capture Deferral (`DeferSignal`)**:
   - If `refund.created` or `refund.processed` arrives before `payment.captured` writes the `Payment` row, `handleRefundCreated` returns `new DeferSignal(...)` so `sweep-stuck-webhook-events` replays it cleanly once capture settles.

### 3-Pass Reconciler (`scripts/refunds/reconcile-pending-refunds.ts`)

1. **Pass 1 (`pending_<uuid>` Placeholders > 1h old)**: Pages through the refunds of the captured gateway payment (`count: 100`, `skip`, at most 5 pages) and binds only on `gr.metadata?.reservationId === refund.id` (or deletes the placeholder on `P2002` if a concurrent webhook already bound it). A placeholder is marked `FAILED` only when it is over 24h old, the listing ended on a short page with no match and no same-amount refund without a note, and `payments.fetch` of the captured payment under the same keys returns it as `captured`.
2. **Pass 2 (Real `rfnd_...` `PENDING` Rows > 1h old)**: Polls `getRazorpayRefund(refund.refundId)` without artificial local aging while bank rails report `"pending"`; marks `FAILED` only on gateway `"failed"`.

An unknown-id or 404 answer (`isRazorpayUnknownRefundIdError`, `isRazorpayUnknownOrderError`) never fails a row in either pass, because an id of the other key mode gets the same answer: the row stays `PENDING` and the run raises one standing finding.

3. **Pass 3 (`redriveStrandedRefunds`)**: Replays `SUCCEEDED` rows with `cascadedAt: null` (>10 min old) through `applyRefundCascade`.
4. **Discovery pass (`discoverGatewayRefunds`, `lib/payments/discovery/refund-discovery.ts`)**: lists the account's refunds created since the job's checkpoint (section 7) and hands each one with no `Refund` row under its gateway id to `handleRefundCreated`, so a dashboard refund or one whose webhook was lost is imported as its webhook would have imported it. It never hands over a gateway-`failed` refund and never creates a refund. `docs/finance/30-refunds-disputes/01-refunds.md` has the window, bounds and reporting.

---

## 7. Listing Every Refund on the Account (`GET /v1/refunds`)

Read from `node_modules/razorpay` 2.9.8 (`dist/resources/refunds.js`, `dist/types/refunds.d.ts`) on 2026-11-27. Nothing here has been checked against the gateway.

`listRazorpayRefundsCreatedBetween` (`lib/payments/core/razorpay.ts`), read by the discovery pass above, calls `refunds.all({ from, to, count, skip })` behind `withRazorpaySdkTimeout` and parses each item with `razorpayListedRefundPageSchema`; one malformed item rejects the page.

| Point                   | What the SDK shows                                                                                                                                                    | Not shown anywhere we can read                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Request                 | `GET /v1/refunds` with `from`, `to`, `count`, `skip` (all four are sent).                                                                                             | Whether `to` is inclusive.                                                   |
| Page size               | `count` defaults to 10; the shared pagination type says the maximum is 100.                                                                                           | Whether a larger `count` is refused or clamped.                              |
| Time filter             | `from` and `to` are Unix seconds "from when data are to be fetched". The entity's only time is `created_at`.                                                          | That the filter is on `created_at`.                                          |
| Ordering                | Nothing.                                                                                                                                                              | The order of `items`. Callers page a fixed window by `skip` and assume none. |
| Listed entity           | `id`, `payment_id`, `amount`, `currency`, `status` (`pending`, `processed`, `failed`), `notes`, `receipt`, `created_at`, `speed_requested`, `speed_processed`.        | Whether a refund of a payment that was never captured is listed.             |
| Missing from the entity | No `order_id` and no `captured` flag for the payment, both of which a refund webhook's embedded payment carries. A caller that needs them reads `payments.fetch(id)`. |                                                                              |

---

## Deprecated & Superseded Approaches

- **Creating a Separate `rfnd_...` Row in `handleRefundCreated` Without Checking `notes.reservationId`**: Superseded by direct adoption of `pending_<uuid>` rows (`notes.reservationId === Refund.id`), eliminating duplicate `Refund` records and false over-refund ceiling violations during webhook-before-HTTP-return races.
- **Throwing on Refund-Before-Capture Arrival**: Superseded by `DeferSignal` so early refund webhooks wait cleanly for `payment.captured` rather than recording false processing errors.
