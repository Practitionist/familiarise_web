---
title: Ledger integrity and reconciliation
type: reference
audience: engineers and on-call operators who own the books
status: live
last-reviewed: 2026-10-23
---

# Ledger integrity and reconciliation

The journal is the source of truth for money. A few numbers are cached beside it for speed, such as the wallet balance and the amount columns on earnings, and a few counters are denormalised, such as engagements used and active seat counts. A cache is only safe if something independently re-derives it and raises an alarm when it drifts. That something is the ledger auditor, `runReconcileLedgers` in `scripts/reconcile/reconcile-ledgers.ts`. It is read-only: it writes one `LedgerReconciliationReport` row per logical audit and never touches an audited table. Its single protective side effect is that a wallet whose cache disagrees with the journal has its discretionary spend frozen until a person repairs it.

This page has three jobs. It lists which invariants Postgres already enforces, so nobody writes a JavaScript sweep that re-checks them. It lists what the auditor checks instead. And it says what to do when a finding fires.

## What Postgres already guarantees

The rule in `AGENTS.md` is that an invariant the database enforces at commit is not re-verified in application code. The auditor therefore does not scan for any of the following.

| Invariant                                                                               | Database enforcer (all in `prisma/sql/`)                                                                                      | What the application does not re-check                                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Every journal has debits equal to credits                                               | `ledger_txn_balanced` constraint trigger (`ledger-triggers.sql`)                                                              | No "unbalanced journal" sweep                                                             |
| A posted journal line or header is never edited                                         | `ledger_entry_immutable`, `ledger_transaction_immutable` (`ledger-triggers.sql`)                                              | No checksum of old entries                                                                |
| A journal line is positive and every ledger account is in rupees                        | `ledger_entry_amount_positive`, `ledger_account_currency_inr` (`check-constraints.sql`)                                       | No currency sweep                                                                         |
| Payment, refund, dispute, earning and payout rows are in rupees                         | the `*_currency_inr` CHECKs (`check-constraints.sql`)                                                                         | No currency sweep                                                                         |
| A payment's funding legs sum to the payment amount, and reversal legs never exceed them | `payment_legs_sum_to_amount` (`payment-legs-triggers.sql`), with `payment_amount_vs_legs` and `payment_refunds_within_amount` | No warn-only funding-leg re-read after a booking write                                    |
| A cached wallet balance is never negative                                               | `billing_account_wallet_nonnegative` (`check-constraints.sql`)                                                                | No negative-balance sweep (drift against the journal is still audited)                    |
| A batched earning always points at a payout                                             | `consultant_earnings_batched_has_payout`, `org_earnings_batched_has_payout` (`check-constraints.sql`)                         | No orphaned-batch sweep                                                                   |
| One host's live confirmed sessions never overlap                                        | `occurrence_no_confirmed_overlap` (`check-constraints.sql`)                                                                   | No double-booking sweep for that case                                                     |
| An earnings hold names exactly one earning, and there is one active hold per owner      | `earnings_hold_one_earning`, `earnings_hold_active_consultant_key`, `earnings_hold_active_org_key`                            | No hold-uniqueness sweep                                                                  |
| A consultant has one TDS catch-up payout per financial year                             | `consultant_payout_one_tds_catch_up_per_fy` (`check-constraints.sql`)                                                         | The loser of a race re-plans (see [TDS withholding](../40-payouts/06-tds-withholding.md)) |
| A TDS record has exactly one deductee, on the right rail                                | `tds_record_deductee_xor`, `tds_record_payout_rail_matches` (`check-constraints.sql`)                                         | No TDS-shape sweep                                                                        |

Everything below is what Postgres cannot see: a cache against the journal, a counter against its rows, an external vendor against the books.

## What the auditor checks

The auditor emits the finding kinds in `RECONCILE_FINDING_KINDS`. Comparisons use set-based SQL within persisted pages of at most 100 primary entities, retaining their complete related journal history. Each comparison uses a read-only Repeatable Read transaction and passes its transaction client through every helper. Pages do not form one global snapshot of the entire audit. A run for one organisation (`scope: "org:<id>"`) skips the four full-scope-only checks marked below.

