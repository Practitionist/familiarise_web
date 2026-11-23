# RazorpayX Fund Account Validation (Penny Drop & Reverse Penny Drop)

Official citations:

- [Fund Account Validation Overview](https://razorpay.com/docs/x/fund-account-validation/)
- [Account Validation API Overview](https://razorpay.com/docs/api/x/account-validation/)
- [Validate a Bank Account (Penny Drop)](https://razorpay.com/docs/api/x/account-validation/bank-account/)
- [Validate a VPA (Composite Penny Drop)](https://razorpay.com/docs/api/x/account-validation/vpa/)
- [Reverse Penny Drop (`upi_intent`)](https://razorpay.com/docs/api/x/account-validation/reverse-penny-drop/)
- [Account Validation Webhooks (`fund_account.validation.*`)](https://razorpay.com/docs/build/llm-docs/webhooks/account-validation.md)

## Where It Lives in This Repo

| File                                                                                                                                                                                                | Responsibility                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`lib/payments/payouts/razorpay-payouts.ts`](../../../../../lib/payments/payouts/razorpay-payouts.ts)                                                                                               | `validateBankAccount(fundAccountId, options)`, `createReversePennyDrop({ referenceId, notes })`, `fetchFundAccountValidation(validationId)`, and `summariseFundAccountValidation(raw)` (normalizes both `results` and `validation_results` plus string/number `name_match_score`). |
| [`lib/payments/payouts/reverse-penny-drop.ts`](../../../../../lib/payments/payouts/reverse-penny-drop.ts)                                                                                           | `startReversePennyDrop(consultantProfileId)`, `settleReversePennyDrop(consultantProfileId, validationId)` (client poll under `rpd:settle:<validationId>` Redis mutex), and `handleFundAccountValidationWebhook` (CAS status verification strictly bound to `fund_account.id`).     |
| [`app/api/webhooks/razorpay/signature.ts`](../../../../../app/api/webhooks/razorpay/signature.ts) & [`app/api/webhooks/razorpay-dispatch.ts`](../../../../../app/api/webhooks/razorpay-dispatch.ts) | `isPayoutEventName(body)` verifies `fund_account.*` under `RAZORPAYX_WEBHOOK_SECRET`, and `razorpay-dispatch.ts` dispatches `fund_account.validation.completed` / `fund_account.validation.failed`.                                                                                |

---

## 1. Critical Availability & Mode Constraints

1. **NOT Available in Test Mode**:
   - The [Account Validation overview](https://razorpay.com/docs/api/x/account-validation/) and the [Composite Account Validation overview](https://razorpay.com/docs/api/x/composite-account-validation/) state: _"Account Validation is not available in test mode and is possible only for RazorpayX Lite."_ The [Reverse Penny Drop page](https://razorpay.com/docs/api/x/account-validation/reverse-penny-drop/) says: _"This API is not supported in test mode."_ The [Fund Account Validation guide](https://razorpay.com/docs/x/fund-account-validation/) says only that it is "possible only for RazorpayX Lite", and the [Validate a Bank Account page](https://razorpay.com/docs/api/x/account-validation/bank-account/) states neither. The [Validate a VPA page](https://razorpay.com/docs/api/x/account-validation/vpa/) adds: _"RazorpayX Lite is currently not available for new merchants."_
   - In preview/dev/test environments, `createReversePennyDrop` is refused by RazorpayX; `gatewayCall` catches `PaymentError` and returns a clean `503 RPD_UNAVAILABLE` instructing the user to add bank details manually.
2. **Never Persist Full Bank Account Numbers**:
   - Even when Reverse Penny Drop returns `validation_results.bank_account.account_number` in memory, `persistVerifiedAccount` immediately creates the RazorpayX Contact + FundAccount (`fa_...`) and persists **only** `accountNumberLast4`, `ifscCode`, `bankName`, `accountHolderName`, `razorpayContactId`, and `razorpayFundAccId` on `PayoutAccount`.

---

## 2. The #1 Gotcha: `status: "completed"` Does NOT Mean the Account Is Valid

From the [Fund Account Validation guide](https://razorpay.com/docs/x/fund-account-validation/):

> _"The completed status does not mean the bank account or VPA is valid. It just means the account validation transaction was completed and results are available to you via the API response and webhooks payloads. Based on the response, you can decide if you should make a payout to the account."_

- The pages list `account_status` as `active` or `invalid` on the bank-account and entity pages, and as `active` or `inactive` on the Reverse Penny Drop page. The code treats `invalid` and `inactive` alike.
- In the failed samples (the bank-account page and the [account validation webhooks page](https://razorpay.com/docs/webhooks/account-validation/)), `status` is `"failed"` and both `results.account_status` and `results.registered_name` are `""`. No page shows a sample of a completed validation with an `invalid` account; the entity page says `registered_name` is "Gaurav Kumar or null".
- `status: "failed"` (`fund_account.validation.failed`) fires when an upstream banking/NPCI failure or timeout prevented RazorpayX from completing the ₹1 penny drop or UPI collection window.

Always inspect `summary.accountStatus === "valid"` via `summariseFundAccountValidation(raw)` (requiring **both** `raw.status === "completed"` and `account_status === "active"`).

---

## 3. Wire Schema Quirk: `results` vs `validation_results`

RazorpayX returns two different result object keys depending on validation mode and delivery channel:

| Validation Mode                      | Request Payload                                                                    | Result Object Key in API Response                                                                                                                                        | Result Object Key in Webhook     |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| **Standard Bank Account Penny Drop** | `{ account_number, fund_account: { id: "fa_..." }, amount: 100, currency: "INR" }` | `results: { account_status, registered_name, name_match_score }` (`name_match_score` string `"00"`/`"100"`)                                                              | `results`                        |
| **VPA Validation**                   | `{ account_number, fund_account: { id: "fa_..." } }` (**no `amount`/`currency`**)  | `results: { account_status, registered_name, name_match_score, details }`                                                                                                | `results`                        |
| **Reverse Penny Drop (UPI Intent)**  | `{ account_number, validation_type: "upi_intent", reference_id }`                  | `validation_results: { account_status, registered_name, name_match_score, bank_account: { bank_routing_code, account_number, bank_name, account_type } }` + `upi_intent` | `validation_results` / `results` |

`summariseFundAccountValidation` normalizes `raw.validation_results ?? raw.results ?? null` so both REST polling and webhook handlers consume a single `FundAccountValidationSummary`.

---

## 4. Dual Completion Path: Client Polling + `fund_account.validation.*` Webhooks

On mobile or desktop QR flows, consultants frequently scan the ₹1 UPI Intent QR code (`gpayUrl`, `phonepeUrl`, `paytmUrl`, `bhimUrl`, or `encodedQrCode`), approve the ₹1 payment in their UPI app, and **close or background the browser tab before returning to Familiarise**. Relying on client polling alone (`settleReversePennyDrop`) orphaned verified accounts whenever the browser tab disconnected.

To guarantee zero-loss payout account onboarding:

1. **Start (`startReversePennyDrop(consultantProfileId)`)**:
   - Calls `POST /v1/fund_accounts/validations` with `source_account_number: RAZORPAYX_ACCOUNT_NUMBER`, `validation_type: "upi_intent"`, and `reference_id: consultantProfileId`.
   - Returns `{ validationId: "fav_...", upiIntent }` with UPI app links and QR code (RazorpayX refunds the ₹1.00 **automatically in real time / instantly** per `reverse-penny-drop.md`).
2. **Path A — Interactive Client Poll (`settleReversePennyDrop(consultantProfileId, validationId)`)**:
   - Polls `GET /v1/fund_accounts/validations/:fav_id` and verifies `validation.referenceId === consultantProfileId` (`404 RPD_NOT_YOURS` on mismatch).
   - Acquires short-lived Redis mutex `rpd:settle:<validationId>` (30s TTL), creates RazorpayX Contact + FundAccount (`fa_...`), and writes the verified `PayoutAccount` row in Postgres.
3. **Path B — Server-Side Webhook Completion (`fund_account.validation.completed` / `fund_account.validation.failed`)**:
   - Verified at `POST /api/webhooks/razorpay` via `isPayoutEventName(body)` (`event.startsWith("fund_account.")`) under `RAZORPAYX_WEBHOOK_SECRET` (or `RAZORPAY_WEBHOOK_SECRET`), deduplicated on `${eventType}:${entityId}:${x-razorpay-event-id | sha256(rawBody).slice(0, 16)}`.
   - Normalizes both standard penny-drop (`results`) and RPD (`validation_results`) payloads through `summariseFundAccountValidation` (`lib/payments/payouts/razorpay-payouts.ts`), requiring `eventType === "fund_account.validation.completed"` **and** explicit `accountStatus === "valid"` (`account_status === "active"`).
   - Matches authoritatively on `razorpayFundAccId` (`PayoutAccount`) / `razorpayFundAccountId` (`OrganizationPayoutAccount`) when present — never joining `razorpayFundAccId` and `consultantProfileId` via `OR` — so swapping bank accounts mid-validation never marks an unvalidated replacement account as verified.
   - On `fund_account.validation.failed` (or non-active validation outcome): transitions `OrganizationPayoutAccount` (`PENDING_VERIFICATION -> FAILED_VERIFICATION`) via CAS `updateMany`, matching on `razorpayFundAccountId` when `fund_account.id` is present and falling back to `{ id: referenceId, status: "PENDING_VERIFICATION" }` when `entity.fund_account` is `null`.

---

## 5. Gateway Behaviour Read From Razorpay's Pages

Read on 2026-11-23 from the pages cited below.

- **`registered_name` is the bank's name.** It is "The name linked to the account" ([Validation entity](https://razorpay.com/docs/api/x/account-validation/entity/)) and "The account holder's full name as registered with their bank" ([Reverse Penny Drop](https://razorpay.com/docs/api/x/account-validation/reverse-penny-drop/)). In `lib/payments/payouts/reverse-penny-drop.ts`, `persistVerifiedAccount` uses it as the account holder name (falling back to the consultant's profile name), and `applyVerifiedFundAccountUpdate` on the webhook path sets `accountHolderName` only when it is present.
- **`name_match_score` is defined only on the composite pages.** [Composite Account Validation Entity](https://razorpay.com/docs/api/x/composite-account-validation/entity/) says: "A score between 0 - 100. 100 : The name provided by you and the bank registered name are the same. 0 : There is no match ... Between 0 & 100 : There is a partial match". The non-composite pages say less: "The percentage score indicating how closely the account holder's name matches the records" (entity and bank-account pages, type `string`) and "A numeric score indicating how closely ..." (Reverse Penny Drop page, type `integer`). The type disagrees across pages and so do the samples: the Reverse Penny Drop sample returns the string `"00"`, both VPA samples, including the `failed` one, return the number `100`, and `null` appears in the `created` and `failed` samples on the composite bank-account page and the failed `fund_account.validation.failed` sample on the webhooks page. A non-null score is therefore no evidence that the validation completed or that the account is active. `summariseFundAccountValidation` turns `null`, `undefined` and `""` into `null` and anything else through `Number()`, so `"00"` becomes `0`.
- **Nothing gates on the score.** `app/api/consultant/payout-accounts/[id]/route.ts` returns `nameMatchScore` to the client, and no server code compares it with a threshold.
- **The result key differs from the parameter table.** The sample responses on the bank-account page show `results` (with `account_status` and `registered_name` only), while the same page's response parameters describe `validation_results` (with `name_match_score`). The code reads `validation_results ?? results`.

Rules when changing these functions:

- Decide validity only through `summariseFundAccountValidation` (`status === "completed"` and `account_status === "active"`); never from `name_match_score` or `registered_name`.
- Keep the `validation_results ?? results` fallback and the `null`/string/number handling of `name_match_score`.
- Keep `registered_name` optional in `persistVerifiedAccount` and `applyVerifiedFundAccountUpdate`; a missing name must not block verification.
- Verify with `npx jest __tests__/payments/audit-hardening-regressions.test.ts __tests__/payments/razorpay-webhook-megafix.test.ts`.

---

## Deprecated & Superseded Approaches

- **Client-Polling-Only RPD Settlement**: Superseded by dual client-polling + `fund_account.validation.{completed,failed}` webhook settlement because consultants scanning ₹1 UPI QR codes on mobile routinely close the browser tab after approving payment in their UPI app.
- **Rejecting `fund_account.*` Webhooks Under `RAZORPAYX_WEBHOOK_SECRET`**: Superseded by extending `isPayoutEventName` to accept `fund_account.*` alongside `payout.*`.
