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

| File                                                                                              | Responsibility                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`lib/payments/core/razorpay-disputes.ts`](../../../../../lib/payments/core/razorpay-disputes.ts) | Raw-HTTP Disputes & Documents client (`15s` timeout): `getRazorpayDispute` (`GET /v1/disputes/:id`), `uploadDisputeDocument` (`POST /v1/documents`, `purpose=dispute_evidence`), `contestDispute` (`PATCH /v1/disputes/:id/contest`), `listRazorpayDisputes` (`GET /v1/disputes`, through the SDK), `isRazorpayUnknownDisputeIdError`.                 |
| [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts)   | Routes all 6 `payment.dispute.*` webhook events (`created`, `under_review`, `action_required`, `won`, `lost`, `closed`) to `handleDisputeCreated` and `handleDisputeUpdated`, preserving `DeferSignal` on out-of-order deliveries.                                                                                                                     |
| [`app/api/webhooks/utils.ts`](../../../../../app/api/webhooks/utils.ts)                           | `handleDisputeCreated` (creates `Dispute` row, holds `ConsultantEarnings` / `OrganizationEarnings`, sends urgent alerts), `handleDisputeUpdated` (`UNDER_REVIEW -> NEEDS_RESPONSE` re-entry, multi-dispute `tx.dispute.count === 0` guard, out-of-order `DeferSignal`), and `settleLostDispute` (`chargeback:<disputeId>` ledger reversal + clawback). |
| [`lib/payments/dispute-status.ts`](../../../../../lib/payments/dispute-status.ts)                 | `mapDisputeStatus` and `isLegalDisputeTransition` state-machine guard (including `UNDER_REVIEW -> NEEDS_RESPONSE`).                                                                                                                                                                                                                                    |
| [`scripts/disputes/reconcile-disputes.ts`](../../../../../scripts/disputes/reconcile-disputes.ts) | Reconciler (hourly on the Netlify ticker, ten disputes per run) that polls `getRazorpayDispute(disputeId)` for active disputes, adopts status transitions, settles newly adopted `LOST` disputes via `settleLostDispute`, and counts `< 48h` deadlines as `urgentCount`; deadline alerts and the critical page live in `support-sla-sweep`.            |

---

## 1. REST Disputes & Documents API (`lib/payments/core/razorpay-disputes.ts`)

> **Important (`razorpay-node` v2.9.6 limitation):** While `razorpay-node` v2.9.6 only exposes `razorpay.disputes.fetch()` and `razorpay.disputes.all()`, **Razorpay provides a full REST API for uploading dispute evidence and contesting/accepting disputes**. We call these endpoints over raw `fetch` with Basic Auth and a 15-second `AbortSignal.timeout` in [`lib/payments/core/razorpay-disputes.ts`](../../../../../lib/payments/core/razorpay-disputes.ts).

### Endpoints Used

1. **Upload Evidence Document (`POST https://api.razorpay.com/v1/documents`)**:
   - `multipart/form-data` with `file` and `purpose="dispute_evidence"`.
   - Allowed MIME types (`DISPUTE_EVIDENCE_MIME_TYPES`): `image/jpg`, `image/jpeg`, `image/png`, `application/pdf`.
   - Razorpay's API limit is **50 MB** (`RAZORPAY_DOCUMENT_MAX_BYTES`); our upload route caps lower due to serverless request buffering limits.
   - Returns `{ id: "doc_..." }`.
2. **Draft or Submit Contest (`PATCH https://api.razorpay.com/v1/disputes/:id/contest`)**:
   - Valid when the dispute's Razorpay status is `"open"` (including re-opened `"open"` states during `action_required` / `pre_arbitration`).
   - Request JSON body:
     - `action`: `"draft"` (saves evidence, keeps status `"open"`) or `"submit"` (submits evidence to bank, requires **at least 1 document ID** across proof lists, transitions status to `"under_review"`, and triggers `payment.dispute.under_review`).
     - `summary`: Text explanation, **max 1000 characters** (`SUMMARY_MAX_CHARS = 1000`).
     - `amount`: Optional integer paise to contest (defaults to full dispute amount on Razorpay if omitted).
     - Evidence document ID arrays (`string[]` of `doc_...` IDs): `proof_of_service`, `customer_communication`, `refund_cancellation_policy`, `term_and_conditions`, `explanation_letter`, plus `others: [{ type: string, document_ids: string[] }]`.
