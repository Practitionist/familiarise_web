---
title: Ledger integrity & reconciliation
band: 10-money-and-ledger
audience: sde3
status: live
last-reviewed: 2026-10-23
---

# Ledger integrity & reconciliation

**What this covers:** the auditor that proves the money model holds — the invariants it checks, the one informational coverage metric, the checked-in baseline that separates known findings from new drift, how it runs (nightly job plus an on-demand admin door), what a finding means, and the single protective action a wallet-cache drift triggers. The auditor is read-only: it reports drift and never repairs it. This is the safety net that lets us trust derived balances and reconciled caches.

> **Why this exists.** The journal is the source of truth, but a few numbers are **cached** for the hot path (`walletBalance`) or **denormalized** for query speed (`engagementsUsed`, `activeSeatCount`, the `Earnings` amount columns). A cache is only safe if something independently re-derives it and screams on drift. That something is `scripts/reconcile/reconcile-ledgers.ts` — it never hand-patches an audited table, writing only `LedgerReconciliationReport`. Its one protective side effect is that every door that runs a reconcile (the nightly job, the `CRON_SECRET` twin and the admin door) **freezes the spend of each wallet with a `WALLET_BALANCE_DRIFT` finding** through `freezeDriftedWallets()`, and the nightly job also pages P0 (see the design notes below); it still never SQL-patches the drifted cache itself.

---

## 1. The checks

The auditor emits the `Finding` kinds listed below via set-based PostgreSQL aggregations (`$queryRaw` / `groupBy`). Four checks run **full-scope only** (`REFUND_BOOKING_COHERENCE`, the consultant-payout journal check inside `COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN`, `REFERRAL_CREDIT_LIABILITY_DRIFT` and `UNAPPLIED_RECEIPTS_RESIDUE`); the rest accept an `organizationId` filter for incident triage. Invariants that Postgres already enforces at COMMIT are **not** re-scanned here: a balanced journal (`ledger_txn_balanced`), the payment-leg sum (`payment_legs_sum_to_amount`), INR-only rows (the `*_currency_inr` CHECKs), invoice tax totals and safe money ranges all live in `prisma/sql/*.sql`.

```mermaid
flowchart TD
  R["runReconcileLedgers({scope})"] --> A["WALLET_BALANCE_DRIFT"]
  R --> E2["EARNINGS_LEDGER_DRIFT"]
  R --> E["PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT"]
  R --> CP["CREDIT_POOL_CONSUMED_DRIFT"]
  R --> OC["OVERAGE_COUNT_DRIFT"]
  R --> OI["OVERAGE_CHARGESTATUS_INTEGRITY"]
  R --> F["ACTIVE_SEAT_COUNT_DRIFT"]
  R --> G["ORG_PAYOUT_TOTAL_MISMATCH"]
  R --> J["journal coverage:<br/>EARNINGS_WITHOUT_BOOKING_TXN<br/>REVERSED_EARNING_WITHOUT_REFUND_TXN<br/>COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN<br/>LEDGER_DUAL_WRITE_GAP<br/>SPLIT_SUM_MISMATCH"]
  R --> T["tax and standing:<br/>ORG_INVOICE_GST_MISMATCH<br/>PENDING_TRUST_PARK_STALE<br/>CLAWBACK_RECEIVABLE_STALE"]
  R --> X["full-scope only:<br/>REFUND_BOOKING_COHERENCE<br/>REFERRAL_CREDIT_LIABILITY_DRIFT<br/>UNAPPLIED_RECEIPTS_RESIDUE"]
  A & E2 & E & CP & OC & OI & F & G & J & T & X --> Z["findings[]"]
  Z --> BL["baseline split<br/>(scripts/reconcile/ledger-findings-baseline.ts)"]
  BL --> RP["LedgerReconciliationReport<br/>{ ok, summary, findings }"]
  BL --> OK{"any unbaselined finding?<br/>baseline sound?"}
  OK -- no --> EX0["ok:true · 200 (clean)"]
  OK -- yes --> EX2["ok:false · 207 (page ops)"]
```

