# Three-Ledger Discipline

**Status:** Schema-final, enforcement pending (Arch 4-Modified, Issue #681)

The Arch 4-Modified schema carries three immutable ledgers:

- `UsageLedgerEntry` — every consumed entitlement (sessions, minutes)
- `FundingLedgerEntry` — every money-like allocation (wallet top-ups,
  booking debits, refund credits, grants)
- `SettlementLedgerEntry` — every real financial settlement (invoice
  issued/paid, payment received, payout sent, refund issued, chargeback,
  credit note)

## Why three?

The three ledgers answer three different questions:

1. **"What did this member consume?"** → Usage
2. **"Where did the money go inside the platform?"** → Funding
3. **"How did the platform settle with external parties?"** → Settlement

Historically these were mixed into a single `OrgCreditLedger` + ad-hoc
`Payment` + `ConsultantEarnings` rows. Reconciling across them required
JSON joins and date heuristics.

## Invariants

1. **Rows are immutable.** No UPDATEs; corrections are posted as
   counter-entries.
2. **Every mutation to running-balance state writes a ledger row in the
   same transaction.** `walletDebit` writes both a `WalletEntry` and a
   `FundingLedgerEntry`. `recordBookingUtilization` writes a
   `BookingUtilization` + `UsageLedgerEntry`. The
   `generate-subscription-invoices` cron writes a `SettlementLedgerEntry`
   on INVOICE_ISSUED.
3. **Ledger rows carry `balanceAfter`** where applicable (Funding) so
   point-in-time reconciliation doesn't require a running sum.

## Reconciliation identities (enforced in follow-up cron)

- **Wallet identity:** Sum of `FundingLedgerEntry.deltaPaise` for a
  BillingAccount should equal `BillingAccount.walletBalance`.
- **Usage identity:** For a ProgramAssignment, sum of
  `UsageLedgerEntry.sessionsConsumed` should equal
  `ProgramAssignment.sessionsUsed`.
- **Settlement identity:** For an OrganizationInvoice, the
  `SettlementLedgerEntry(kind=INVOICE_PAID)` amount should match
  `OrganizationInvoice.totalPaise`.

A `jobs/billing/reconcile-ledgers.ts` cron (not shipped in v1) will assert
these identities nightly and surface drift to an admin dashboard.

## What NOT to write

- Don't write a ledger row for read operations.
- Don't write a Funding entry for a booking without a Wallet debit (they
  should be 1:1).
- Don't write a Settlement entry for a refund without reversing the
  corresponding Usage and Funding rows (via `reverseBookingUtilization`
  + `walletCredit`).