3. **Poll Dispute Status (`GET https://api.razorpay.com/v1/disputes/:id`)**:
   - Used by `scripts/disputes/reconcile-disputes.ts`.
   - **Unknown ID Quirk**: For an unknown `disp_...` ID (or test ID queried with live credentials), Razorpay returns **HTTP `400 BAD_REQUEST_ERROR` with `reason: "input_validation_failed"`** (never HTTP 404). `isRazorpayUnknownDisputeIdError` flags the row for manual review instead of retrying forever.
4. **List Every Dispute (`GET https://api.razorpay.com/v1/disputes`)**, through the SDK (`disputes.all`) behind `withRazorpaySdkTimeout`, as `listRazorpayDisputes`. Read from `node_modules/razorpay` 2.9.8 (`dist/resources/disputes.js`, `dist/types/disputes.d.ts`) on 2026-11-27; nothing here has been checked against the gateway.
   - **Only `count` and `skip` are sent.** The TypeScript type accepts `from` and `to`, but the SDK's JavaScript drops them, so the list cannot be narrowed to a time window through the SDK. Whether the endpoint itself honours `from` and `to` is not known.
   - **Page size**: `count` defaults to 10; the shared pagination type says the maximum is 100.
   - **Ordering**: not stated anywhere we can read. Callers assume none.
   - **Listed entity (the SDK type)**: `id`, `payment_id`, `amount`, `currency`, `amount_deducted`, `reason_code`, `respond_by`, `status`, `phase`, `created_at`, `evidence`. It has **no update time**, so a change is found only by comparing a listed dispute with its row. `reason_description` and `deduct_at_onset` are not in the type; `razorpayListedDisputeSchema` reads them when present.

---

## 2. All 6 `payment.dispute.*` Webhook Events & State Machine Invariants

Every dispute webhook carries `contains: ["payment", "dispute"]` (`payload.payment.entity` and `payload.dispute.entity`). Deduplication uses the `eventId` described in [`webhooks.md`](webhooks.md) section 3 (`${eventType}:${entityId}:${x-razorpay-event-id | sha256(rawBody).slice(0, 16)}`), so a repeated `action_required` or `under_review` with a new Razorpay event id reaches `handleDisputeUpdated`. Passing deduplication is not a state update: `handleDisputeUpdated` returns without writing when the mapped status equals the stored one, so a second `action_required` on a row already in `NEEDS_RESPONSE` does not refresh `dueBy` from its new `respond_by`. Whether a later phase reuses the dispute id is an open question (section 3.6).

