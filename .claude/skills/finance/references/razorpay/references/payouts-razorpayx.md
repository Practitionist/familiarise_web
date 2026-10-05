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

| File | Responsibility |
|---|---|
| [`lib/payments/payouts/razorpay-payouts.ts`](../../../../../lib/payments/payouts/razorpay-payouts.ts) | `RazorpayPayoutsService`, `resolveRazorpayXCredentials`, `getRazorpayPayoutsService` (with PM-10 `RAZORPAYX_TEST_KEYS_IN_LIVE_MODE` guard), `boundPayoutIdempotencyKey` (4–36 chars), `isDefinitiveGatewayRejection`, Contacts, Fund Accounts, Validations, Payouts, `getAccountBalance`, `mapPayoutStatus`, `determinePayoutMode`. |
| [`lib/payments/payouts/reverse-penny-drop.ts`](../../../../../lib/payments/payouts/reverse-penny-drop.ts) | UPI Intent ₹1 reverse penny drop onboarding (`startReversePennyDrop`, `settleReversePennyDrop`). See [`fund-account-validation.md`](fund-account-validation.md). |
| [`lib/payments/payouts/payout-service.ts`](../../../../../lib/payments/payouts/payout-service.ts) | Consultant payout batching, maker-checker approval, instant payouts (`INSTANT_PAYOUT_AUTO_APPROVE_PAISE`), live submission gated by `ENABLE_LIVE_PAYOUTS`, `handlePayoutWebhook`, `markConsultantPayoutReversed`. |
| [`lib/payments/payouts/org-payout-service.ts`](../../../../../lib/payments/payouts/org-payout-service.ts) | Organization payout submission (`OrganizationPayout`), `markOrgPayoutCompleted`, `markOrgPayoutFailed`, `markOrgPayoutReversed`. |
| [`lib/payments/payouts/payout-gateway-lookup.ts`](../../../../../lib/payments/payouts/payout-gateway-lookup.ts) | Shared RazorpayX lookup (`getRazorpayPayoutStatus`, `findRazorpayPayoutByReference`, `mapGatewayStatus`, `retireUnknownGatewayPayout`) used by `scripts/payouts/reconcile-payout-status.ts` and `scripts/payouts/handle-stuck-payouts.ts`. |

---

## 1. Why RazorpayX Uses Raw `fetch` (Not `razorpay-node`)

`razorpay-node` v2.9.6 has **no** `contacts`, `fundAccount`, or `payouts` resources, and its internal `getValidHeaders()` strips `X-Payout-Idempotency`. `RazorpayPayoutsService` calls `https://api.razorpay.com/v1` directly over `fetch` with Basic Auth (`resolveRazorpayXCredentials()`) and `AbortSignal.timeout(30_000)`.

---

## 2. Three-Step Entity Chain: Contact → Fund Account → Payout

### Step 1: Contact (`POST /v1/contacts` → `cont_...`)
- Stored on `PayoutAccount.razorpayContactId`.
- **Built-in Composite Deduplication**: `POST /v1/contacts` does not take an idempotency header. Instead, RazorpayX returns the existing `cont_...` if **all** of `(name, email, contact, type, reference_id)` match (`name` and `type` are **case-sensitive**; `notes` is ignored in deduplication).
- **Field constraints**:
  - `name` (required): **3 to 50 characters**, cannot end with a special character except `.`.
  - `type` (optional): Default system classifications are `"vendor"`, `"customer"`, `"employee"`, `"self"` (max 40 chars; custom types can only be created in the RazorpayX Dashboard). We pass `"vendor"`.
  - `reference_id` (optional): Max **40 characters** (we pass `consultantProfileId` or `organizationId`).