| Finding `kind`                         | Scope                                                                           | Asserts                                                                                                                                                                                                                         | Drift means                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WALLET_BALANCE_DRIFT`                 | per `BillingAccount`                                                            | `-balance(WALLET, org) == walletBalance` (WALLET is credit-normal, so owed = Σcredit−Σdebit)                                                                                                                                    | the cache diverged from the journal — a writer skipped the journal or a manual SQL edit slipped in                                                                                                          |
| `EARNINGS_LEDGER_DRIFT`                | per payment **with** a `BOOKING` txn                                            | cached `ConsultantEarnings(platformFee+consultantShare) + OrganizationEarnings(orgShare)` == journal `PLATFORM_FEE+CONSULTANT_PAYABLE+ORG_PAYABLE` credits                                                                      | the earnings cache disagrees with the booking journal                                                                                                                                                       |
| `PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT` | per **active** `ProgramAssignment` (`periodEnd >= now`)                         | `sum(UsageLedgerEntry.engagementsConsumed) == engagementsUsed`                                                                                                                                                                  | a partial-rollback bug, a missing ledger write, or manual SQL desynced the denormalized counter                                                                                                             |
| `CREDIT_POOL_CONSUMED_DRIFT`           | per **active** CREDIT_POOL `ProgramAssignment`                                  | `sum(UsageLedgerEntry.priceAtBookingPaise) == consumedPaise` (refund rows post negative, so the sum nets)                                                                                                                       | the CREDIT_POOL money-meter write in `recordBookingUtilization`/`reverseBookingUtilization` desynced                                                                                                        |
| `OVERAGE_COUNT_DRIFT`                  | per **active** `ProgramAssignment`                                              | `count(OverageEvent where chargeStatus ∉ {REVERSED,BLOCKED}) == overageCount`                                                                                                                                                   | the over-cap counter bump/decrement missed; a charged-then-refunded overage awaiting a credit note is the expected benign cause                                                                             |
| `OVERAGE_CHARGESTATUS_INTEGRITY`       | per `OverageEvent` (link/state)                                                 | CHARGE_MEMBER pending/failed/charged ⇒ has a side-`Payment`; CHARGE_ORG accrued/charged ⇒ has an `InvoiceLineItem`; any `CHARGED` ⇒ `settledAt` set                                                                             | the `transitionOverage` state machine was bypassed or a write half-completed                                                                                                                                |
| `ACTIVE_SEAT_COUNT_DRIFT`              | per `BillingSubscription`                                                       | `activeSeatCount == count(in-period LICENSED_SEAT ACTIVE assignments)`                                                                                                                                                          | the per-seat invoice line-item counter missed a write (or reflects historical drift before its writer existed)                                                                                              |
| `ORG_PAYOUT_TOTAL_MISMATCH`            | per `OrganizationPayout` in `PENDING` / `APPROVED` / `PROCESSING` / `COMPLETED` | `sum(orgShare − refunded) of batched earnings == netPayoutPaise`                                                                                                                                                                | the batch claim updated earnings but the payout total diverged. Terminal-with-release statuses (`FAILED`, `REVERSED`, `CANCELLED`) are skipped because they detach their earnings back to `READY` by design |
| `REFUND_BOOKING_COHERENCE`             | per `BookingUtilization` (**full scope only**)                                  | fully-refunded payment ⇒ utilization reversed; reversed utilization ⇒ a `SUCCEEDED` refund backs it                                                                                                                             | a cap leak (money back but the seat still consumed) or a seat released for free                                                                                                                             |
| `LEDGER_DUAL_WRITE_GAP`                | per `OrganizationPayout` with `clawbackAmountPaise > 0`                         | a `clawback:*` `LedgerTransaction` exists against that payout                                                                                                                                                                   | the payout claims recovered cash the journal never saw                                                                                                                                                      |
| `ORG_INVOICE_GST_MISMATCH`             | per issued `OrganizationInvoice`, one finding per invoice                       | output tax less credit notes == net `GST_PAYABLE` behind it: the billed bookings' journals (a paisa per booking), else its `invoice-issued:` and refund journals                                                                | one side taxed something the other did not, or a subscription or manual invoice issued without its `invoice-issued:` journal                                                                                |
| `CLAWBACK_RECEIVABLE_STALE`            | one finding per run, listing every payee                                        | no clawback receivable is older than 90 days                                                                                                                                                                                    | the payee has had no payout large enough to net the clawback, so ops must recover it another way                                                                                                            |
| `EARNINGS_WITHOUT_BOOKING_TXN`         | global (payments with earnings, not filtered by organisation)                   | every payment with earnings has a `BOOKING` journal transaction (allowed count `RECONCILE_UNJOURNALED_MAX`, default 0)                                                                                                          | an earnings row exists whose booking journal was never posted                                                                                                                                               |
| `REVERSED_EARNING_WITHOUT_REFUND_TXN`  | per consultant earning with `refundedShareAmount > 0`                           | a `REFUND` journal transaction exists for that payment                                                                                                                                                                          | a reversal was recorded on the earning without its refund journal                                                                                                                                           |
| `COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN`  | per completed `OrganizationPayout` and, full scope, `ConsultantPayout`          | a payout journal transaction exists for every completed payout                                                                                                                                                                  | a payout reached `COMPLETED` without posting its `ORG_PAYOUT` or `PAYOUT` journal                                                                                                                           |
| `SPLIT_SUM_MISMATCH`                   | per payment                                                                     | Σ(platform fee + consultant shares + organisation shares) of a payment's earnings equals `Payment.originalAmount`                                                                                                               | a split leaked or minted paise                                                                                                                                                                              |
| `OVERAGE_SETTLEMENT_MISMATCH`          | per `CHARGE_MEMBER` `OverageEvent`                                              | a `CHARGED` member overage has a `SUCCEEDED` side-payment of its `marginalPaise`, an `overage:<sidePaymentId>` journal and a `settledAt`; an uncollected one has no overage journal; a recarve reversal matches its credit note | a member overage was settled on one side only                                                                                                                                                               |
| `PENDING_TRUST_PARK_STALE`             | one finding per sponsor with earnings parked over 24 hours                      | detect-only: age never releases a park                                                                                                                                                                                          | a sponsor's earnings are parked in `PENDING_TRUST` and need an admin verify or a paid invoice                                                                                                               |
| `REFERRAL_CREDIT_LIABILITY_DRIFT`      | platform (full scope)                                                           | the `REFERRAL_CREDIT_LIABILITY` account equals the remaining value of vested credits that posted a vest journal                                                                                                                 | a referral credit was vested, redeemed or voided without its journal                                                                                                                                        |
| `UNAPPLIED_RECEIPTS_RESIDUE`           | per parked capture (full scope)                                                 | a settled refund of a parked capture leaves `UNAPPLIED_RECEIPTS` at zero                                                                                                                                                        | a refund of a parked capture did not clear the parking account                                                                                                                                              |

**Grouped by what each check protects:**

```mermaid
flowchart TD
  CRON["nightly ticker run (full scope)<br/>/api/cleanup/reconcile-ledgers"] --> RUN["runReconcileLedgers"]
  ADMIN["POST /api/admin/reconcile-ledgers<br/>(on demand; synchronous, full scope or one organisation)"] --> RUN
  RUN --> G1
  RUN --> G2
  RUN --> G3
  RUN --> G4
  subgraph G1["① journal coherence"]
    RBC["REFUND_BOOKING_COHERENCE"]
    EWB["EARNINGS_WITHOUT_BOOKING_TXN"]
    REF["REVERSED_EARNING_WITHOUT_REFUND_TXN"]
    CPW["COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN"]
    DWG["LEDGER_DUAL_WRITE_GAP"]
    SSM["SPLIT_SUM_MISMATCH"]
  end
  subgraph G2["② money caches vs journal"]
    WBD["WALLET_BALANCE_DRIFT"]
    ELD["EARNINGS_LEDGER_DRIFT"]
    OPT["ORG_PAYOUT_TOTAL_MISMATCH"]
    RCL["REFERRAL_CREDIT_LIABILITY_DRIFT"]
    URR["UNAPPLIED_RECEIPTS_RESIDUE"]
  end
  subgraph G3["③ usage / program counters"]
    PAE["PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT"]
    CPC["CREDIT_POOL_CONSUMED_DRIFT"]
    OCD["OVERAGE_COUNT_DRIFT"]
    OCI["OVERAGE_CHARGESTATUS_INTEGRITY"]
    OSM["OVERAGE_SETTLEMENT_MISMATCH"]
    ASC["ACTIVE_SEAT_COUNT_DRIFT"]
  end
  subgraph G4["④ tax and standing items"]
    IGM["ORG_INVOICE_GST_MISMATCH"]
    PTS["PENDING_TRUST_PARK_STALE"]
    CRS["CLAWBACK_RECEIVABLE_STALE"]
  end
  G1 & G2 & G3 & G4 --> RPT["LedgerReconciliationReport<br/>{ ok, summary, findings[] }"]
  RPT --> BL["split against the checked-in baseline"]
  BL --> OK{"any unbaselined finding?<br/>baseline malformed?"}
  OK -- no --> CLEAN["200 · ok:true"]
  OK -- yes --> PAGE["207 · ok:false"]
  PAGE --> MON["monitoring alert<br/>(50-operations/03-monitoring.md)"]
  MON --> ONCALL["on-call → runbook<br/>(50-operations/02-runbooks.md):<br/>inspect the upstream writer,<br/>post a counter-txn — never SQL-patch"]
  CLEAN --> AUDIT["history row = integrity proof over time"]
