# Wallet and funding ledger

Sponsor orgs with `fundingSource = WALLET` hold a paise-denominated
balance on `BillingAccount.walletBalance`. Every mutation is recorded
as an immutable `WalletEntry` row plus a mirroring `FundingLedgerEntry`
in the same transaction. The tri-table `OrgCreditPool` / `OrgCreditLedger`
/ `OrgCreditPurchase` trio from the pre-Arch-4 schema is gone.

## Schema

```prisma
model BillingAccount {
  id            String        @id
  ownerOrgId    String        @unique
  fundingSource FundingSource
  walletBalance Int?          // paise; null for non-WALLET sources
  walletLedger  WalletEntry[]
  ...
}

model WalletEntry {
  id               String        @id @default(uuid())
  billingAccountId String
  deltaPaise       Int           // signed: + topup, - debit
  reason           WalletReason  // TOPUP | BOOKING | REFUND | ADJUSTMENT
  balanceAfter     Int
  paymentId        String?
  membershipId     String?
  providerOrderId  String?       @unique   // idempotency key for top-ups
  providerPaymentId String?
  notes            String?
  createdAt        DateTime @default(now())
  ...
}

model FundingLedgerEntry {
  id                String @id @default(uuid())
  billingAccountId  String
  deltaPaise        Int
  reason            FundingReason  // TOPUP | BOOKING_DEBIT | REFUND_CREDIT | ADJUSTMENT | GRANT
  balanceAfterPaise Int
  paymentId         String?
  walletEntryId     String? @unique
  ...
}
```

The two tables answer different questions:

- `WalletEntry` is the user-facing wallet history (paginated in the
  dashboard).
- `FundingLedgerEntry` is the lower-level tri-ledger entry (see
  `18-three-ledger-discipline.md`). A single user-facing top-up writes
  one of each in lock-step.

## Atomic debit

`walletDebit()` in `lib/api/organizations/wallet.ts` is the only path
that reduces the balance. It uses a raw `UPDATE ... WHERE
walletBalance >= :amount` conditional update so two concurrent
transactions cannot overdraft:

```ts
UPDATE "BillingAccount"
SET "walletBalance" = "walletBalance" - ${amountPaise}
WHERE "id" = ${billingAccountId}
  AND "walletBalance" IS NOT NULL
  AND "walletBalance" >= ${amountPaise}
```

Zero rows updated → `WalletInsufficientFundsError` thrown. The caller
must be inside a Prisma transaction; the helper refuses positive-only
amounts and refuses to run on non-WALLET accounts.

After the conditional update succeeds, the helper writes the
`WalletEntry` (with `balanceAfter` read back from the updated row) and
the mirroring `FundingLedgerEntry`, all in the same transaction.

## Atomic credit

`walletCredit()` is the inverse; it runs an unconditional
`SET walletBalance = COALESCE(walletBalance, 0) + :amount` and writes
the same two rows. Used for:

- Top-up confirmation (webhook path).
- Refund credit when a booking is reversed.
- ADJUSTMENT rows (manual admin grants).

## Top-up flow (Razorpay-only in v1)

1. **Initiate.** `POST /api/organizations/[orgId]/billing-account/wallet/top-ups`
   (OWNER only) accepts `{ amountPaise, clientIdempotencyKey }`.
   - `WalletEntry` is inserted with `deltaPaise = 0, balanceAfter = 0`
     and `providerOrderId` set (the idempotency key).
   - `@unique` constraint on `WalletEntry.providerOrderId` guarantees
     a duplicate POST hits a conflict instead of creating a second row.
   - `OrgAuditLog(WALLET, WALLET_TOPUP)` captures the initiation.
2. **Client checkout.** Razorpay order is created with the same order
   id; client completes payment.
3. **Confirm.** `confirmTopUp()` is called from the Razorpay webhook
   at `/api/webhooks/razorpay` with `(providerOrderId,
   providerPaymentId, amountPaise)`.
   - Inside a transaction it calls `walletCredit()` to add the real
     amount and write the real ledger rows.
   - The placeholder `deltaPaise=0` row is deleted after the real
     credit lands.
   - Idempotency: if the placeholder is already gone (retry), the
     call returns `{ confirmed: false }` and nothing else changes.

## Booking debit

Checkout calls `walletDebit()` inside the same transaction that
persists the `Payment`, the `PaymentLeg(source=WALLET)`, and the
`BookingUtilization` / `UsageLedgerEntry` rows. If any of those fail,
the wallet debit rolls back with everything else — there is no
compensating action needed. See `15-concurrency-and-locking.md`.

## Refunds

Refund reversal runs `walletCredit(reason: REFUND)` and also calls
`reverseBookingUtilization()` to post an opposing `UsageLedgerEntry`
and stamp `BookingUtilization.reversedAt`. The original utilization
row is never deleted — partial refunds require more than one reversal
pass, and point-in-time queries ("was this seat in use on 2026-04-10?")
must still find the original row.

## `WalletReason` vs `FundingReason`

The two enums look similar but serve different audiences:

| `WalletReason` | `FundingReason` | Notes |
|----------------|------------------|-------|
| `TOPUP`        | `TOPUP`          | 1:1 |
| `BOOKING`      | `BOOKING_DEBIT`  | renamed for ledger clarity |
| `REFUND`       | `REFUND_CREDIT`  | renamed |
| `ADJUSTMENT`   | `ADJUSTMENT`     | 1:1 |
| —              | `GRANT`          | platform-side grant; no corresponding WalletEntry |

## Wallet invariants

- Sum of `FundingLedgerEntry.deltaPaise` for a billing account should
  equal `BillingAccount.walletBalance`.
- Sum of `WalletEntry.deltaPaise` for a billing account should equal
  `BillingAccount.walletBalance`.
- Every `WalletEntry(deltaPaise < 0)` has a corresponding `PaymentLeg`
  with `source = WALLET`.
- A WALLET BillingAccount's `walletBalance` is never negative (enforced
  by the conditional UPDATE).

A nightly reconciliation cron is wired through
`scripts/reconcile/reconcile-ledgers.ts::runReconcileLedgers`
(triggered via admin route `POST /api/admin/reconcile-ledgers`). It
audits wallet-balance drift, funding-ledger mirror parity, settlement
coverage, and `ProgramAssignment.engagementsUsed` drift. See
`19-harness-verdict.md` row 19.

## Related docs

- `02-funding-and-programs.md` — the WALLET funding source.
- `15-concurrency-and-locking.md` — the conditional-UPDATE pattern.
- `18-three-ledger-discipline.md` — where FundingLedgerEntry sits in
  the tri-ledger model.
- `20-payment-legs.md` — how a WALLET leg is stacked with other legs.
