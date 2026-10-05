# RazorpayX Fund Account Validation (Penny Drop & Reverse Penny Drop)

Official citations:
- [Fund Account Validation Overview](https://razorpay.com/docs/x/fund-account-validation/)
- [Account Validation API Overview](https://razorpay.com/docs/api/x/account-validation/)
- [Validate a Bank Account (Penny Drop)](https://razorpay.com/docs/api/x/account-validation/bank-account/)
- [Validate a VPA (Composite Penny Drop)](https://razorpay.com/docs/api/x/account-validation/vpa/)
- [Reverse Penny Drop (`upi_intent`)](https://razorpay.com/docs/api/x/account-validation/reverse-penny-drop/)
- [Account Validation Webhooks](https://razorpay.com/docs/webhooks/account-validation/)

## Where It Lives in This Repo

| File | Responsibility |
|---|---|
| [`lib/payments/payouts/razorpay-payouts.ts`](../../../../../lib/payments/payouts/razorpay-payouts.ts) | `validateBankAccount(fundAccountId)`, `createReversePennyDrop({ referenceId, notes })`, `fetchFundAccountValidation(validationId)`, and `summariseFundAccountValidation(raw)` (normalizes both `results` and `validation_results`). |
| [`lib/payments/payouts/reverse-penny-drop.ts`](../../../../../lib/payments/payouts/reverse-penny-drop.ts) | `startReversePennyDrop(consultantProfileId)` and `settleReversePennyDrop(consultantProfileId, validationId)` — manages the UPI Intent ₹1 verification flow, Redis lock (`rpd:settle:<validationId>`), and reference-only `PayoutAccount` creation. |

---

## 1. Critical Availability & Mode Constraints

1. **NOT Available in Test Mode**:
   - Every official RazorpayX Account Validation page states: *"Account Validation is **not available in test mode** and is possible **only for RazorpayX Lite**."*
   - In preview/dev/test environments, `createReversePennyDrop` will be refused by RazorpayX. In [`lib/payments/payouts/reverse-penny-drop.ts`](../../../../../lib/payments/payouts/reverse-penny-drop.ts), `gatewayCall` catches `PaymentError` and returns a clean `503 RPD_UNAVAILABLE` refusal instructing the consultant to add their bank account manually.
2. **Never Persist Full Bank Account Numbers**:
   - Even when Reverse Penny Drop returns `validation_results.bank_account.account_number` in memory, [`persistVerifiedAccount`](../../../../../lib/payments/payouts/reverse-penny-drop.ts) immediately creates the RazorpayX Contact + FundAccount (`fa_...`) and stores **only** `accountNumberLast4`, `ifscCode`, `bankName`, `accountHolderName`, `razorpayContactId`, and `razorpayFundAccId` on `PayoutAccount`.

---

## 2. The #1 Gotcha: `status: "completed"` Does NOT Mean the Account Is Valid

From [Official RazorpayX Account Validation Docs](https://razorpay.com/docs/api/x/account-validation/bank-account/):
> *"The `completed` status does not determine if a fund account is valid or not. It only notifies you that the validation process has been completed. Refer to the `results` parameter in the response to know the validation outcome."*

- When a bank account or VPA is **invalid**, the validation process still finishes with:
  - `status: "completed"` (and fires `fund_account.validation.completed`)
  - `results.account_status: "invalid"` (or `"inactive"` on `validation_results`)
  - `results.registered_name: null`
- `status: "failed"` (`fund_account.validation.failed`) only fires when an internal or partner-bank outage prevented RazorpayX from executing the validation at all.

### How `summariseFundAccountValidation` Normalizes This

```ts
// lib/payments/payouts/razorpay-payouts.ts
export function summariseFundAccountValidation(
  raw: FundAccountValidationEntity,
): FundAccountValidationSummary {
  const results = raw.validation_results ?? raw.results ?? null;
  let accountStatus: FundAccountValidationSummary["accountStatus"] = "unknown";
  if (raw.status === "completed" && results?.account_status === "active") {
    accountStatus = "valid";
  } else if (
    raw.status === "failed" ||
    results?.account_status === "invalid" ||
    results?.account_status === "inactive"
  ) {
    accountStatus = "invalid";
  }
  // ...
}
```

Always check `summary.accountStatus === "valid"` (which requires **both** `raw.status === "completed"` and `account_status === "active"`).

---

## 3. Wire Schema Quirk: `results` vs `validation_results`

RazorpayX returns two different field names depending on the validation mode:

| Validation Mode | Request Payload | Result Object Key in API Response | Result Object Key in Webhook |
|---|---|---|---|
| **Standard Bank Account Penny Drop** | `{ account_number, fund_account: { id: "fa_..." }, amount: 100, currency: "INR" }` | `results: { account_status, registered_name }` | `results` |
| **VPA Composite Penny Drop** | `{ source_account_number, validation_type: "pennydrop", fund_account: { ... } }` | `validation_results: { account_status, registered_name, name_match_score, details }` | `results` |
| **Reverse Penny Drop (UPI Intent)** | `{ source_account_number, validation_type: "upi_intent", reference_id }` | `validation_results: { account_status, registered_name, name_match_score, bank_account: { bank_routing_code, account_number, bank_name, account_type } }` + `upi_intent: { intent_url, gpay_url, phonepe_url, paytm_url, bhim_url, encoded_qr_code }` | `results` |

`summariseFundAccountValidation` reads `raw.validation_results ?? raw.results ?? null` so callers get a single unified `FundAccountValidationSummary` regardless of which endpoint returned the entity.

---

## 4. Reverse Penny Drop Flow (`lib/payments/payouts/reverse-penny-drop.ts`)

1. **Start (`startReversePennyDrop(consultantProfileId)`)**:
   - Calls `POST /v1/fund_accounts/validations` with `source_account_number: RAZORPAYX_ACCOUNT_NUMBER`, `validation_type: "upi_intent"`, and `reference_id: consultantProfileId`.
   - Returns `{ validationId: "fav_...", upiIntent }` containing deep links (`intentUrl`, `gpayUrl`, `phonepeUrl`, `paytmUrl`, `bhimUrl`) and `encodedQrCode`.
   - The consultant pays ₹1.00 from their UPI app (RazorpayX automatically refunds the ₹1.00 within T+2 working days).
2. **Poll & Settle (`settleReversePennyDrop(consultantProfileId, validationId)`)**:
   - Calls `GET /v1/fund_accounts/validations/:fav_id`.
   - Verifies ownership (`validation.referenceId === consultantProfileId`) to prevent cross-account spoofing (`404 RPD_NOT_YOURS`).
   - While `validation.status === "created"`, returns `{ status: "pending" }`.
   - Once completed with `accountStatus === "valid"` and `validation.bankAccount`, acquires Redis lock `rpd:settle:<validationId>` (30s TTL), creates the RazorpayX Contact + FundAccount (`fa_...`), and writes the verified `PayoutAccount` row in a Prisma transaction.
