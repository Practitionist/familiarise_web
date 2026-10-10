# RazorpayX Fund Account Validation (Penny Drop & Reverse Penny Drop)

Official citations:

- [Fund Account Validation Overview](https://razorpay.com/docs/x/fund-account-validation/)
- [Account Validation API Overview](https://razorpay.com/docs/api/x/account-validation/)
- [Validate a Bank Account (Penny Drop)](https://razorpay.com/docs/api/x/account-validation/bank-account/)
- [Validate a VPA (Composite Penny Drop)](https://razorpay.com/docs/api/x/account-validation/vpa/)
- [Reverse Penny Drop (`upi_intent`)](https://razorpay.com/docs/api/x/account-validation/reverse-penny-drop/)
- [Account Validation Webhooks (`fund_account.validation.*`)](https://razorpay.com/docs/webhooks/account-validation/)

## Where It Lives in This Repo

| File                                                                                                                                                                                                | Responsibility                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`lib/payments/payouts/razorpay-payouts.ts`](../../../../../lib/payments/payouts/razorpay-payouts.ts)                                                                                               | `validateBankAccount(fundAccountId)`, `createReversePennyDrop({ referenceId, notes })`, `fetchFundAccountValidation(validationId)`, and `summariseFundAccountValidation(raw)` (normalizes both `results` and `validation_results`).                                            |
| [`lib/payments/payouts/reverse-penny-drop.ts`](../../../../../lib/payments/payouts/reverse-penny-drop.ts)                                                                                           | `startReversePennyDrop(consultantProfileId)`, `settleReversePennyDrop(consultantProfileId, validationId)` (client poll under `rpd:settle:<validationId>` Redis mutex), and `handleFundAccountValidationWebhook` (CAS status verification strictly bound to `fund_account.id`). |
| [`app/api/webhooks/razorpay/signature.ts`](../../../../../app/api/webhooks/razorpay/signature.ts) & [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts) | `isPayoutEventName(body)` verifies `fund_account.*` under `RAZORPAYX_WEBHOOK_SECRET`, and `razorpay-dispatch.ts` dispatches `fund_account.validation.completed` / `fund_account.validation.failed`.                                                                            |

---

## 1. Critical Availability & Mode Constraints

1. **NOT Available in Test Mode**:
   - Every official RazorpayX Account Validation page states: _"Account Validation is **not available in test mode** and is possible **only for RazorpayX Lite**."_
   - In preview/dev/test environments, `createReversePennyDrop` is refused by RazorpayX; `gatewayCall` catches `PaymentError` and returns a clean `503 RPD_UNAVAILABLE` instructing the user to add bank details manually.
2. **Never Persist Full Bank Account Numbers**:
   - Even when Reverse Penny Drop returns `validation_results.bank_account.account_number` in memory, `persistVerifiedAccount` immediately creates the RazorpayX Contact + FundAccount (`fa_...`) and persists **only** `accountNumberLast4`, `ifscCode`, `bankName`, `accountHolderName`, `razorpayContactId`, and `razorpayFundAccId` on `PayoutAccount`.

---

## 2. The #1 Gotcha: `status: "completed"` Does NOT Mean the Account Is Valid

From [Official RazorpayX Account Validation Docs](https://razorpay.com/docs/api/x/account-validation/bank-account/):

> _"The `completed` status does not determine if a fund account is valid or not. It only notifies you that the validation process has been completed. Refer to the `results` parameter in the response to know the validation outcome."_

- When a bank account or VPA is **invalid** or inactive, the validation process still finishes with:
  - `status: "completed"` (firing `fund_account.validation.completed`)
  - `results.account_status: "invalid"` (or `"inactive"` on `validation_results`)
  - `results.registered_name: null`
- `status: "failed"` (`fund_account.validation.failed`) fires when an upstream banking/NPCI failure or timeout prevented RazorpayX from completing the ₹1 penny drop or UPI collection window.

Always inspect `summary.accountStatus === "valid"` via `summariseFundAccountValidation(raw)` (requiring **both** `raw.status === "completed"` and `account_status === "active"`).

---

## 3. Wire Schema Quirk: `results` vs `validation_results`

RazorpayX returns two different result object keys depending on validation mode and delivery channel:

| Validation Mode                      | Request Payload                                                                    | Result Object Key in API Response                                                                                                                                        | Result Object Key in Webhook     |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| **Standard Bank Account Penny Drop** | `{ account_number, fund_account: { id: "fa_..." }, amount: 100, currency: "INR" }` | `results: { account_status, registered_name }`                                                                                                                           | `results`                        |
| **VPA Composite Penny Drop**         | `{ source_account_number, validation_type: "pennydrop", fund_account: { ... } }`   | `validation_results: { account_status, registered_name, name_match_score, details }`                                                                                     | `results`                        |
| **Reverse Penny Drop (UPI Intent)**  | `{ source_account_number, validation_type: "upi_intent", reference_id }`           | `validation_results: { account_status, registered_name, name_match_score, bank_account: { bank_routing_code, account_number, bank_name, account_type } }` + `upi_intent` | `validation_results` / `results` |

`summariseFundAccountValidation` normalizes `raw.validation_results ?? raw.results ?? null` so both REST polling and webhook handlers consume a single `FundAccountValidationSummary`.

---

## 4. Dual Completion Path: Client Polling + `fund_account.validation.*` Webhooks

On mobile or desktop QR flows, consultants frequently scan the ₹1 UPI Intent QR code (`gpayUrl`, `phonepeUrl`, `paytmUrl`, `bhimUrl`, or `encodedQrCode`), approve the ₹1 payment in their UPI app, and **close or background the browser tab before returning to Familiarise**. Relying on client polling alone (`settleReversePennyDrop`) orphaned verified accounts whenever the browser tab disconnected.

To guarantee zero-loss payout account onboarding:

1. **Start (`startReversePennyDrop(consultantProfileId)`)**:
   - Calls `POST /v1/fund_accounts/validations` with `source_account_number: RAZORPAYX_ACCOUNT_NUMBER`, `validation_type: "upi_intent"`, and `reference_id: consultantProfileId`.
   - Returns `{ validationId: "fav_...", upiIntent }` with UPI app links and QR code (RazorpayX refunds the ₹1.00 automatically within T+2 working days).
2. **Path A — Interactive Client Poll (`settleReversePennyDrop(consultantProfileId, validationId)`)**:
   - Polls `GET /v1/fund_accounts/validations/:fav_id` and verifies `validation.referenceId === consultantProfileId` (`404 RPD_NOT_YOURS` on mismatch).
   - Acquires short-lived Redis mutex `rpd:settle:<validationId>` (30s TTL), creates RazorpayX Contact + FundAccount (`fa_...`), and writes the verified `PayoutAccount` row in Postgres.
3. **Path B — Server-Side Webhook Completion (`fund_account.validation.completed` / `fund_account.validation.failed`)**:
   - Verified at `POST /api/webhooks/razorpay` via `isPayoutEventName(body)` (`event.startsWith("fund_account.")`) under `RAZORPAYX_WEBHOOK_SECRET` (or `RAZORPAY_WEBHOOK_SECRET`), deduplicated on `${eventType}:${entityId}:${sha256(rawBody).slice(0, 16)}`.
   - Normalizes both standard penny-drop (`results`) and RPD (`validation_results`) payloads through `summariseFundAccountValidation` (`lib/payments/payouts/razorpay-payouts.ts`), requiring `eventType === "fund_account.validation.completed"` **and** explicit `accountStatus === "valid"` (`account_status === "active"`).
   - Matches authoritatively on `razorpayFundAccId` (`PayoutAccount`) / `razorpayFundAccountId` (`OrganizationPayoutAccount`) when present — never joining `razorpayFundAccId` and `consultantProfileId` via `OR` — so swapping bank accounts mid-validation never marks an unvalidated replacement account as verified.
   - On `fund_account.validation.failed` (or non-active validation outcome): transitions `OrganizationPayoutAccount` (`PENDING_VERIFICATION -> FAILED_VERIFICATION`) via CAS `updateMany` without verifying invalid accounts.

---

## Deprecated & Superseded Approaches

- **Client-Polling-Only RPD Settlement**: Superseded by dual client-polling + `fund_account.validation.{completed,failed}` webhook settlement because consultants scanning ₹1 UPI QR codes on mobile routinely close the browser tab after approving payment in their UPI app.
- **Rejecting `fund_account.*` Webhooks Under `RAZORPAYX_WEBHOOK_SECRET`**: Superseded by extending `isPayoutEventName` to accept `fund_account.*` alongside `payout.*`.