| Finding kind                                                                           | Asserts                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WALLET_BALANCE_DRIFT`                                                                 | The cached `walletBalance` equals the owed balance of the `WALLET` account (credits less debits)                                                       |
| `EARNINGS_LEDGER_DRIFT`                                                                | For a payment with a `BOOKING` journal, the cached earnings amounts equal the journal's `PLATFORM_FEE`, `CONSULTANT_PAYABLE` and `ORG_PAYABLE` credits |
| `EARNINGS_WITHOUT_BOOKING_TXN`                                                         | Every payment that has earnings has a `BOOKING` journal                                                                                                |
| `SPLIT_SUM_MISMATCH`                                                                   | A payment's platform fee plus consultant and organisation shares equal `Payment.originalAmount`                                                        |
| `REVERSED_EARNING_WITHOUT_REFUND_TXN`                                                  | An earning with a refunded share has a `REFUND` journal for its payment                                                                                |
| `COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN`                                                  | Every completed organisation payout has an `ORG_PAYOUT` journal; the consultant half is full-scope only                                                |
| `LEDGER_DUAL_WRITE_GAP`                                                                | An organisation payout with a clawback amount has a `clawback:*` journal                                                                               |
| `ORG_PAYOUT_TOTAL_MISMATCH`                                                            | For payouts in `PENDING`, `APPROVED`, `PROCESSING` or `COMPLETED`, the batched earnings' share less refunds equals `netPayoutPaise`                    |
| `CLAWBACK_RECEIVABLE_STALE`                                                            | No clawback is still unrecovered after 90 days (one finding per run, listing every payee)                                                              |
| `ORG_INVOICE_GST_MISMATCH`                                                             | An issued organisation invoice's output tax less credit notes equals the net `GST_PAYABLE` behind it                                                   |
| `PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT`, `CREDIT_POOL_CONSUMED_DRIFT`                   | An active program assignment's counters equal the sum of its usage-ledger rows                                                                         |
| `OVERAGE_COUNT_DRIFT`, `OVERAGE_CHARGESTATUS_INTEGRITY`, `OVERAGE_SETTLEMENT_MISMATCH` | Overage counters, states and settlement journals agree on both sides                                                                                   |
| `ACTIVE_SEAT_COUNT_DRIFT`                                                              | A subscription's active seat counter equals its in-period active assignments                                                                           |
| `PENDING_TRUST_PARK_STALE`                                                             | Detect-only: a sponsor with earnings parked in `PENDING_TRUST` for more than 24 hours; age never releases a park                                       |
| `REFUND_BOOKING_COHERENCE` (full scope)                                                | A fully refunded payment has its utilisation reversed, and reversed utilisation is backed by a `SUCCEEDED` refund                                      |
| `REFERRAL_CREDIT_LIABILITY_DRIFT` (full scope)                                         | The `REFERRAL_CREDIT_LIABILITY` account equals the remaining value of vested credits                                                                   |
| `UNAPPLIED_RECEIPTS_RESIDUE` (full scope)                                              | A settled refund of a parked capture leaves `UNAPPLIED_RECEIPTS` at zero                                                                               |

The consultant-payout journal check inside `COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN` is the fourth full-scope-only check. Each finding carries `expectedPaise`, `actualPaise`, `deltaPaise` and the entity ids it concerns. For count-based checks those three fields hold counts, and `details.unit` records the real unit.

```mermaid
flowchart TD
  CRON["Ticker: POST /api/cleanup/reconcile-ledgers<br/>hourly :55 when capacity permits"] --> RUN["Create or resume persisted audit pages"]
  ADMIN["Admin door: POST /api/admin/reconcile-ledgers<br/>step-up, reason, ops log"] --> RUN
  RUN --> W["Wallet step first"]
  W -->|"WALLET_BALANCE_DRIFT, every entry point"| FRZ["onWalletDrift freeze<br/>WALLET_FREEZE event"]
  W -->|"no drift"| REST["All other checks"]
  FRZ --> REST
  REST --> BL["Split against the checked-in baseline"]
  BL --> REP["LedgerReconciliationReport row"]
  RUN -->|"comparison fails"| F["500; persist FAILED at the same checkpoint"]
  REP --> DONE{"Audit completed?"}
  DONE -- no --> CONT["200 RUNNING; continue audit"]
  DONE -- yes --> OK{"Any unbaselined finding<br/>or baseline problem?"}
  OK -- no --> G["200, ok"]
  OK -- yes --> P["207, respondToLedgerDrift:<br/>SystemEvent and one Sentry report"]
