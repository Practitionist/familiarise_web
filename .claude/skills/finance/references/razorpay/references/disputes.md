# Razorpay Disputes — Webhooks, REST API, Evidence Upload & Ledger Settlement

Official citations:
- [Disputes Overview](https://razorpay.com/docs/payments/disputes/)
- [Disputes REST APIs Overview](https://razorpay.com/docs/payments/disputes/apis/)
- [Dispute Entity Schema](https://razorpay.com/docs/api/disputes/entity/)
- [Fetch a Dispute (`GET /v1/disputes/:id`)](https://razorpay.com/docs/api/disputes/fetch/)
- [Accept a Dispute (`POST /v1/disputes/:id/accept`)](https://razorpay.com/docs/api/disputes/accept/)
- [Contest a Dispute (`PATCH /v1/disputes/:id/contest`)](https://razorpay.com/docs/api/disputes/contest/)
- [Submit Evidence Documents (`POST /v1/documents`)](https://razorpay.com/docs/payments/disputes/submit-evidence/)
- [Dispute Webhooks (`payment.dispute.*`)](https://razorpay.com/docs/webhooks/disputes/)

## Where It Lives in This Repo

| File | Responsibility |
|---|---|
| [`lib/payments/core/razorpay-disputes.ts`](../../../../../lib/payments/core/razorpay-disputes.ts) | Raw-HTTP Disputes & Documents client (`15s` timeout): `getRazorpayDispute` (`GET /v1/disputes/:id`), `uploadDisputeDocument` (`POST /v1/documents`, `purpose=dispute_evidence`), `contestDispute` (`PATCH /v1/disputes/:id/contest`), `isRazorpayUnknownDisputeIdError`. |
| [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts) | Routes all 6 `payment.dispute.*` webhook events (`created`, `under_review`, `action_required`, `won`, `lost`, `closed`) to `handleDisputeCreated` and `handleDisputeUpdated`. |
| [`app/api/webhooks/utils.ts`](../../../../../app/api/webhooks/utils.ts) | `handleDisputeCreated` (creates `Dispute` row, holds `ConsultantEarnings` / `OrganizationEarnings`, sends urgent alerts), `handleDisputeUpdated`, and `settleLostDispute` (posts `chargeback:<disputeId>` ledger reversal, reverses unpaid earnings, or records paid-earning clawback). |
| [`lib/payments/dispute-status.ts`](../../../../../lib/payments/dispute-status.ts) | `mapDisputeStatus` and `isLegalDisputeTransition` state-machine guard. |
| [`scripts/disputes/reconcile-disputes.ts`](../../../../../scripts/disputes/reconcile-disputes.ts) & [`jobs/disputes/reconcile-disputes.ts`](../../../../../jobs/disputes/reconcile-disputes.ts) | 6-hourly reconciler that polls `getRazorpayDispute(disputeId)` for active disputes, adopts status transitions, settles newly adopted `LOST` disputes via `settleLostDispute`, and alerts on `< 48h` deadlines. |

---

## 1. REST Disputes & Documents API (`lib/payments/core/razorpay-disputes.ts`)

> **Important (`razorpay-node` v2.9.6 limitation):** While `razorpay-node` v2.9.6 only exposes `razorpay.disputes.fetch()` and `razorpay.disputes.all()`, **Razorpay provides a full REST API for uploading dispute evidence and contesting/accepting disputes**. We call these endpoints over raw `fetch` with Basic Auth and a 15-second `AbortSignal.timeout` in [`lib/payments/core/razorpay-disputes.ts`](../../../../../lib/payments/core/razorpay-disputes.ts).

### Endpoints Used

1. **Upload Evidence Document (`POST https://api.razorpay.com/v1/documents`)**:
   - `multipart/form-data` with `file` and `purpose="dispute_evidence"`.
   - Allowed MIME types (`DISPUTE_EVIDENCE_MIME_TYPES`): `image/jpg`, `image/jpeg`, `image/png`, `application/pdf`.
   - Razorpay's API limit is **50 MB** (`RAZORPAY_DOCUMENT_MAX_BYTES`); our upload route caps lower due to Netlify's 6 MB function buffer.
   - Returns `{ id: "doc_..." }`.
2. **Draft or Submit Contest (`PATCH https://api.razorpay.com/v1/disputes/:id/contest`)**:
   - Only valid when the dispute's Razorpay status is `"open"`.
   - Request JSON body:
     - `action`: `"draft"` (saves evidence, keeps status `"open"`) or `"submit"` (submits evidence to bank, requires **at least 1 document ID** across the proof lists, transitions status to `"under_review"`, and triggers `payment.dispute.under_review`).
     - `summary`: Text explanation, **max 1000 characters** (`SUMMARY_MAX_CHARS = 1000`).
     - `amount` (optional in our wrapper, defaults to full dispute amount on Razorpay if omitted; integer paise to contest).
     - Evidence document ID arrays (`string[]` of `doc_...` IDs):
       - Used in our console (`EVIDENCE_LIST_KEYS`): `proof_of_service`, `customer_communication`, `refund_cancellation_policy`, `term_and_conditions`, `explanation_letter`, plus `others: [{ type: string, document_ids: string[] }]`.
       - Additional fields supported by Razorpay's API: `shipping_proof`, `billing_proof`, `cancellation_proof`, `refund_confirmation`, `access_activity_log`.
3. **Poll Dispute Status (`GET https://api.razorpay.com/v1/disputes/:id`)**:
   - Used by `scripts/disputes/reconcile-disputes.ts`.
   - **Unknown ID Quirk**: For a `disp_...` ID Razorpay has never seen (or a test ID queried with live keys), Razorpay returns **HTTP `400 BAD_REQUEST_ERROR` with `reason: "input_validation_failed"`** (never HTTP 404). `isRazorpayUnknownDisputeIdError` detects this and flags the row for manual review instead of retrying forever.

---

## 2. All 6 `payment.dispute.*` Webhook Events

Every dispute webhook carries `contains: ["payment", "dispute"]` (`payload.payment.entity` and `payload.dispute.entity`).

| Webhook Event | Razorpay `dispute.status` | Mapped `DisputeStatus` (Prisma) | Action Taken in This Repo |
|---|---|---|---|
| `payment.dispute.created` | `"open"` | `NEEDS_RESPONSE` | Creates `Dispute` row, puts consultant/org earnings on `HELD`, blocks refunds on the payment (`lib/payments/dispute-guard.ts`), and notifies admin/consultant with `respond_by` deadline. |
| `payment.dispute.under_review` | `"under_review"` | `UNDER_REVIEW` | Advances `Dispute.status` when evidence is submitted for bank review (#789). |
| `payment.dispute.action_required` | `"open"` | `NEEDS_RESPONSE` | Fired when submitted evidence is insufficient/unreadable or before deadline; re-opens `Dispute.status` to `NEEDS_RESPONSE` (#789). |
| `payment.dispute.won` | `"won"` | `WON` | Terminal win: releases `HELD` earnings back to `PENDING`/`READY`. |
| `payment.dispute.lost` | `"lost"` | `LOST` | Terminal loss: runs `settleLostDispute` (posts `chargeback:<disputeId>` ledger reversal, reverses unpaid earnings via CAS, and pages ops for `CONSULTANT_PAID_EARNING_CLAWBACK` if earnings were already disbursed). |
| `payment.dispute.closed` | `"closed"` | `WON` or `LOST` (by `status`) | Dispute closed (either accepted/lost or resolved in merchant's favor); routed through `handleDisputeUpdated`. |

---

## 3. Verified `payload.dispute.entity` Schema & Quirks

From [`https://razorpay.com/docs/api/disputes/entity/`](https://razorpay.com/docs/api/disputes/entity/):

```json
{
  "id": "disp_AHfqOvkldwsbqt",
  "entity": "dispute",
  "payment_id": "pay_EFtmUsbwpXwBHI",
  "amount": 3900,
  "currency": "INR",
  "amount_deducted": 0,
  "reason_code": "goods_or_services_not_provided",
  "reason_description": "Goods or services not provided",
  "respond_by": 1590604200,
  "status": "open",
  "phase": "chargeback",
  "created_at": 1590059211,
  "evidence": {
    "amount": 3900,
    "summary": null,
    "shipping_proof": null,
    "billing_proof": null,
    "cancellation_proof": null,
    "customer_communication": null,
    "proof_of_service": null,
    "explanation_letter": null,
    "refund_confirmation": null,
    "access_activity_log": null,
    "refund_cancellation_policy": null,
    "term_and_conditions": null,
    "others": null,
    "submitted_at": null
  }
}
```

### Critical Field Nuances
1. **`respond_by` Is Unix Epoch Seconds**: Multiply by `1000` (`new Date(dispute.respond_by * 1000)`) when storing in `Dispute.dueBy`.
2. **`phase` Values**: `"fraud"` | `"retrieval"` | `"chargeback"` | `"pre_arbitration"` | `"arbitration"`.
3. **No `comments` Field Exists**: Older third-party docs sometimes mention `dispute.comments`; official Razorpay Dispute entities do **not** have a `comments` field. Bank reason text is in `reason_description` (with `reason_code`), and merchant contest notes live in `evidence.summary`.
4. **`deduct_at_onset` / `isChargeRefundable`**: When `deduct_at_onset === false`, Razorpay has not yet debited the merchant balance at dispute creation; `handleDisputeCreated` records `isChargeRefundable = (deduct_at_onset === false)`.
5. **GST on Lost Chargebacks (`settleLostDispute`)**: If a chargeback is lost **past the Section 34 CGST Act credit-note cutoff** (November 30 following the financial year of the original invoice, or the annual return filing date), `GST_PAYABLE` can no longer be reversed (`isPastGstCreditNoteCutoff`), so the platform absorbs the GST portion rather than posting an illegal post-cutoff GST adjustment.
