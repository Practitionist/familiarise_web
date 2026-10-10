# RazorpayX Payouts (`lib/payments/payouts/razorpay-payouts.ts`)

Official citations:

- [RazorpayX Payouts Overview & Modes](https://razorpay.com/docs/x/payouts/)
- [Payouts Best Practices](https://razorpay.com/docs/x/payouts/best-practices/)
- [Payout States & Life Cycle](https://razorpay.com/docs/x/payouts/states-life-cycle/)
- [Payout Status Details & Error Reasons](https://razorpay.com/docs/errors/x/payout-status-details/)
- [Payout Idempotency (`X-Payout-Idempotency`)](https://razorpay.com/docs/api/x/payout-idempotency/)
- [Contacts API (`POST /v1/contacts`)](https://razorpay.com/docs/api/x/contacts/create/)
- [Fund Accounts API (`POST /v1/fund_accounts`)](https://razorpay.com/docs/api/x/fund-accounts/)
- [Create Payout (`POST /v1/payouts`)](https://razorpay.com/docs/api/x/payouts/create/bank-account/)
- [Payout Webhooks (`payout.*`)](https://razorpay.com/docs/webhooks/payouts/)

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

| RazorpayX Status      | Webhook Event                         | Internal `PayoutStatus`                   | Invariants & Side Effects                                                                                                                                                                                                                |
| --------------------- | ------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`              | `payout.queued`                       | `PENDING` (webhook) / `PROCESSING` (poll) | Held for low balance (`queue_if_low_balance: true`) or partner-bank window.                                                                                                                                                              |
| `pending`             | `payout.pending`                      | `PENDING`                                 | Awaiting RazorpayX maker-checker approval.                                                                                                                                                                                               |
| `processing`          | **`payout.initiated`**                | `PROCESSING`                              | Sent to partner bank/NPCI (`payout.processing` does not exist in RazorpayX). Binds `providerPayoutId` / `gatewayPayoutId` via `reference_id` if HTTP submit response was lost.                                                           |
| `processed`           | `payout.processed` / `payout.updated` | `COMPLETED`                               | **Strict `FAILED` Exclusion in CAS `WHERE`**: Only transitions `PENDING` / `PROCESSING` rows (`status: { in: ["PENDING", "PROCESSING"] }`) to `COMPLETED` and records `utr`. Never overwrites a row already marked `FAILED` or reversed! |
| `updated`             | `payout.updated`                      | Current mapped status                     | Deduplicated via `${eventType}:${entityId}:${sha256(rawBody).slice(0, 16)}` so consecutive `status_details` updates and delayed `utr` assignments both apply onto `ConsultantPayout` and `OrganizationPayout`.                           |
| `failed` / `rejected` | `payout.failed` / `payout.rejected`   | `FAILED`                                  | Un-batches `ConsultantEarnings` / `OrganizationEarnings` back to `READY` and reverses TDS.                                                                                                                                               |
| `cancelled`           | `payout.cancelled`                    | `CANCELLED`                               | Handled for both consultant and organization payouts; transitions non-terminal payout rows to `CANCELLED`, un-batches linked earnings back to `READY`, and reverses TDS.                                                                 |
| `reversed`            | `payout.reversed`                     | `REVERSED`                                | Partner bank returned funds pre-settlement or post-settlement (up to T+3 working days on IMPS/NEFT). Runs single-transaction atomic reversal (`markConsultantPayoutReversed` / `markOrgPayoutReversed`).                                 |

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
   - Furthermore, `reconcile-payout-status` runs bounded scans (`orderBy: { processedAt: "asc" }, take: 100`) across recent `COMPLETED` `ConsultantPayout` (`providerPayoutId`) and `OrganizationPayout` (`gatewayPayoutId`) records so missed `payout.reversed` webhooks are detected via `getRazorpayPayoutStatus` and settled atomically through `markConsultantPayoutReversed` and `markOrgPayoutReversed`.
4. **Deprecated `failure_reason` Fallback**:
   - Reads `payout.failure_reason ?? payout.status_details?.description ?? payout.status_details?.reason`.

---

## Deprecated & Superseded Approaches

- **Multi-Step Non-Atomic Reversal Across Separate Queries**: Superseded by single-transaction `markConsultantPayoutReversed` and `markOrgPayoutReversed` so a serverless crash mid-reversal cannot leave a payout marked `REVERSED` while its ledger posting and `PAID` earnings remain unreversed.
- **Unconditional `update({ where: { id }, data: { status: "COMPLETED" } })`**: Superseded by CAS `updateMany` excluding terminal statuses so out-of-order `payout.processed` deliveries cannot resurrect an already-reversed payout.
- **Matching `OrganizationPayout` Solely by `gatewayPayoutId` and Ignoring `payout.cancelled` / `payout.updated`**: Superseded by `reference_id` fallback binding and full lifecycle handling across both consultant and org payouts.
