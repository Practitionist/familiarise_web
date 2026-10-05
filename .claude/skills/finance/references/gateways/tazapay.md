# Tazapay (`TAZAPAY`) Global Pay-ins & Foreign Consultant Payouts Reference

**Role in Familiarise**: **#1 Cross-Border Checkout (80+ Local Rails in 173+ Countries) + Multi-Currency Foreign Consultant Payout Treasury**.
**Official Docs**: `https://docs.tazapay.com/` (Tazapay v3 REST API).
**Architecture Guide**: [`docs/payments/gateways/tazapay/README.md`](../../../../docs/payments/gateways/tazapay/README.md).

---

## 1. Why Tazapay Solves Both Sides of Familiarise's Global Marketplace

1. **Explicitly Welcomes 1:1 Consulting, EdTech & Service Marketplaces**:
   - Unlike Merchant of Record platforms (Dodo Payments, Polar.sh, Lemon Squeezy), Tazapay is a licensed cross-border payment institution (**MAS Singapore MPI**, **US FinCEN MSB**, **Canada FINTRAC**, **Australia AUSTRAC**, and **RBI PA-CB In-Principle**) with dedicated verticals for **EdTech, Coaching, Professional Services, and Two-Sided Marketplaces**.
2. **80+ Local Payment Methods in 173+ Countries (No Cross-Border Card Decline Penalty)**:
   - Foreign consultees can pay via local domestic rails (**US ACH**, **EU SEPA**, **UK Faster Payments**, **Brazil Pix**, **Singapore PayNow**, **Mexico SPEI**, **Indonesia QRIS**, **Philippines GCash**, etc.) as well as **Visa, Mastercard, Amex, Apple Pay, and Google Pay**.
3. **Eliminates Double-FX & Indian Section 195 / Form 15CA/15CB Friction for Foreign Consultants**:
   - **Problem with Indian INR Gateways (RazorpayX / Cashfree)**: Foreign buyer USD is forcibly converted to INR on settlement (`~2–3%` FX loss). Paying a non-Indian consultant (US/UK/EU/SG) from an Indian bank account requires another `INR -> USD` conversion (`~2%` loss), cannot be executed via RazorpayX, and triggers **Income Tax Act Section 195 withholding + Chartered Accountant Form 15CB + Form 15CA** per outbound wire.
   - **Tazapay Multi-Currency Treasury Solution**:
     ```
     Foreign Buyer ($100 USD) ---> Tazapay USD Treasury Balance ($100 USD)
                                       |
                                       +---> 80% ($80 USD) -> Direct Local Payout (POST /v3/payout,
                                       |     purpose: "PYR003") to Foreign Consultant in 70+ countries
                                       |     (US ACH / EU SEPA / UK FPS — NO INR conversion!)
                                       |
                                       +---> 20% ($20 USD) -> Repatriated to Familiarise India Bank
                                             Account in INR with 1-Day Automated e-FIRA!
     ```

---

## 2. Tazapay v3 API Reference

- **Base URLs**:
  - Sandbox: `https://service-sandbox.tazapay.com/v3`
  - Production: `https://service.tazapay.com/v3`
- **Authentication**: HTTP Basic Auth:
  `Authorization: Basic base64(TAZAPAY_API_KEY + ":" + TAZAPAY_API_SECRET)`
- **Monetary Units**: **Integer Minor Units (`cents` / `paise`)** — matches Razorpay and our Prisma `BigInt` schema (`$100.00 USD` = `10000`).

### 2.1 Create Checkout Session (`POST /v3/checkout`)
```json
{
  "invoice_currency": "USD",
  "amount": 15000,
  "customer_details": {
    "name": "Emily Carter",
    "email": "emily@example.com",
    "country": "US"
  },
  "success_url": "https://familiarise.com/checkout/verify?gateway=TAZAPAY&ref=fam_ord_01J9X",
  "cancel_url": "https://familiarise.com/checkout/cancel?ref=fam_ord_01J9X",
  "transaction_description": "1:1 Executive Coaching Session on Familiarise",
  "reference_id": "fam_ord_01J9X",
  "metadata": {
    "appointmentId": "apt_123",
    "consultantProfileId": "con_789",
    "consultantResidency": "NON_RESIDENT"
  }
}
```
- Returns `data.id` (`chk_...` — stored in `Payment.paymentIntent`), `data.url` (hosted checkout URL), and `data.token` (for embedded JS SDK v3).