```

The grouping is conceptual, not a code boundary (all checks run in one pass); it's how to _triage_: a ① finding means a journal is missing or incoherent with its business rows (rare, high-severity — a writer that bypassed `postLedgerTxn`, since the balance of each transaction is already enforced by Postgres); ②–④ mean a _cache_ or counter drifted from a sound journal (fix the writer, re-derive the cache via a counter-transaction).

Each `Finding` is a compact row: `{ kind, organizationId?, billingAccountId?, billingSubscriptionId?, invoiceId?, paymentId?, payoutId?, programAssignmentId?, expectedPaise, actualPaise, deltaPaise, details? }`. For the count-based checks (`…ENGAGEMENTS_DRIFT`, `…SEAT_COUNT_DRIFT`, `OVERAGE_COUNT_DRIFT`) and the link/state ones the `*Paise` fields hold **counts / events**, not paise — `details.unit` records the real unit.

---

## 2. The coverage metric (informational, not a finding)

`summary.earningsPaymentsWithoutBookingTxn` counts earnings-bearing payments that have **no** `BOOKING` journal transaction yet. It is reported for visibility but does **not** fail the run, because `EARNINGS_LEDGER_DRIFT` only checks payments that _do_ have a booking txn.

A related but stricter check, the `EARNINGS_WITHOUT_BOOKING_TXN` finding, does fail the run: it flags an earnings-bearing payment missing its `BOOKING` journal transaction. An earnings row and its journal always commit in one transaction, and the check reads earnings before journal transactions, so it needs no grace window.

---

## 3. The known-findings baseline

A finding that is already known must not keep the nightly run red forever: an auditor that is permanently red is an auditor nobody reads. The auditor therefore splits its findings against a checked-in baseline — `scripts/reconcile/ledger-findings-baseline.ts` — and only the findings the baseline does not excuse fail the run.

**The baseline never hides evidence.** Every finding still lands in the persisted `LedgerReconciliationReport.findings` array and still counts in `summary.discrepanciesCount`. The baseline decides which findings fail the run; it never mutes, repairs or deletes one.

**An entry pins one finding by fingerprint.** An entry names the finding `kind`, the `deltaPaise`, the entity ids the finding carries (`organizationId`, `billingAccountId`, `paymentId`, `payoutId`, `invoiceId`, `programAssignmentId`, `billingSubscriptionId`) and, for a finding that identifies itself only through its `details` (for example `details.bookingUtilizationId`), that one detail key with its value. A finding is excused only when the kind, the delta and **every** identifier agree, so a new row, a changed amount, or a finding that grew an identifier the entry never pinned is never excused. `occurrences` says how many findings of one fingerprint the entry excuses; a fingerprint that occurs more often than that leaves the surplus failing the run.

**Every entry carries an owner, a reason and an expiry.** `owner` says who carries the cleanup, `reason` says in one line why the finding is knowingly carried, and `expires` is the ISO date after which the entry excuses nothing. An expired entry excuses nothing, so its finding fails the run again and an allowlist can never become permanent. The auditor counts expired entries in `summary.baselineExpiredCount`.

**A malformed baseline fails the run.** An entry that is missing its owner, reason or expiry, that carries an unparseable date, or that names a finding kind the auditor cannot raise is ignored as a baseline entry **and** fails the run: the problem is recorded in `summary.baselineProblems` and the report is not ok. A broken baseline can never silently green a run.

| Report field                   | Meaning                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `summary.discrepanciesCount`   | Every finding the run raised, baselined or not.                |
| `summary.baselinedCount`       | How many of them the baseline excuses.                         |
| `summary.unbaselinedCount`     | How many it does not — each one fails the run.                 |
| `summary.baselineExpiredCount` | Baseline entries whose expiry has passed.                      |
| `summary.baselineProblems`     | Why the baseline was rejected. A non-empty list fails the run. |

The gate in one line: the report is ok when `unbaselinedCount` is zero **and** `baselineProblems` is empty.

---

## 4. How it runs

- **Library:** `runReconcileLedgers({ scope, organizationId?, triggeredById? })` → `ReconcileReport`. Scope is `"full"` or `"org:<id>"`; passing `organizationId` limits every per-row check to one org and **skips the four full-scope-only checks** listed in §1.
- **Nightly run:** the Netlify five-minute ticker (`netlify/functions/cron-tick.mts`) calls the `reconcile-ledgers` twin once a day at 03:55 UTC (inside its 03:00 to 04:00 UTC window; one slot, because every run writes a report row). The twin calls `runReconcileLedgers({ scope: "full", onWalletDrift })`, which persists a `LedgerReconciliationReport`. `freezeDriftingWallets()` (`scripts/reconcile/ledger-drift-response.ts`) freezes the spend of every wallet with `WALLET_BALANCE_DRIFT` from the audit's wallet step, so a run cut off later has already frozen. `respondToLedgerDrift()` then records a `SystemEvent` and reports the findings to Sentry once per standing set; it runs only when the report is not ok, so a night whose findings are all baselined pages nobody. The route answers `200` (clean), `207` (discrepancies, page ops) or `500` (the audit or a freeze failed); there is no process exit code. The auditor in `scripts/reconcile/reconcile-ledgers.ts` itself only reads and reports. The freeze runs from the `onWalletDrift` hook, right after the wallet step and before the findings baseline (§3) is evaluated, so a baselined `WALLET_BALANCE_DRIFT` still freezes spend and still pages Sentry once per run; the baseline only decides whether the run fails.
- **On-demand door and HTTP twin:** `POST /api/admin/reconcile-ledgers` is an admin money door (ADMIN, step-up, reason, one `OpsActionLog` row; `startLedgerReconciliation()` in `lib/backoffice/ledger-run.ts` is the one helper behind it and the console's reconcile job), and `POST /api/cleanup/reconcile-ledgers` (with `Authorization: Bearer $CRON_SECRET`) is the twin the ticker calls and the way to run it by hand. Both run `runReconcileLedgers` synchronously in-process under the `reconcile-ledgers` cron lock, and a full-scope run that is already `RUNNING` answers 409. Both then freeze every drifted wallet through the same `freezeDriftedWallets()` (`lib/payments/wallet-freeze.ts`) that the nightly run uses, and report the count as `frozenWallets`. A full-scope run completes in a few seconds without chunking or background workers.
- **Report storage:** every run writes a `LedgerReconciliationReport { scope, ok, durationMs, summary, findings, triggeredById }`. The history is the audit trail of integrity over time; the `summary` carries the count of findings, how many the baseline excused and why the baseline was rejected (§3).

---

## 5. When a finding fires

A finding is an **incident signal, never a thing to hand-patch.** The drift is a symptom; the fix is upstream (the writer that diverged), and the correction — if money is involved — is a **counter-transaction**, not a SQL `UPDATE` on a balance. See [runbooks](../50-operations/02-runbooks.md) for the per-finding triage procedure (which writer to inspect, how to post a correcting entry, when to page).

For `WALLET_BALANCE_DRIFT` the steps are:

1. Find the root cause: which writer moved the cache without its journal line, or the journal without the cache.
2. Decide which side is wrong, then post a balanced `LedgerTransaction` that corrects that side. This is an owner-applied SQL change run once, and it is a new journal entry, never an `UPDATE` of a balance or of a posted row (`ledger_entry_immutable` would refuse it). Re-deriving the cache by overwriting it is not a repair, and `adjustWallet()` cannot close the gap, because it moves the cache and the journal by the same amount.
3. Unfreeze through the existing door, `POST /api/admin/billing-accounts/[billingAccountId]/unfreeze`, which re-reads that wallet and answers `409 WALLET_STILL_DRIFTED` while the two still disagree.

**Worked example (the 2026-10-18 member-overage carve).** A member overage with `CHARGE_MEMBER` on a wallet-funded booking carves the overage base off the parent payment and back onto the organisation's wallet. On 2026-10-18 two such bookings on one organisation each carved a base of ₹2,850.18 (285,018 paise), about twenty seconds after their booking journals had debited WALLET at the full price. Before `journalWalletCarveCredit()` existed in `lib/payments/billing/overage-settlement.ts`, each carve credited the wallet cache and posted no ledger line, so the cache was right and the journal was short by 2 × 285,018 = ₹5,700.36 (570,036 paise). The nightly audit raised `WALLET_BALANCE_DRIFT`, and `freezeDriftingWallets()` froze the organisation's spend. The repair is one owner-applied correcting journal for the missing side, `Dr DISCOUNT / Cr WALLET` 570,036 under its own correction idempotency key (the same shape the function now posts per carve under `overage-carve-credit:<overageEventId>`), followed by the unfreeze door. The writer now posts the line in the carve's own transaction, so a new carve cannot drift.

---

## 6. Design decisions & trade-offs

- **Never hand-patches a cache — but fails closed on wallet drift.** The auditor writes _only_ `LedgerReconciliationReport` and never touches an audited table. When any reconcile door (the nightly job, `POST /api/cleanup/reconcile-ledgers` or `POST /api/admin/reconcile-ledgers`) sees a `WALLET_BALANCE_DRIFT` finding, which means a wallet's cached balance no longer matches its journal, `freezeDriftedWallets()` freezes spend for that `BillingAccount`; the nightly job also pages P0. The freeze rides the append-only `SystemEvent` log (a `WALLET_FREEZE` / `WALLET_UNFREEZE` pair keyed on `correlationId`), fails closed so an unreadable log blocks the spend rather than leaking it, and gates only discretionary checkout spend — never a top-up credit. An admin lifts it with `POST /api/admin/billing-accounts/[billingAccountId]/unfreeze` once the drift is reconciled. The door re-reads that one wallet's drift first and refuses with 409 `WALLET_STILL_DRIFTED` while the cache and the journal still disagree.
- **No check on the gateway side.** The auditor compares cached balances with the journal. It has no check on the `GATEWAY_CLEARING` residual or on unmatched settlement lines; those live only in the `reconcile-gateway-settlements` job (`jobs/reconcile/reconcile-gateway-settlements.ts`, `GatewaySettlementLine` rows), which compares the journal with Razorpay's settlement report.
- **Counts and events reuse the `*Paise` fields.** Rather than a separate schema per check kind, count-based findings (`…ENGAGEMENTS_DRIFT`, `…SEAT_COUNT_DRIFT`, `OVERAGE_COUNT_DRIFT`) and link/state findings stuff counts into `expectedPaise`/`actualPaise`/`deltaPaise` and record the real unit in `details.unit`.
- **A checked-in baseline of known findings (`scripts/reconcile/ledger-findings-baseline.ts`).** The nightly signal has to mean "new drift", not "the same seeded row again", or ops learns to ignore a red reconciler. The baseline records what is already known without hiding it: every finding still reaches the report, and only the findings the baseline does not excuse fail the run. Its three rules — fingerprint, expiry, fail-closed on a malformed entry — are in §3.

### Related docs

- [Money model overview](01-money-model-overview.md) §4 — the reconciled-cache contract.
- [Ledger & postings](03-ledger-and-postings.md) — the postings these checks re-sum.
- [Payment legs](09-payment-legs.md) — the leg-sum invariant, enforced by the `payment_legs_sum_to_amount` trigger.
- [Runbooks](../50-operations/02-runbooks.md) — per-finding incident response.
- [Monitoring](../50-operations/03-monitoring.md) — alerting on report `ok:false`.
- Ground truth: `scripts/reconcile/reconcile-ledgers.ts`, `scripts/reconcile/ledger-findings-baseline.ts`, `LedgerReconciliationReport` in `prisma/schema.prisma`.

---

## Deprecated & Superseded Approaches

> [!WARNING]
> **Do NOT re-introduce these patterns.** They were superseded by fast set-based PostgreSQL aggregation in `scripts/reconcile/reconcile-ledgers.ts`.

1. **Chunked Cursor State Machine (`advanceReconcileRun` / `ReconcileCursorState`)**: Previously, `reconcile-ledgers.ts` walked 5 tables row-by-row in TypeScript (139 serialised DB round trips taking 22–27 seconds), persisting a keyset cursor (`summary.progress`) on `LedgerReconciliationReport` with a 12-second soft chunk deadline (`RECONCILE_CHUNK_BUDGET_MS`). Rewriting those checks as set-based SQL `GROUP BY` / `HAVING` queries reduced full-scope execution to ~1–2 seconds in a single pass, making the multi-step cursor engine obsolete.
2. **Netlify Background Function Driver (`netlify/functions/reconcile-ledgers-background`)**: Previously, `POST /api/admin/reconcile-ledgers` kicked a Netlify Background Function that looped `POST /api/cleanup/reconcile-ledgers?runId=...` up to 400 times. Because full-scope runs now finish well within a standard HTTP request budget, `POST /api/admin/reconcile-ledgers` runs `runReconcileLedgers` synchronously in-process and the background function was removed.
3. **A baseline keyed to one entity id** (the old `LEDGER_BASELINE` list): it excused a finding by `kind` plus a single entity id, so the same row with a changed amount stayed hidden, and a broken entry silently excused nothing. The current baseline (`scripts/reconcile/ledger-findings-baseline.ts`) pins the kind, the delta and every identifier the finding carries, expires, and fails the run when it is malformed.
4. **Re-verifying invariants Postgres enforces** (`LEDGER_TXN_IMBALANCE`, `PAYMENT_LEG_SUM_MISMATCH`, `INVOICE_TOTAL_MISMATCH`, `LEDGER_ACCOUNT_NON_INR`) was removed from the auditor. The deferred triggers and CHECK constraints in `prisma/sql/*.sql` are the enforcers, and a JS sweep over them only adds a second, weaker copy.