- **Immutability / Off-boarding**: Contacts **cannot be deleted** once created; `deactivateContact(contactId)` sends `PATCH /v1/contacts/:id` with `{ active: false }` (#1771 row 5).

### Step 2: Fund Account (`POST /v1/fund_accounts` → `fa_...`)
- Stored on `PayoutAccount.razorpayFundAccId`. We never persist the full bank account number in Postgres — only `accountNumberLast4` and `ifscCode`.
- **Built-in Deduplication**: Returns the existing `fa_...` if `(contact_id, bank_account.name, bank_account.ifsc, bank_account.account_number)` or `(contact_id, vpa.address)` match.
- **Field constraints**:
  - `bank_account`: `name` (3–120 chars), `ifsc` (**exactly 11 chars**), `account_number` (5–35 alphanumeric chars).
  - `vpa`: `address` (3–100 chars, alphanumeric + `.` + `-` + exactly one `@`).
- **Immutability / Off-boarding**: Fund accounts **cannot be edited or deleted**; `deactivateFundAccount(fundAccountId)` sends `PATCH /v1/fund_accounts/:id` with `{ active: false }`.

### Step 3: Payout (`POST /v1/payouts` → `pout_...`)
- Stored on `ConsultantPayout.providerPayoutId` or `OrganizationPayout.gatewayPayoutId`.
- Request body:
  ```json
  {
    "account_number": "<RAZORPAYX_ACCOUNT_NUMBER>",
    "fund_account_id": "fa_...",
    "amount": 500000,
    "currency": "INR",
    "mode": "IMPS",
    "purpose": "payout",
    "queue_if_low_balance": true,
    "reference_id": "<our_payout_row_id>",
    "narration": "Familiarise Payout",
    "notes": { ... }
  }
  ```

---

## 3. Verified `POST /v1/payouts` Field Rules & Gotchas

1. **`X-Payout-Idempotency` Header (Mandatory Since 15 March 2025)**:
   - Omitting the header fails with HTTP `400 BAD_REQUEST_ERROR` (`"Idempotency key is missing."`).
   - **Strict Length & Charset**: **4 to 36 characters**, allowed characters **`[A-Za-z0-9 _-]` only** (`https://razorpay.com/docs/api/x/payout-idempotency/make-request/`).
   - **Why `boundPayoutIdempotencyKey` exists (`#1377`)**: Our DB `ConsultantPayout.idempotencyKey` (`payout_<profileId>_<batchId>`) is 72 characters and `payout_<uuid>` is 43 characters — both exceed RazorpayX's 36-char ceiling and would be rejected with HTTP 400! `boundPayoutIdempotencyKey(key)` deterministically hashes any key outside `4..36` chars into `p_<32_hex_chars>` (34 chars) so retries always hit the same RazorpayX idempotency slot.
   - **Retrying after terminal `failed` state**: Once a payout reaches `failed`, sending the same `X-Payout-Idempotency` key always returns that `failed` payout. A new payout row with a new idempotency key is required after a definitive failure.
2. **`account_number` Is YOUR RazorpayX Account Number**:
   - `account_number` is the **source** account (`RAZORPAYX_ACCOUNT_NUMBER` from RazorpayX Dashboard → Banking), **never** the consultant's bank account number. Test mode and Live mode have different `account_number` values.
3. **`purpose` Space vs. Underscore Gotcha**:
   - RazorpayX's 6 built-in system purposes are `"refund"`, `"cashback"`, `"payout"`, `"salary"`, **`"utility bill"`**, and **`"vendor bill"`** (with a **space**, not an underscore!). Passing `"vendor_bill"` or `"utility_bill"` fails with HTTP 400 unless a custom purpose with an underscore was manually added in the RazorpayX Dashboard. Always pass `"payout"` (which is what our consultant and org payout services use).
4. **`narration` Constraints**:
   - Max **30 characters**, **alphanumeric and spaces only (`[A-Za-z0-9 ]`)** — hyphens, underscores, and punctuation are rejected! Keep the most important identifier in the first 9 characters because partner banks often truncate beyond 9 chars.
5. **`reference_id` & Lost Submit Reply Recovery (`#1846 N1`)**:
   - Max **40 characters**. We pass our internal payout row ID (`ConsultantPayout.id` / `OrganizationPayout.id`) as `reference_id`.
   - If `POST /v1/payouts` times out or drops the connection (`RAZORPAYX_REQUEST_FAILED`), `isDefinitiveGatewayRejection(error)` returns `false` (only 4xx errors other than `408`, `409`, `429` are definitive rejections!). The row stays in flight and `findRazorpayPayoutByReference(referenceId)` (`GET /v1/payouts?account_number=...&reference_id=...`) or an inbound `payout.*` webhook recovers `providerPayoutId` without double-paying.

---

## 4. Payout Modes, Limits & Operating Hours

From [Official RazorpayX Payout Modes & TAT](https://razorpay.com/docs/x/payouts/#payout-modes-and-tat):

| Mode | Fund Account Type | Min Amount | Max Amount (Per Txn) | Operating Hours & Turnaround Time |
|---|---|---|---|---|
| **`UPI`** | `vpa` | ₹1 (`100` paise) | **₹1,00,000** (₹1 Lakh) | **24×7**, instant. *(On Current Accounts, supported on RBL & Yes Bank; not supported on ICICI/IDFC Current Accounts).* |
| **`IMPS`** | `bank_account` | ₹1 (`100` paise) | **₹5,00,000** (₹5 Lakh) | **24×7**, instant. |
| **`NEFT`** | `bank_account` | > ₹1 | No ceiling (₹10 Cr in bulk) | Settled within **2 hours** during bank NEFT hours (24×7 NEFT available on RBL & Yes Bank via support). |
| **`RTGS`** | `bank_account` | **> ₹2,00,000** (₹2 Lakh) | No ceiling (₹10 Cr in bulk) | Real-time (within 30 min on Current Account / 2h on Lite) during bank RTGS hours. |

In `determinePayoutMode(amountPaise, accountType)`:
- `vpa` → `"UPI"`
- `bank_account` with `amountPaise <= 50_000_000` (₹5L) → `"IMPS"`
- `bank_account` with `amountPaise > 50_000_000` (> ₹5L) → `"NEFT"`

---

## 5. Payout Statuses, `status_details` & Webhooks

### Status Mapping (`mapPayoutStatus` & `handleRazorpayPayoutWebhook`)

| RazorpayX Status | Webhook Event | Internal `PayoutStatus` | Notes |
|---|---|---|---|
| `queued` | `payout.queued` | `PENDING` (or `PROCESSING` in poll) | Held due to `queue_if_low_balance: true` or partner bank downtime. Can be cancelled via `POST /v1/payouts/:id/cancel`. |
| `pending` | `payout.pending` | `PENDING` | Awaiting RazorpayX maker-checker approval workflow. |
| `processing` | **`payout.initiated`** | `PROCESSING` | Sent to partner bank/NPCI. **Note:** RazorpayX names this webhook `payout.initiated` (there is no `payout.processing` event!). May stay `processing` up to **T+3 working days** if NPCI marks it Deemed Success. |
| `processed` | `payout.processed` (`payout.updated`) | `COMPLETED` | Credited to beneficiary; bank reference populated in `utr`. |
| `failed` | `payout.failed` | `FAILED` | Terminal failure; un-batches `ConsultantEarnings` / `OrganizationEarnings` back to `READY` and reverses TDS (#1377 / #1451). |
| `rejected` | `payout.rejected` | `FAILED` | Rejected in maker-checker workflow; un-batches earnings. |
| `reversed` | `payout.reversed` | `FAILED` | Partner bank reversed funds back to RazorpayX balance (can occur up to **T+3 working days** even after `processed`!). If the payout was already marked `COMPLETED`, `markConsultantPayoutReversed` / `markOrgPayoutReversed` posts the inverse ledger journal and re-opens earnings (#812/#813). |
| `cancelled` | *(API response / poll)* | `CANCELLED` | Cancelled while `queued` or `scheduled`. |

### Deprecated `failure_reason` vs `status_details`
Official RazorpayX docs mark top-level `failure_reason` on the payout entity as **deprecated** in favor of `status_details: { description, source, reason }`. Both `app/api/webhooks/razorpay-dispatch.ts` and `lib/payments/payouts/payout-gateway-lookup.ts` read:
```ts
const failureReason =
  payout.failure_reason ??
  payout.status_details?.description ??
  payout.status_details?.reason;
```
