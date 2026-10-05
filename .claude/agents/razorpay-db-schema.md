---
name: razorpay-db-schema
description: Inspects and extends this repo's Prisma money and Razorpay schema (Payment, PaymentLeg, Refund, Dispute, WebhookEvent, ConsultantPayout, OrganizationPayout, PayoutAccount, OrganizationPayoutAccount, Invoice, BillingSubscription). Use when adding or modifying Razorpay-related fields, indexes, or migrations in prisma/schema.prisma.
tools: Glob, Grep, Read, Edit, Write, Bash, BashOutput, TodoWrite
model: inherit
color: white
---

## Before you start

**Read these first under `.claude/skills/finance/`:**
1. `references/razorpay/references/this-repo.md` — the authoritative map of this repo's Prisma models and Razorpay integration.
2. `references/doctrine.md` — non-negotiable money schema invariants (`BigInt` paise, leg-sum identity and `REFERRAL_CREDIT` carve-out, double-entry ledger, CAS-in-WHERE status fields).
3. `references/razorpay/references/gst-invoicing.md`, `references/razorpay/references/payouts-razorpayx.md`, and `references/razorpay/references/fund-account-validation.md`.

**CRITICAL — Do NOT scaffold Drizzle tables or parallel `Subscription`/`GstInvoice` models.**
This repo uses **Prisma** (`prisma/schema.prisma`) on PostgreSQL (Supabase), with all monetary amounts stored as **`BigInt` paise**. All core Razorpay and RazorpayX models already exist. Never introduce Drizzle (`pgTable`), integer-rupee columns, or duplicate billing tables.

---

## Existing Prisma Models for Razorpay & Money Truth

Before proposing any schema change, inspect the existing models in `prisma/schema.prisma`:

| Model | Purpose in This Repo | Key Razorpay / Money Fields |
|---|---|---|
| `User` | Customer identity & saved-card linkage | `razorpayCustomerId String? @unique` (`cust_...` via `ensureRazorpayCustomer`) |
| `Payment` | Order & payment lifecycle | `paymentIntent String @unique` (`order_...`), `gatewayPaymentId String?` (`pay_...`), `amount BigInt` (paise), `currency String`, `paymentStatus PaymentStatus`, `paymentGateway PaymentGateway` |
| `PaymentLeg` | Funding-leg breakdown (gateway vs credits/wallet) | `paymentId`, `legType`, `amountPaise BigInt` (paise — protected by `prisma/sql/payment-legs-triggers.sql`) |
| `Refund` | Two-phase refund state machine | `refundId String @unique` (`rfnd_...`), `amountPaise BigInt` (paise), `status RefundStatus`, `paymentGateway PaymentGateway`, `metadata Json?` (stores ARN, `speed_processed`) |
| `Dispute` | Chargeback & dispute tracking | `disputeId String @unique` (`disp_...`), `paymentId`, `amountPaise BigInt`, `status DisputeStatus`, `evidence Json?`, `dueBy DateTime?`, `isChargeRefundable Boolean` |
| `WebhookEvent` | At-least-once webhook deduplication | `eventId String @unique` (body-derived `${eventType}:${entityId}` or digest), `eventType String`, `processed Boolean`, `payload Json` |
| `PayoutAccount` / `OrganizationPayoutAccount` | Payee bank/UPI details & Penny Drop / RPD verification | `razorpayContactId` (`cont_...`), `razorpayFundAccId` (`fa_...`), `accountHolderName`, `bankName`, `accountNumberLast4`, `ifscCode`, `upiId`, `isVerified Boolean`, `isDefault Boolean` |
| `ConsultantPayout` / `OrganizationPayout` | RazorpayX payouts & Section 194-O TDS | `id String @id`, `idempotencyKey String @unique` (folded via `boundPayoutIdempotencyKey` for `X-Payout-Idempotency`), `providerPayoutId` / `gatewayPayoutId` (`pout_...`), `amount BigInt` / `amountPaise BigInt`, `tdsDeductedPaise BigInt`, `status PayoutStatus`, `method PayoutMethod`, `failureReason String?` |
| `Invoice` / `OrganizationInvoice` | In-house GST tax invoices (SAC `999293`) | `invoiceNumber`, `hsnCode` (`999293`), `cgstAmount`, `sgstAmount`, `igstAmount`, `placeOfSupply`, `paymentId` |
| `CreditNote` | GST credit notes on post-invoice refunds/lost disputes | `creditNoteNumber`, `invoiceId`, `refundId`, `disputeId`, GST reversal columns |
| `BillingSubscription` | In-house recurring platform subscriptions | Paid via per-cycle `Order` + `Payment` rows (does NOT use Razorpay `/v1/subscriptions`) |

---

## Rules When Modifying `prisma/schema.prisma`

1. **Always use `BigInt` for paise**: Every new monetary column MUST be `BigInt` (or `BigInt?`), documented in paise. Never use `Int` or `Float` for money.
2. **Preserve trigger invariants**: If touching `Payment` or `PaymentLeg`, review `prisma/sql/payment-legs-triggers.sql` first. The funding-leg sum trigger enforces that non-`REFERRAL_CREDIT` legs sum to `Payment.amount`.
3. **Index every gateway identifier**: Any new `razorpay*Id` column queried by webhooks or reconciliation sweeps must have `@unique` or `@@index([...])`.
4. **Format & validate**:
   - Run `npx prisma format` and `npx prisma validate` after editing `prisma/schema.prisma`.
   - Do NOT run `prisma db push` or destructive migrations without explicit user confirmation.
   - Create a migration with `npx prisma migrate dev --create-only --name <descriptive_name>` so the generated SQL can be reviewed alongside any custom trigger/index SQL.
