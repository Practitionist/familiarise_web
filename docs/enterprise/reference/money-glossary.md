# Money Terminology Glossary

> **TL;DR for new contributors:** There are five ways money moves in Familiarise.
> Scroll to the [Plain-English Summary](#plain-english-summary) first, then use
> the [Glossary Entries](#glossary-entries) as a reference when you hit an
> unfamiliar term in the codebase.

---

## Plain-English Summary

### Refund vs Reimbursement vs Payout vs Referral vs Credits

**Refund** — Money flowing *back to the consultee (buyer)*.  
A consultee books a ₹5,000 consultation, pays Razorpay, the consultant cancels.
The ₹5,000 (minus any platform deductions) is returned to the consultee's original
payment method or to their Familiarise wallet. Code: `Refund` model,
`lib/payments/operations/refund.ts`. Status machine: `PENDING → PROCESSING →
COMPLETED | FAILED`.

**Reimbursement** — Money flowing *from an org to its own learner/consultant member*
to cover org-sponsored spend.  
An org learner (LEARNER role in a `canSponsor` org) pays for a subscription out of
pocket. The org owes them back the cost. Code: `OrganizationReimbursement` model,
`/api/organizations/[orgId]/reimbursements`. This is **not** a refund — the money
goes from org → member, not from platform → original card.

**Payout** — Money flowing *from the platform to a consultant (seller)*.  
After a consultation is completed, the platform collects the consultee's payment,
deducts its commission + TDS, and transfers the remainder to the consultant's bank
account (RazorpayX fund account). Code: `Payout` model (consultant-level),
`OrganizationPayout` model (org-level, for consultants working under an org),
`lib/payments/payouts/`.

**Referral** — A marketing mechanism where a consultant shares a link and earns a
bonus when someone signs up via that link.  
Code: `ReferralCode`, `Referral`, `ReferralCredit`, `ReferralCreditUsage`.
The bonus is stored as a `WalletEntry` with `reason = REFERRAL_BONUS`.
This is **not** a payment from a buyer; it is a platform-funded incentive.

**Credits** — A balance in the consultee's platform wallet usable to pay for future
bookings.  
Credits come from: referral bonuses (`REFERRAL_BONUS`), org-funded pools
(`LICENSE_PURCHASE`), trial waivers, or manual admin grants. They reduce the card
charge at checkout. Code: `WalletEntry` with `reason: WalletReason`, used as
`PaymentLeg.source = REFERRAL_CREDIT` during checkout.

---

## Money Flow Diagram

```
CONSULTEE (buyer)
  │
  │  pays via card / wallet / credits
  ▼
PAYMENT (Payment model — organizationId tagged if org-sponsored)
  │
  ├─► platform commission (deducted inline)
  │
  ├─► PaymentLeg[] — one row per funding source
  │     CARD | WALLET | INVOICE_ACCRUAL | LICENSE | REFERRAL_CREDIT
  │
  ▼
CONSULTANT EARNINGS (ConsultantEarnings)
  │  status: PENDING_TRUST → PENDING → RELEASED → PAID
  │
  ├─► TDS deducted (TDSRecord, Section 194-O / 194J / 194C)
  │
  ▼
PAYOUT (Payout — direct to consultant bank via RazorpayX)
  │
  └─► if org-mediated: OrganizationPayout → org bank account first
        then org reimburses consultant per arrangement

REFUND path:
  PAYMENT ──refund_initiated──► Refund ──► consultee original method / wallet

REIMBURSEMENT path:
  LEARNER pays out of pocket ──► OrganizationReimbursement ──► org pays back learner

REFERRAL path:
  REFERRAL_CODE shared by consultant ──► new user signs up
  ──► ReferralCredit created ──► WalletEntry (REFERRAL_BONUS)
  ──► usable at checkout as PaymentLeg.source = REFERRAL_CREDIT
```

---

## Glossary Entries

### Core payment models

**Payment**  
One charge event. A consultee books a ₹5,000 consultation; one `Payment` row is
created with `amountPaise = 500000`, `status`, `razorpayOrderId`, `organizationId`
(nullable — set when the booking is made under an org context). A single Payment may
have multiple `PaymentLeg` rows when the buyer pays from more than one source.

**PaymentLeg**  
A sub-row of `Payment`. Every distinct funding source used in one checkout generates
one `PaymentLeg`. Example: consultee uses ₹1,000 referral credit + ₹4,000 card →
two legs. Possible `source` values: `CARD`, `WALLET`, `INVOICE_ACCRUAL` (org on
30-day invoice terms), `LICENSE` (pre-purchased seat), `REFERRAL_CREDIT`.  
See `docs/enterprise/20-payment-legs.md` for the full matrix.

**PaymentLegSource** (enum)  
`CARD | WALLET | INVOICE_ACCRUAL | LICENSE | REFERRAL_CREDIT`

---

### Refund models

**Refund**  
A reversal of a previous `Payment`. Created by `lib/payments/operations/refund.ts`
(the canonical refund op). Stores `amountPaise`, `reason`, `initiatedBy`,
`razorpayRefundId`, and the status machine.

**RefundStatus** (enum, see `prisma/schema.prisma:3190`)  
`PENDING | SUCCEEDED | FAILED | CANCELLED` — the gateway-aligned terminal state on success is `SUCCEEDED` (matches Razorpay's `refund.processed` event), not `COMPLETED`.

---

### Earnings models

**ConsultantEarnings**  
One row per `Payment`, tracking how much the consultant is owed after the platform
takes its commission. Fields: `grossAmountPaise`, `commissionPaise`,
`netAmountPaise`, `tdsDeductedPaise`, `status`.

**EarningStatus** (enum, see `prisma/schema.prisma:3235`)  
`PENDING | HELD | READY | PAID | REFUNDED | PENDING_TRUST` — `PENDING_TRUST` is
the initial state for earnings accrued from a `PENDING_VERIFICATION` INVOICE-funded
org (per #687 invoice-fraud guard). The `release-pending-trust-earnings` cron flips
these to `PENDING` once the org transitions to `ACTIVE` or pays an invoice. `HELD`
is reserved for extended dispute holds. `REFUNDED` is the terminal state when a
payment is refunded to the consultee.

**OrganizationEarnings**  
Like `ConsultantEarnings` but attributed to the hosting org instead. Created
alongside `ConsultantEarnings` when the appointment's `organizationId` is set.

---

### Payout models

**Payout**  
The actual bank transfer to a consultant. Created in batches by
`lib/payments/payouts/payout-service.ts`. Linked to one or more `ConsultantEarnings`
rows via `PayoutEarning`. Fields: `amountPaise`, `tdsDeducted`, `tdsRateApplied`,
`status`, `batchId`, `razorpayPayoutId`, `utr`.

**OrganizationPayout**  
A transfer to an org's bank account (for orgs where `payoutArrangement = VIA_ORG`).
The org then pays its consultants per private arrangement. Fields mirror `Payout`
plus `clawbackAmountPaise` / `clawbackInitiatedAt` for when a disputed transaction
means the org must return money to the platform.

**PayoutStatus** (enum, see `prisma/schema.prisma:3250`)  
`PENDING | APPROVED | PROCESSING | COMPLETED | FAILED | CANCELLED` — note `APPROVED` is the post-batch-approval, pre-gateway-submission state. There is no `REVERSED` value on this enum; reversal lifecycle for `OrganizationPayout` is tracked separately via the `clawbackInitiatedAt` / `clawbackAmountPaise` fields on the row.

**PayoutAccount**  
The consultant's registered bank account / UPI address used for RazorpayX payouts.
Encrypted at rest (`lib/security/bank-account-encryption.ts`). Fields: `accountType`
(`BANK | UPI`), `accountHolderName`, `ifsc`, `encryptedAccountNumber`.

**OrganizationPayoutAccount**  
Same but for an org's bank. Used by `OrganizationPayout`.

---

### Billing account models

**BillingAccount**  
Top-level container for an org's payment method preferences. Links to `FundingSource`
(how the org funds bookings: `WALLET | INVOICE`) and `LicensedSeatConfig` /
`CreditPoolConfig` (prepaid capacity).

**FundingSource** (enum, see `prisma/schema.prisma:779`)  
`PERSONAL | LICENSE | WALLET | INVOICE | PROJECT`  
- `PERSONAL` — learner pays own card; `Payment.organizationId` tagged for reporting only.
- `LICENSE` — flat enterprise license (formerly `PREPAID_UNLIMITED`).
- `WALLET` — credit pool, prepaid (formerly `SEAT_PACK`).
- `INVOICE` — NET-X postpaid (formerly `INVOICED_MONTHLY`).
- `PROJECT` — reserved for v2; checkout fails fast on this value.

**WalletEntry**  
One debit or credit in the consultee/org wallet. Fields: `amountPaise`, `direction`
(`CREDIT | DEBIT`), `reason: WalletReason`.

**WalletReason** (enum, see `prisma/schema.prisma:889`)  
`TOPUP | BOOKING | REFUND | ADJUSTMENT` — note the Prisma enum is intentionally
small. Sub-classification (e.g. referral bonuses, license purchases) lives on
adjacent rows like `ReferralCredit` / `FundingLedgerEntry.reason`, not on
`WalletReason` itself.

---

### Program & seat models

**Program**  
An org's configured learning/consulting engagement. Type is `ProgramType`:
`COHORT | MANAGED | PROJECT | RETAINER` (PROJECT/RETAINER are reserved in schema,
no config tables yet).

**LicensedSeatConfig**  
Pre-purchased fixed seats for a cohort-style program. `seatCount × pricePerSeat`.
A seat = one `BookingUtilization` allocation.

**CreditPoolConfig**  
A floating budget (in paise) that any learner in the program can draw from. Used for
MANAGED programs where call counts vary per learner.

**ProgramAssignment**  
Links a `User` to a `Program`. Created when an org MANAGER assigns a learner to a program.

**BookingUtilization**  
Tracks usage of one seat or one credit pool draw. Created at checkout when an org
sponsors a booking. Fields: `programAssignmentId`, `paymentId`, `seatsUsed`,
`creditsUsedPaise`, `reversedAt` (set on refund).

---

### Invoice models

**OrganizationInvoice**  
Monthly invoice issued to orgs on `INVOICE` funding mode. Aggregates all
`Payment.organizationId = orgId` payments for the month.

**OrgInvoiceStatus** (enum, see `prisma/schema.prisma:1415`)  
`DRAFT | ISSUED | PAID | OVERDUE | VOID | CANCELLED | REFUNDED` — `VOID` is the
pre-payment cancel state; `REFUNDED` is the post-payment terminal state when a
PAID invoice is fully refunded at the gateway.

**Invoice** (consultant-facing)  
A receipt issued to a consultee after a paid booking. Not the same as
`OrganizationInvoice`. Includes GST breakdown (`cgst`, `sgst`, `igst`).

**IrpStatus** (enum, see `prisma/schema.prisma:1428`)  
`PENDING | GENERATED | CANCELLED | FAILED` — tracks ClearTax IRP e-invoice
generation. India GST mandate for B2B invoices above ₹5L turnover. Note: when
CLEARTAX env vars are unset, the upload helper currently returns `FAILED` — this
is a known issue (a `SKIPPED`/`CONFIG_MISSING` value should be added so stub mode
is distinguishable from a real upload failure; tracked in #732).

**PurchaseOrder**  
An org's internal PO number attached to a contract. Fields: `poNumber`, `amountPaise`,
`currency`, `status: PoStatus`.

**PoStatus** (enum, see `prisma/schema.prisma:1435`)  
`ACTIVE | CLOSED | CANCELLED`

---

### Pricing models

**RateCard**  
A custom price list created by org-level negotiation. Overrides the consultant's
public plan prices for members of a specific org.

**DiscountCode**  
Promo codes. `discountType: DiscountType` (`PERCENTAGE | FLAT`), optional `organizationProfileId`
to make a code org-private (not yet implemented — tracked in deferred backlog issue).

---

### Referral models

**ReferralCode**  
A unique short code tied to a `ConsultantProfile`. Shared to attract new users.

**Referral**  
Created when a new user signs up via a `ReferralCode`. Links `referrerId` →
`referredUserId`.

**ReferralCredit**  
The reward earned by a referrer after the referred user completes their first paid
booking. Amount in paise.

**ReferralCreditUsage**  
Records each time a `ReferralCredit` is consumed at checkout as a `PaymentLeg`.

**CreditSource** (enum, see `prisma/schema.prisma:3611`)  
`REFERRAL_BONUS | REFEREE_BONUS | PROMOTION | COMPENSATION | MANUAL` — the origin
of a credit grant. `PROMOTION` and `COMPENSATION` are reserved in the schema (no
flows yet); `MANUAL` is for admin-issued one-off grants.

---

### Dispute models

**Dispute**  
A chargeback or formal complaint raised by a consultee against a payment. Fields:
`paymentId`, `status: DisputeStatus`, `razorpayDisputeId`, `evidenceDueBy`.

**DisputeStatus** (enum, see `prisma/schema.prisma:3222`)  
`WARNING_NEEDS_RESPONSE | WARNING_UNDER_REVIEW | WARNING_CLOSED | NEEDS_RESPONSE | UNDER_REVIEW | CHARGE_REFUNDED | WON | LOST` — the `WARNING_*` prefix tracks
Razorpay's early-fraud-warning lifecycle, which is distinct from a formal
dispute. `CHARGE_REFUNDED` covers the platform-accept-and-refund path.

---

### Three-ledger models

These three ledger tables are the accounting source of truth. Product-side models
(`Payment`, `Payout`, etc.) are the operational view; ledger tables are the
double-entry accounting view. See `docs/enterprise/18-three-ledger-discipline.md`.

**UsageLedgerEntry**  
Records every capacity draw — a seat used, a credit drawn, a session deducted.

**FundingLedgerEntry**  
Records every top-up, debit, and adjustment in an org's wallet. See
`prisma/schema.prisma:1639` for the actual reason enum.  
`reason: FundingReason` = `TOPUP | BOOKING_DEBIT | REFUND_CREDIT | ADJUSTMENT | GRANT`.

**SettlementLedgerEntry**  
Records every money-movement event — invoice issue/pay, payment receipt, refund,
payout, chargeback, credit note. See `prisma/schema.prisma:1647`.  
`kind: SettlementKind` = `INVOICE_ISSUED | INVOICE_PAID | PAYMENT_RECEIVED | REFUND_ISSUED | PAYOUT_SENT | PAYOUT_REVERSED | CHARGEBACK | CREDIT_NOTE`.
Note: `PAYOUT_REVERSED` is the counter-entry written when a `PAYOUT_SENT` is
reclaimed (admin cancel or gateway failure) — this is the ledger-side analogue
of the `OrganizationPayout.clawbackInitiatedAt` field.

---

### NOT a model (common misconceptions)

**Reimbursement** is not a Prisma model name — it is a concept represented by
`OrganizationReimbursement`. The UI says "Reimbursements"; the API endpoint is
`/api/organizations/[orgId]/reimbursements`.

**Clawback** is not a model — it is a set of fields on `OrganizationPayout`:
`clawbackAmountPaise`, `clawbackInitiatedAt`. A clawback occurs when the platform
must recover money from an org after a dispute is lost.

**Credits** is not a model — credits are `WalletEntry` rows with a positive
`direction = CREDIT`. The UI surfaces them as a balance. `CreditSource` is the enum
that classifies *why* the credit exists.

---

## Cross-References

| Topic | Doc |
|-------|-----|
| Earnings pipeline (how net pay is computed) | `docs/enterprise/03-earnings-and-revenue.md` |
| Wallet & ledger mechanics | `docs/enterprise/09-wallet-and-ledger.md` |
| Invoice lifecycle (org invoices + IRP) | `docs/enterprise/10-invoicing.md` |
| Three-ledger discipline | `docs/enterprise/18-three-ledger-discipline.md` |
| PaymentLeg source matrix | `docs/enterprise/20-payment-legs.md` |
| Payout pipeline (TDS, RazorpayX, clawback) | `docs/enterprise/07-payout-pipeline.md` |
| Org billing modes (WALLET vs INVOICE) | `docs/enterprise/02-funding-and-programs.md` |