| Webhook Event                     | Razorpay `dispute.status`      | Mapped `DisputeStatus` (Prisma)       | Action & Invariants Enforced                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment.dispute.created`         | `"open"`                       | `NEEDS_RESPONSE`                      | Creates `Dispute` row, puts consultant/org earnings on `HELD`, blocks voluntary refunds on the payment (`lib/payments/dispute-guard.ts`), and notifies admin/consultant with `respond_by` deadline.                                               |
| `payment.dispute.under_review`    | `"under_review"`               | `UNDER_REVIEW`                        | Advances `Dispute.status` (`NEEDS_RESPONSE -> UNDER_REVIEW`) when contest evidence is submitted for acquiring bank review.                                                                                                                        |
| `payment.dispute.action_required` | `"open"` (the Razorpay sample) | `NEEDS_RESPONSE`                      | Fired when bank requests additional proof or escalates into `pre_arbitration` (often with a tight T+2 business day `respond_by` window). Legally transitions `UNDER_REVIEW -> NEEDS_RESPONSE` and refreshes `dueBy` (`respond_by * 1000`).        |
| `payment.dispute.won`             | `"won"`                        | `WON`                                 | Terminal win: verifies `tx.dispute.count({ where: { paymentId, id: { not: dispute.id }, status: { notIn: ["WON", "LOST", "CHARGE_REFUNDED", "CLOSED", "WARNING_CLOSED"] } } }) === 0` before releasing `HELD` earnings back to `PENDING`/`READY`. |
| `payment.dispute.lost`            | `"lost"`                       | `LOST`                                | Terminal loss: executes `settleLostDispute` (`chargeback:<disputeId>` ledger journal, CAS reversal of unpaid earnings, or `CONSULTANT_PAID_EARNING_CLAWBACK` if already disbursed).                                                               |
| `payment.dispute.closed`          | `"closed"`                     | `WON` or `LOST` (by terminal outcome) | Terminal closure routed through `handleDisputeUpdated` under the same multi-dispute and CAS guards.                                                                                                                                               |

### Critical Distributed & Multi-Dispute Invariants

1. **`UNDER_REVIEW -> NEEDS_RESPONSE` Re-Entry (`isLegalDisputeTransition`)**:
   - In Razorpay's dispute lifecycle, submitting evidence transitions a chargeback to `UNDER_REVIEW`, after which the issuing bank can either request supplemental documents (`payment.dispute.action_required`) or rechallenges a merchant win into **`pre_arbitration`**.
   - `isLegalDisputeTransition("UNDER_REVIEW", "NEEDS_RESPONSE")` explicitly permits re-opening so `Dispute.status` transitions cleanly back to `NEEDS_RESPONSE` and updates `dueBy` from `respond_by` so the admin console unlocks evidence uploads before the deadline expires.
2. **Multi-Dispute Hold Guard (`tx.dispute.count === 0` Before Unfreezing Earnings)**:
   - A single captured payment (`Payment.id`) can accumulate multiple partial disputes or sequential fraud/chargeback claims (`Dispute.disputeId`).
   - Inside the Serializable transaction for `payment.dispute.won` / `payment.dispute.closed`, `handleDisputeUpdated` transitions the target `Dispute` row via conditional CAS `updateMany` first and **then checks**:
     ```ts
     const remainingOpenDisputes = await tx.dispute.count({
       where: {
         paymentId: dispute.paymentId,
         id: { not: dispute.id },
         status: {
           notIn: [
             "WON",
             "LOST",
             "CHARGE_REFUNDED",
             "CLOSED",
             "WARNING_CLOSED",
           ],
         },
       },
     });
     ```
   - `ConsultantEarnings` and `OrganizationEarnings` in `HELD` are released **only** when `remainingOpenDisputes === 0`. If another dispute on the same payment is still open or under review, earnings remain safely frozen in `HELD`.
3. **Out-of-Order `DeferSignal` Handling**:
   - If `payment.dispute.under_review`, `action_required`, `won`, `lost`, or `closed` arrives before `payment.dispute.created` (or if `payment.dispute.created` arrives before `payment.captured` creates/updates the `Payment` row), the handler returns `new DeferSignal(...)` instead of discarding the event or throwing a fatal error.
   - `razorpay-dispatch.ts` increments `WebhookEvent.deferCount` and leaves `processed = false, error = null` so `sweep-stuck-webhook-events` re-drives the event automatically once the parent row commits.

---

## 3. Verified `payload.dispute.entity` Schema & Tax Rules

1. **`respond_by` Is Unix Epoch Seconds**: Always multiply by `1000` (`new Date(dispute.respond_by * 1000)`) when writing `Dispute.dueBy`.
2. **`phase` Values**: `"fraud"` | `"retrieval"` | `"chargeback"` | `"pre_arbitration"` | `"arbitration"`. Details are in section 3.6.
3. **No `comments` Field Exists**: Official Razorpay Dispute entities do **not** have a `comments` field; bank reason metadata lives in `reason_description` / `reason_code`, and merchant contest notes live in `evidence.summary`.
4. **`deduct_at_onset` / `isChargeRefundable`**: The webhook schema and `handleDisputeCreated` accept an optional boolean `deduct_at_onset` and record `isChargeRefundable = (deduct_at_onset === false)`; `getRazorpayDispute` (`lib/payments/core/razorpay-disputes.ts`) takes an explicit `is_charge_refundable` first, then `deduct_at_onset === false`, and derives it from the status (not `lost` or `charge_refunded`) only when both are absent, so `open` with `is_charge_refundable: false` stays false. No Razorpay page read on 2026-11-23 lists a `deduct_at_onset` field on the dispute entity or in a webhook sample (section 3.6), so treat its meaning as unconfirmed.
5. **GST on Lost Chargebacks (`settleLostDispute`)**: Past the Section 34 CGST Act credit-note cutoff (November 30 following the financial year of the original invoice, or the annual return filing date), `GST_PAYABLE` cannot be reversed (`isPastGstCreditNoteCutoff`); the platform absorbs the GST component rather than posting an post-cutoff tax adjustment.

### 3.6 Gateway Behaviour Read From Razorpay's Pages

Read on 2026-11-23. Where two pages pull in different directions, both are given.

- **`amount_deducted`.** The [Dispute entity](https://razorpay.com/docs/api/disputes/entity/) says it is "deducted from your Razorpay current balance when the dispute is lost. This amount will be 0 unless the status of dispute is updated to lost." The [Dispute webhooks page](https://razorpay.com/docs/webhooks/disputes/) agrees: five of its six samples carry `amount_deducted: 0`, and the `payment.dispute.lost` sample carries `39000` on a `39000` dispute. The [Chargeback Fees & Penalties page](https://razorpay.com/docs/payments/disputes/chargeback-fees-and-penalties/) says the opposite about timing: "When a dispute is raised, Razorpay deducts the disputed amount, along with any applicable fees, from your account balance at the outset — before the case is resolved", called Deduct at Onset, with a credit back if you win (up to 30 days after evidence). The pages do not reconcile the two: the entity field may describe only the final loss, while the fees page describes a balance hold at onset. The code reads `amount_deducted` as the loss amount only when it is above zero: `settleDisputeVerdict` (`app/api/webhooks/utils.ts`) settles a `LOST` or `CHARGE_REFUNDED` for `amount_deducted` when it is above 0 and for the disputed amount when it is 0 or missing, recording one `INFO` `SystemEvent` when a reported figure differs from the disputed amount; it settles a `CLOSED` as a loss only when `amount_deducted` is above zero.
- **`status` values.** The entity page lists five: `open`, `under_review`, `won`, `lost` and `closed`. There is no `action_required` status; the `payment.dispute.action_required` sample on the webhooks page has `status: "open"`.
- **`phase` values.** The entity page and the [Disputes overview](https://razorpay.com/docs/payments/disputes/) list five phases: `fraud` (raised by the bank on suspicion of fraud), `retrieval` (a customer request for information), `chargeback` (a refund claim, with an official inquiry), `pre_arbitration` ("A chargeback that you have won is challenged by the customer for the second time") and `arbitration` (challenged a third time, with the card networks involved). The webhook samples show only `chargeback` and `fraud`. The fees page gives response windows of T+3 business days for a chargeback, T+2 for pre-arbitration and T+1 for arbitration. `Dispute` has no phase column. Both dispute schemas parse `phase` (`disputeEntitySchema` in `app/api/webhooks/razorpay-dispatch.ts` and `disputeUpdateEntitySchema` in `schemas/webhooks/razorpay.ts`), and the only reader is `isTerminalDisputeChange` (`lib/payments/dispute-status.ts`): on a terminal dispute, a phase other than `fraud`, `retrieval` or `chargeback` counts as a change.
- **Open question, not a fact: does a later phase reuse the dispute id?** None of the four pages says whether a chargeback that escalates to pre-arbitration or arbitration keeps its `disp_...` id or arrives under a new one. The webhook samples give no answer, since no sample has a phase later than `chargeback`. Until it is confirmed with Razorpay, do not assume either behaviour. The answer matters to the code: if a won dispute's id were reused for pre-arbitration, `handleDisputeUpdated` (or `handleDisputeCreated`) would find the `WON` row, `isLegalDisputeTransition` refuses any move out of a terminal status, and the event changes nothing, with the earnings already released. It does record one `ERROR` `SystemEvent` with the stored status, the incoming status and the phase, so operations sees it, but a later loss is not booked until someone acts on it. The `paymentId` count in section 2 cannot catch that, because it only sees phases that have their own row.
- **`deduct_at_onset` is on none of those four pages**, nor on the [Fetch a Dispute](https://razorpay.com/docs/api/disputes/fetch/) page.

---

## Deprecated & Superseded Approaches

- **Treating `UNDER_REVIEW` as Strictly Forward-Only to `WON`/`LOST`**: Superseded because Razorpay emits `payment.dispute.action_required` when banks request supplemental documents or escalate into `pre_arbitration`; blocking `UNDER_REVIEW -> NEEDS_RESPONSE` locked admins out of uploading required counter-evidence.
- **Unconditionally Releasing `HELD` Earnings on Any Single Dispute Win**: Superseded by the `tx.dispute.count === 0` active-dispute guard inside the Serializable transaction so winning one partial dispute cannot release funds still contested by a second dispute on the same payment.
- **Dropping or Failing Out-of-Order `payment.dispute.*` Updates**: Superseded by returning `DeferSignal` so `sweep-stuck-webhook-events` replays out-of-order updates cleanly after `payment.dispute.created` commits.