```

## The baseline of known findings

A finding that is already known must not keep the completed logical audit red forever, because an auditor that is permanently red is an auditor nobody reads. The auditor splits its findings against a checked-in baseline, `scripts/reconcile/ledger-findings-baseline.ts`, and only the findings the baseline does not excuse fail the run.

- The baseline never hides evidence. Every finding still lands in the persisted report and still counts in `summary.discrepanciesCount`.
- An entry pins one finding by fingerprint: the kind, the delta and every entity id the finding carries. A new row, a changed amount or a finding that grew an identifier is never excused.
- Every entry carries an owner, a reason and an expiry date. An expired entry excuses nothing.
- A malformed entry is ignored and fails the run, recorded in `summary.baselineProblems`, so a broken baseline can never silently turn a run green.

The report is ok exactly when `summary.unbaselinedCount` is zero and `summary.baselineProblems` is empty. The summary also carries `baselinedCount` and `baselineExpiredCount`.

## How a run happens

The ticker offers an hourly `:55` slice, yielding that slot to settlement and statutory jobs when dispatch is at its design bound. `runReconcileLedgers` creates or resumes the full-scope audit; a completed daily audit is reused. The cleanup twin returns 200 with `summary.status: RUNNING` for continuation, 200 for a completed clean report, 207 for completed discrepancies, and 500 for a failed slice or freeze. An incomplete report has `ok: false`; that is not a completed corruption verdict.

`summary.nextStep`, optional `cursor`, `calls`, `executing`, `interruptions`, counts and findings persist on the report. Successful comparisons advance the checkpoint. A caught failure marks it FAILED and retains the unfinished comparison; a hard interruption leaves executing state that a later owner can resume after lease recovery. Pending audits resume across UTC days, and historical cohorts are not hidden behind a recent-days cutoff. The same fail-closed Postgres lease excludes active admin and scheduled callers. A lease or request timeout does not prove an old process has stopped.

Both admin doors advance the same bounded `runReconcileLedgers` core, optionally scoped to an organisation. They require ADMIN access, step-up, a reason and an ops-log row. A held lease answers 409; idle checkpoints resume. RUNNING returns 200 for continuation, completed discrepancies return 207, and failures return 500. The Reconcile console shows Continue audit for unfinished or failed reports and never labels an incomplete `ok: false` as drift. Unclassified legacy reports display an unavailable completion status.

An authenticated manual request creates a fresh audit after a completed verdict, allowing verification after an operator correction on the same UTC day. A scheduled request reuses the completed daily audit. Cron query parameters cannot impersonate the admin actor or force a fresh manual report. Cohort aging remains anchored to the report start, while baseline expiry is evaluated at the current save time so an exception cannot outlive its expiry during a multi-day audit.

Each newly checked wallet page invokes the same freeze hook before its checkpoint advances, including the admin path. Resuming later pages does not re-apply historical wallet findings and undo an operator’s intervening repair/unfreeze. The scheduled wrapper aggregates wallet findings and uses a persisted logical-report key for fatal-alert deduplication. `respondToLedgerDrift` retains the standing-findings alert policy; do not capture once per row or once per page. A failed comparison retains its page and prevents a completed verdict. Repeated failure requires fixing that comparison or its data/capacity issue; retrying or creating another report cannot make the same unchecked obligation clean. No page is skipped after a retry count. Other job gates still determine admission during maintenance.

A payment with earnings and no BOOKING journal raises one `EARNINGS_WITHOUT_BOOKING_TXN` finding pinned to that payment (`details.unit: transactions`, expected/actual 1/0). Aggregate coverage counts remain informational. The baseline is an exact, expiring exception list, not a count allowance for a moving set of missing payments.

## Wallet drift: freeze, repair, unfreeze

`BillingAccount.walletBalance` is a reconciled cache of the organisation's WALLET journal. Every entry point freezes a drifting wallet immediately after its page, before checkpoint advancement, even when a finding is baselined. Freeze failures retain that page for retry. The freeze is an append-only `SystemEvent`, keyed `wallet-freeze:<billingAccountId>`, and the latest freeze/unfreeze event decides the state. An unreadable freeze log blocks discretionary spend; top-up credit and chargeback recovery remain separate flows.

A drift is an incident, not something to patch by hand. The repair has three steps.

1. **Find the cause.** Which writer moved the cache without its journal line, or the journal without the cache?
2. **Post a balanced correcting journal.** It is a new `LedgerTransaction` that fixes the side that is wrong. It is never an `UPDATE` of a balance (`ledger_entry_immutable` would refuse it). `adjustWallet` cannot close the gap, because it moves the cache and the journal by the same amount.
3. **Unfreeze through the door.** `POST /api/admin/billing-accounts/[billingAccountId]/unfreeze` (step-up, reason, ops log) re-reads that wallet and answers 409 `WALLET_STILL_DRIFTED` while the cache and the journal still disagree.

**Worked example: the 2026-10-18 member-overage carve.** A member overage with `CHARGE_MEMBER` on a wallet-funded booking carves the overage base off the parent payment and back onto the organisation's wallet. On 2026-10-18 two such bookings on one organisation each carved 285,018 paise (₹2,850.18). Each carve credited the wallet cache and posted no ledger line, because the carve journal `overage-carve-credit:<overageEventId>` did not exist yet. The cache was therefore right and the journal was short by 2 × 285,018 = 570,036 paise (₹5,700.36). The nightly audit raised `WALLET_BALANCE_DRIFT` and froze the organisation's spend. Both payments had since been fully refunded under the earlier refund journal, before it reversed `DISCOUNT`, and each refund journal left a 285,018-paise credit on `PLATFORM_FEE` and a 285,018-paise debit on `WALLET` (verified in the live ledger). The correction is therefore one balanced journal, `Dr PLATFORM_FEE 570,036` and `Cr WALLET 570,036`, under its own correction idempotency key, which brings every account of both payments to zero, followed by the unfreeze door. It differs from the live writer: today `journalWalletCarveCredit` in `lib/payments/billing/overage-settlement.ts` books each carve as `Dr DISCOUNT / Cr WALLET` in the carve's own transaction, so a new carve cannot drift.

## Reconciliation across the vendor boundary

The auditor compares caches with the journal. It does not check the `GATEWAY_CLEARING` residual or unmatched settlement lines. Those live in the `reconcile-gateway-settlements` job, which compares the journal with Razorpay's settlement report (see [gateway clearing and settlement](05-gateway-clearing-and-settlement.md)). Money reconcilers that talk to Razorpay or RazorpayX, such as `reconcile-payout-status` and `reconcile-disputes`, are described in [scheduled jobs](../70-operations/01-scheduled-jobs.md).

## Rules and their enforcers

| Rule                                                              | Enforcer                                                                                                                          | Test                                                       | Repair                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| A known finding cannot keep the run red forever or hide a new one | Fingerprint, expiry and fail-on-malformed rules in `ledger-findings-baseline.ts`                                                  | `__tests__/payments/ledger-findings-baseline.test.ts`      | Fix the finding or renew the entry with a reason |
| A drifted wallet cannot be spent                                  | `isWalletFrozen` in `lib/payments/wallet-freeze.ts`, read in the checkout transaction                                             | `__tests__/maintenance/ledger-drift-response.test.ts`      | Correcting journal, then the unfreeze door       |
| An unfreeze cannot hide a live drift                              | The `WALLET_STILL_DRIFTED` re-check in the unfreeze route                                                                         | `__tests__/enterprise/wallet-doors.test.ts`                | Post the correcting journal first                |
| Two audits do not overlap while the lease can be taken            | `withCronLock("reconcile-ledgers")`, a fail-closed Postgres lease shared by admin and scheduled callers; a held lease returns 409 | `__tests__/payments/admin-reconcile-ledgers-async.test.ts` | Wait for the running audit                       |

## Where in code

- `scripts/reconcile/reconcile-ledgers.ts` — `runReconcileLedgers`, `RECONCILE_FINDING_KINDS`, `walletDriftFindings`.
- `scripts/reconcile/ledger-findings-baseline.ts` — the baseline entries and `evaluateLedgerBaseline`.
- `scripts/reconcile/ledger-drift-response.ts` — `respondToLedgerDrift`, `reportWalletDriftFreeze`.
- `lib/payments/wallet-freeze.ts` — `isWalletFrozen`, `freezeWalletSpend`, `unfreezeWalletSpend`, `freezeDriftedWallets`.
- `lib/backoffice/ledger-run.ts` — `startLedgerReconciliation`, the helper behind the admin door.
- `LedgerReconciliationReport` in `prisma/schema.prisma`.

## Related

- [Double-entry model](01-double-entry-model.md)
- [Payment legs](03-payment-legs.md)
- [Gateway clearing and settlement](05-gateway-clearing-and-settlement.md)
- [Ledger drift runbook](../70-operations/06-ledger-drift-runbook.md)

## Deprecated & Superseded Approaches

- **The old row-by-row cursor engine** (`advanceReconcileRun`, `ReconcileCursorState`) is removed. Current bounded pages retain set-based comparisons and persist progress on `LedgerReconciliationReport`; do not restore the old engine or remove the current checkpoint.
- **A separate background driver** looped the cleanup route. Scheduled progress now belongs to bounded canonical slices; there is no background loop or parallel scheduler for this auditor.
- **A baseline keyed to one entity id** excused a finding by kind and one id, so the same row with a changed amount stayed hidden. The current baseline pins kind, delta and every identifier.
- **Application sweeps over database-enforced invariants** (`LEDGER_TXN_IMBALANCE`, `PAYMENT_LEG_SUM_MISMATCH`, `INVOICE_TOTAL_MISMATCH`, `LEDGER_ACCOUNT_NON_INR`) were removed. The triggers and CHECKs in `prisma/sql/` are the enforcers, and a second copy in JavaScript is only weaker.
- **The trigger name `ledger_balance_check`** appears in older documents and comments. The trigger is `ledger_txn_balanced`.
