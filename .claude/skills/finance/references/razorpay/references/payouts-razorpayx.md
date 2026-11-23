# RazorpayX Payouts (`lib/payments/payouts/razorpay-payouts.ts`)

Official citations:

- [RazorpayX Payouts Overview & Modes](https://razorpay.com/docs/build/llm-docs/x/payouts.md)
- [Payouts API Overview (`POST /v1/payouts`)](https://razorpay.com/docs/api/x/payouts/)
- [Payout States & Life Cycle](https://razorpay.com/docs/build/llm-docs/x/payouts/states-life-cycle.md)
- [Payout Status Details & Error Reasons](https://razorpay.com/docs/build/llm-docs/errors/x/payout-status-details.md)
- [Payout Idempotency (`X-Payout-Idempotency`, 7-Day TTL)](https://razorpay.com/docs/api/x/payout-idempotency/)
- [Contacts API (`POST /v1/contacts`)](https://razorpay.com/docs/api/x/contacts/create/)
- [Fund Accounts API (`POST /v1/fund_accounts`)](https://razorpay.com/docs/api/x/fund-accounts/)
- [Create Payout (`POST /v1/payouts`)](https://razorpay.com/docs/api/x/payouts/create/bank-account/)
- [Payout Webhooks (`payout.*`)](https://razorpay.com/docs/build/llm-docs/webhooks/payouts.md)

## Where It Lives in This Repo

| File                                                                                                            | Responsibility                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`lib/payments/payouts/razorpay-payouts.ts`](../../../../../lib/payments/payouts/razorpay-payouts.ts)           | `RazorpayPayoutsService`, `resolveRazorpayXCredentials`, `getRazorpayPayoutsService` (`RAZORPAYX_TEST_KEYS_IN_LIVE_MODE` guard), `boundPayoutIdempotencyKey` (4–36 chars), `isDefinitiveGatewayRejection`, Contacts, Fund Accounts, Validations, Payouts, `getAccountBalance`, `mapPayoutStatus`, `determinePayoutMode`. |
| [`lib/payments/payouts/reverse-penny-drop.ts`](../../../../../lib/payments/payouts/reverse-penny-drop.ts)       | UPI Intent ₹1 reverse penny drop onboarding (`startReversePennyDrop`, `settleReversePennyDrop`, webhook completion handler). See [`fund-account-validation.md`](fund-account-validation.md).                                                                                                                             |
| [`lib/payments/payouts/payout-service.ts`](../../../../../lib/payments/payouts/payout-service.ts)               | Consultant payout batching, maker-checker approval, instant payouts (`INSTANT_PAYOUT_AUTO_APPROVE_PAISE`), live submission gated by `ENABLE_LIVE_PAYOUTS`, `handlePayoutWebhook`, atomic `markConsultantPayoutReversed`.                                                                                                 |
| [`lib/payments/payouts/org-payout-service.ts`](../../../../../lib/payments/payouts/org-payout-service.ts)       | Organization payout submission (`OrganizationPayout`), `markOrgPayoutCompleted`, `markOrgPayoutFailed`, `markOrgPayoutCancelled`, atomic `markOrgPayoutReversed`, and `reference_id` fallback binding.                                                                                                                   |
| [`lib/payments/payouts/payout-gateway-lookup.ts`](../../../../../lib/payments/payouts/payout-gateway-lookup.ts) | Shared RazorpayX lookup (`getRazorpayPayoutStatus`, `findRazorpayPayoutByReference`, `mapGatewayStatus`, `retireUnknownGatewayPayout`) used by `scripts/payouts/reconcile-payout-status.ts` and `scripts/payouts/handle-stuck-payouts.ts`.                                                                               |

---

## 1. Why RazorpayX Uses Raw `fetch` (Not `razorpay-node`)

`razorpay-node` v2.9.6 has **no** `contacts`, `fundAccount`, or `payouts` resources, and its internal `getValidHeaders()` strips `X-Payout-Idempotency`. `RazorpayPayoutsService` calls `https://api.razorpay.com/v1` directly over `fetch` with Basic Auth (`resolveRazorpayXCredentials()`) and `AbortSignal.timeout(30_000)`.

---

## 2. Three-Step Entity Chain: Contact → Fund Account → Payout

### Step 1: Contact (`POST /v1/contacts` → `cont_...`)

- Stored on `PayoutAccount.razorpayContactId`.
- **Built-in Composite Deduplication**: RazorpayX returns the existing `cont_...` when `(name, email, contact, type, reference_id)` all match (`name` and `type` are case-sensitive).
- **Immutability / Off-boarding**: Contacts cannot be deleted; `deactivateContact(contactId)` sends `PATCH /v1/contacts/:id` with `{ active: false }`.

### Step 2: Fund Account (`POST /v1/fund_accounts` → `fa_...`)

- Stored on `PayoutAccount.razorpayFundAccId`. Only `accountNumberLast4` and `ifscCode` are stored in Postgres — never full bank account numbers.
- **Immutability / Off-boarding**: Fund accounts cannot be edited or deleted; `deactivateFundAccount(fundAccountId)` sends `PATCH /v1/fund_accounts/:id` with `{ active: false }`.

### Step 3: Payout (`POST /v1/payouts` → `pout_...`)

- Stored on `ConsultantPayout.providerPayoutId` or `OrganizationPayout.gatewayPayoutId`.
- `reference_id` (max 40 chars) carries our internal primary key (`ConsultantPayout.id` / `OrganizationPayout.id`) so lost HTTP responses never orphan an accepted payout.

---

## 3. Verified `POST /v1/payouts` Field Rules & Gotchas

1. **`X-Payout-Idempotency` Header (Mandatory)**:
   - **Strict Length & Charset**: **4 to 36 characters**, `[A-Za-z0-9 _-]` only (`https://razorpay.com/docs/api/x/payout-idempotency/`).
   - `boundPayoutIdempotencyKey(key)` deterministically hashes any internal key outside `4..36` chars into `p_<32_hex_chars>` (34 chars).
   - Once a payout reaches terminal `failed`/`reversed`/`cancelled`, repeating the same `X-Payout-Idempotency` key always returns that failed entity; a new payout row with a fresh key is required to retry disbursement.
2. **`account_number` Is YOUR RazorpayX Source Account Number**:
   - `RAZORPAYX_ACCOUNT_NUMBER` identifies the platform's source balance account, never the beneficiary bank account.
3. **`purpose` & `narration` Constraints**:
   - Built-in system purposes use spaces (`"vendor bill"`, `"utility bill"`), not underscores; always pass `"payout"`.
   - `narration` allows max 30 chars of `[A-Za-z0-9 ]` (no hyphens/underscores/punctuation).

---

## 4. Payout Modes, Limits & Operating Hours

| Mode       | Fund Account Type | Min Amount       | Max Amount (Per Txn)    | Operating Hours & Turnaround Time                        |
| ---------- | ----------------- | ---------------- | ----------------------- | -------------------------------------------------------- |
| **`UPI`**  | `vpa`             | ₹1 (`100` paise) | **₹1,00,000** (₹1 Lakh) | **24×7**, instant.                                       |
| **`IMPS`** | `bank_account`    | ₹1 (`100` paise) | **₹5,00,000** (₹5 Lakh) | **24×7**, instant (`amountPaise <= 50_000_000`).         |
| **`NEFT`** | `bank_account`    | > ₹1             | No ceiling              | Settled within **2 hours** (`amountPaise > 50_000_000`). |
| **`RTGS`** | `bank_account`    | **> ₹2,00,000**  | No ceiling              | Real-time during RTGS operating hours.                   |

---

## 5. Payout Status Transitions, Atomic Post-Completion Reversals & Webhooks

### Status Mapping & Transition Guards (`handleRazorpayPayoutWebhook`)

| RazorpayX Status      | Webhook Event                         | Internal `PayoutStatus`                   | Invariants & Side Effects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`              | `payout.queued`                       | `PENDING` (webhook) / `PROCESSING` (poll) | Held for low balance (`queue_if_low_balance: true`) or partner-bank window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pending`             | `payout.pending`                      | `PENDING`                                 | Awaiting RazorpayX maker-checker approval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `processing`          | **`payout.initiated`**                | `PROCESSING`                              | Sent to partner bank/NPCI (`payout.processing` does not exist in RazorpayX). Binds `providerPayoutId` / `gatewayPayoutId` via `reference_id` if HTTP submit response was lost.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `processed`           | `payout.processed` / `payout.updated` | `COMPLETED`                               | **Strict `FAILED` Exclusion in CAS `WHERE`**: Only transitions `PENDING` / `PROCESSING` rows (`status: { in: ["PENDING", "PROCESSING"] }`) to `COMPLETED` and records `utr`. Never overwrites a row already marked `FAILED` or reversed!                                                                                                                                                                                                                                                                                                                                         |
| `updated`             | `payout.updated`                      | Current mapped status                     | Deduplicated per event id ([`webhooks.md`](webhooks.md) section 3), so each update with a new event id reaches the handler, but not every field is stored. A `ConsultantPayout` already in `PROCESSING` takes the new `failureReason`; its `gatewayUtr` is written only when the status is `processed` (or backfilled onto a `COMPLETED` row that has none). An `OrganizationPayout` takes `gatewayUtr` whenever the event carries `utr` and changes only on `processed`, `failed` / `rejected` / `cancelled` or `reversed`; on any other status its failure text is not stored. |
| `failed` / `rejected` | `payout.failed` / `payout.rejected`   | `FAILED`                                  | Un-batches `ConsultantEarnings` / `OrganizationEarnings` back to `READY` and reverses TDS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cancelled`           | `payout.cancelled`                    | `CANCELLED`                               | Handled for both consultant and organization payouts; transitions non-terminal payout rows to `CANCELLED`, un-batches linked earnings back to `READY`, and reverses TDS.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `reversed`            | `payout.reversed`                     | `REVERSED`                                | Partner bank returned funds pre-settlement or post-settlement (Razorpay says a `processed` payout can reverse for up to T+3 working days; see section 6.2). Runs single-transaction atomic reversal (`markConsultantPayoutReversed` / `markOrgPayoutReversed`).                                                                                                                                                                                                                                                                                                                  |

### Critical Payout Webhook & Reconciler Invariants

1. **Single-Transaction Atomic `markConsultantPayoutReversed` & `markOrgPayoutReversed` (`PG_POOL_MAX=1` Safe)**:
   - Partner banks can return funds either **after** `payout.processed` settled (`COMPLETED -> REVERSED`) or while a batch is still in flight (`PENDING` / `PROCESSING` / `APPROVED` -> `REVERSED`).
   - Both `markConsultantPayoutReversed` (`payout-service.ts`) and `markOrgPayoutReversed` (`org-payout-service.ts`) handle both branches inside a single `prisma.$transaction(async (tx) => ...)` passing `tx` to every helper (never touching global `prisma` under `PG_POOL_MAX=1`):
     - **Post-Settlement Branch (`COMPLETED -> REVERSED`)**:
       1. Conditional CAS transition on the payout row (`where: { id, status: "COMPLETED" }`) to `status: "REVERSED"` with failure reason.
       2. Re-opening settled earnings (`where: { payoutId, status: "PAID" }` -> `status: "READY", payoutId: null`).
       3. Inverse ledger posting (`postLedgerTxn(tx, ...)` keyed on `payout-reversal:<payoutId>` / `orgpayout-reversal:<payoutId>`) restoring cash and payable balances.
       4. Reversing Section 194J / 194-O tax deductions (`recordTdsReversal(tx, ...)` / `recordOrgTdsReversal(tx, ...)`).
       5. Releasing netted clawback recoveries (`releaseClawbackRecovery(tx, payoutId)`).
     - **Pre-Settlement Branch (`PENDING` / `PROCESSING` [/ `APPROVED` on org] -> `REVERSED`)**:
       1. Conditional CAS transition on the payout row to `status: "REVERSED"`.
       2. Detaching `BATCHED -> READY` earnings (`payoutId: null` / `orgPayoutId: null`) and removing pending non-reversal TDS records — with **no** inverse disbursement journal posted because completion never settled.
2. **Non-Regression & Terminal Exclusion Guards on `handlePayoutWebhook`**:
   - Non-terminal webhooks (`payout.queued`, `payout.pending`, `payout.initiated`) preserve `PayoutStatus.PROCESSING` on submitted consultant payouts so queued/pending gateway events never regress a submitted batch back to `PENDING`.
   - Terminal `COMPLETED` transitions strictly exclude terminal rows (`COMPLETED`, `CANCELLED`, `REVERSED`, `FAILED`) in their CAS `WHERE` guard, ensuring a reversed or failed payout can never flip to `COMPLETED` after its earnings were reopened to `READY`.
3. **`OrganizationPayout` `reference_id` Fallback & Post-Completion Reversal Reconciliation**:
   - In `handleRazorpayPayoutWebhook`, organization payouts resolve by `gatewayPayoutId: payout.id` **first**, falling back to `id: payout.reference_id` (`where: { id: payout.reference_id, gatewayPayoutId: null }`) and atomically binding `gatewayPayoutId = payout.id` — closing the lost-HTTP-reply window across both `OrganizationPayout` and `ConsultantPayout`.
   - Furthermore, `reconcile-payout-status` runs bounded scans (least-recently-reconciled first on `lastReconciledAt`, then newest `processedAt`, `take: limit`) across recent `COMPLETED` `ConsultantPayout` (`providerPayoutId`) and `OrganizationPayout` (`gatewayPayoutId`) records so missed `payout.reversed` webhooks are detected via `getRazorpayPayoutStatus` and settled atomically through `markConsultantPayoutReversed` and `markOrgPayoutReversed`.
4. **Deprecated `failure_reason` Fallback**:
   - Reads `payout.failure_reason ?? payout.status_details?.description ?? payout.status_details?.reason`.

---

## 6. Gateway Behaviour Read From Razorpay's Pages

Read on 2026-11-23 from the pages cited in each subsection. Where two pages differ, both are given.

### 6.1 `status_details` on the payout entity

- The payout entity carries `status_details` with three fields: `reason` (for example `imps_not_allowed`), `description` and `source` ([Fetch Payout With ID](https://razorpay.com/docs/api/x/payouts/fetch-with-id/)).
- `source` takes four values: `gateway` ("Technical error at Razorpay partner bank."), `beneficiary_bank` ("Technical error at beneficiary bank."), `business` ("Merchant action required.") and `internal` ("Technical error at Razorpay's server."). The same list and wording is on [Payout Status Details](https://razorpay.com/docs/errors/x/payout-status-details/).
- That page lists the reasons under five status headings: `reversed/failed`, `processing`, `processed`, `pending` and `queued`. It has no heading for `rejected` or `cancelled`. Under `reversed/failed` it lists, among others, `bank_account_closed` and `bank_account_frozen` (source `beneficiary_bank`), `insufficient_funds` and `beneficiary_vpa_invalid` (source `business`), `gateway_timeout` (source `gateway`) and `server_error` (source `internal`).
- A payout update webhook is sent whenever an attribute in the status details changes, and the page says `failure_reason`, `queueing_details`, `cancellation_details` and the error object "would be deprecated" from the API response ([Check Payout Status](https://razorpay.com/docs/x/payouts/status-details/)). The wording is future tense; the pages do not say the fields are already removed.
- In code, the failure text shown to operators is `failure_reason`, then `status_details.description`, then `status_details.reason`, then (on the webhook path only) the `error` object: the payout cases in `app/api/webhooks/razorpay-dispatch.ts` and `getRazorpayPayoutStatus` in `lib/payments/payouts/payout-gateway-lookup.ts`. `source` is parsed by `schemas/webhooks/razorpay.ts` but no code branches on `source` or on a specific `reason`, so `bank_account_closed` and `server_error` are handled identically.

### 6.2 Reversal, and a failure after `processed`

- A reversal credits the business account: "creates a reversal transaction that credits your business account with the original payout amount including fees and tax" ([States and Life Cycle](https://razorpay.com/docs/x/payouts/states-life-cycle/)). No payout code in this repo reads the entity's `fees` or `tax`, so the reversal journals in `markConsultantPayoutReversed` and `markOrgPayoutReversed` post only the payout amount.
- The same page says "A payout in the `processed` state can move to the `reversed` state if a payout failure is detected" and "In some rare scenarios, failure might happen a few days after the payout is moved to the `processed` state". [Payouts Best Practices](https://razorpay.com/docs/x/payouts/best-practices/) puts a bound on it: "This can happen in a maximum time of T+3 working days." The code reacts through the `COMPLETED -> REVERSED` branch above and the `COMPLETED` scan in `scripts/payouts/reconcile-payout-status.ts`.
- A payout can move from `reversed` to `failed` "only in case of RazorpayX powered Current accounts", and from `failed` to `reversed` once the debited money is credited back (States and Life Cycle).

### 6.3 An ambiguous create (a 5xx or a timeout)

- Rules ([Handling 5XX Errors](https://razorpay.com/docs/errors/x/)): reuse the same idempotency key and send the same body; "A different payload is rejected as a BAD_REQUEST" (also said on [Make a Request Idempotent](https://razorpay.com/docs/api/x/payout-idempotency/make-request/)); retrying is safe "within 7 calendar days of the original request". A repeated request for a payout that exists returns it, with a status of `pending`, `processing` or `failed`.
- Schedule on that page: "retry up to 3 times" after 1 minute, 2 minutes and 5 minutes, then "Wait at least 1 hour before marking the payout as failed". Separately, "After 5 minutes, check the payout status using `reference_id`" through the Fetch all payouts API, for up to 1 hour from creation; "If no status is returned after 1 hour, mark the payout as failed". The Make a Request Idempotent page contains neither the schedule nor the lookup, and the Best Practices page only links to this one. A second schedule (1 and 2 minutes) was reported by a web search summary but is on none of the pages read, including the US-region copy.
- Best Practices also says "We DO NOT recommend using the Fetch Payout API to check the status of the payouts" and recommends webhooks. The two reconcilers do call Fetch Payout (`getRazorpayPayoutStatus`, `GET /payouts/:id`); that is the state of the code, not a conflict the pages resolve.
- In code, `isDefinitiveGatewayRejection` (`lib/payments/payouts/razorpay-payouts.ts`) treats only a 4xx other than 408, 409 and 429 as a refusal, and `classifyGatewaySubmissionError` (`lib/payments/payouts/shared-lifecycle.ts`) wraps it. There is no in-request retry loop and no 1, 2, 5 minute schedule. A row left without a provider id is picked up by `scripts/payouts/handle-stuck-payouts.ts` after `STUCK_THRESHOLD_HOURS` (24), which asks `findRazorpayPayoutByReference` first and acts only on the answer `none`. The two payout types differ there:
  - A `ConsultantPayout` is reset to `APPROVED` for another submit until `PAYOUT_CONSTANTS.MAX_RETRY_ATTEMPTS` (3) attempts; the `none` that would reach the ceiling fails it and releases its earnings instead.
  - An `OrganizationPayout` is reset to `APPROVED` with no retry cap (the model has no retry counter). It is also reconciled earlier: `processPendingOrgPayouts` (`lib/payments/payouts/org-payout-service.ts`) looks up a `PROCESSING` org payout untouched for one hour (`ORG_PROCESSING_REDRIVE_AFTER_MS`) by reference and, on `none`, resets it to `APPROVED`; only the next `processOrgPayout` sends it, after every first-send check.

---

## Deprecated & Superseded Approaches

- **Multi-Step Non-Atomic Reversal Across Separate Queries**: Superseded by single-transaction `markConsultantPayoutReversed` and `markOrgPayoutReversed` so a serverless crash mid-reversal cannot leave a payout marked `REVERSED` while its ledger posting and `PAID` earnings remain unreversed.
- **Unconditional `update({ where: { id }, data: { status: "COMPLETED" } })`**: Superseded by CAS `updateMany` excluding terminal statuses so out-of-order `payout.processed` deliveries cannot resurrect an already-reversed payout.
- **Matching `OrganizationPayout` Solely by `gatewayPayoutId` and Ignoring `payout.cancelled` / `payout.updated`**: Superseded by `reference_id` fallback binding and full lifecycle handling across both consultant and org payouts.