### 2.2 Register Foreign Consultant Beneficiary (`POST /v3/beneficiary`)
Used when onboarding a verified non-Indian consultant (`country !== "IN"`):
```json
{
  "name": "Dr. James Miller",
  "email": "james@stanford-example.edu",
  "type": "individual",
  "destination_details": {
    "type": "bank",
    "bank": {
      "account_number": "000123456789",
      "bank_name": "JPMorgan Chase",
      "country": "US",
      "currency": "USD",
      "bank_codes": {
        "aba_code": "021000021"
      }
    }
  }
}
```
- Returns `data.id` (`ben_...` — stored on the consultant's `PayoutAccount`).
- Supported `bank_codes` by corridor:
  - US (`USD`): `aba_code` (ACH routing number)
  - Eurozone (`EUR`): `iban` + `bic_code` (SEPA)
  - UK (`GBP`): `sort_code` + `account_number` (Faster Payments)
  - Canada (`CAD`): `transit_number` + `institution_code`
  - Australia (`AUD`): `bsb_code`
  - Singapore (`SGD`): `bank_code` + `branch_code`

### 2.3 Disburse Foreign Consultant Payout (`POST /v3/payout`)
```json
{
  "purpose": "PYR003",
  "transaction_description": "Familiarise Consultant Earnings Payout #pay_batch_42",
  "amount": 12000,
  "currency": "USD",
  "holding_currency": "USD",
  "beneficiary": "ben_clx987654321",
  "payout_type": "local",
  "reference_id": "fam_payout_01J9X888",
  "statement_descriptor": "FAMILIARISE MENTOR"
}
```
- **Purpose Code**: `"PYR003"` (*Professional, educational, or consulting services payout*).
- **Zero Double-FX**: Setting `holding_currency === currency` (e.g., `"USD"` -> `"USD"`) debits the USD collection balance directly with zero FX conversion.

---

## 3. Webhook Verification & Event Mapping (`app/api/webhooks/tazapay/route.ts`)

- Verify the `x-tazapay-signature` / Standard Webhooks HMAC-SHA256 header over the raw request body using `TAZAPAY_WEBHOOK_SECRET` and length-guarded `crypto.timingSafeEqual`.
- Deduplicate via `WebhookEvent` before dispatching.

| Tazapay Event `type` | Internal Handler Action |
| --- | --- |
| `checkout.paid` / `payment_attempt.succeeded` | Single-writer `handlePaymentSuccess` (`Serializable` `$transaction`, CAS-in-WHERE) |
| `payment_attempt.failed` / `checkout.expired` | Mark `Payment` `FAILED` if still `PENDING` |
| `refund.succeeded` / `refund.failed` | Finalize or release two-phase `Refund` reservation |
| `dispute.created` / `dispute.closed` | Upsert `Dispute` row and alert finance ops |
| `payout.succeeded` | Mark `ConsultantPayout` `SUCCEEDED` |
| `payout.failed` / `payout.reversed` | Mark `ConsultantPayout` `FAILED` via CAS-in-WHERE and restore `ConsultantEarnings` to `READY` |

---

## 4. Prisma & Guard Updates Needed When Enabling Foreign Consultant Payouts

Currently, `lib/payments/payouts/payout-service.ts` (`processSinglePayout`) and `components/payouts/IndiaOnlyPayoutNotice.tsx` block non-resident consultant payouts because RazorpayX only supports Indian INR bank/UPI payouts. When enabling `TAZAPAY`:
1. Add `TAZAPAY` to `PaymentGateway`, `PayoutMethod`, and `PayoutAccountType` in `prisma/schema.prisma`.
2. In `processSinglePayout`, allow `residencyStatus === "NON_RESIDENT"` **if and only if** `payoutAccount.gateway === "TAZAPAY"` and the underlying earnings were collected into the Tazapay foreign currency treasury (`holding_currency`). Keep the hard throw for any attempt to pay a non-resident from the domestic INR RazorpayX/Cashfree rail unless Section 195 + Form 15CA/15CB are attached.
