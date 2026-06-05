# Booking → earnings

**What this covers:** how a sponsored booking turns into money — the three-way split (`RateCard`, basis points, snapshots), the `BOOKING` ledger posting it produces, and the `ConsultantEarnings` / `OrganizationEarnings` rows that cache the result for payout. The funding side (which sources paid) is in [payment legs](08-payment-legs.md); the journal mechanics are in [ledger & postings](03-ledger-and-postings.md).

> Every host-side booking produces a `ConsultantEarnings` row and (if the expert settles to a HOST org) an `OrganizationEarnings` row. The split is resolved from a `RateCard` **at booking time**, snapshotted, and posted as one balanced `BOOKING` transaction. A retroactive rate change must never rewrite history.

---

## 1. The flow

```mermaid
sequenceDiagram
  autonumber
  participant CO as Checkout
  participant DB as Postgres (tx)
  participant ES as earnings-service
  participant L as Ledger (postLedgerTxn)
  CO->>DB: create Payment + PaymentLeg[] (funding sources)
  CO->>DB: walletDebit() — moves walletBalance cache only
  CO->>ES: createEarningsFromPayment(payment)
  ES->>ES: resolveEffectiveRateCard() @ payment.createdAt
  ES->>DB: ConsultantEarnings (+ OrganizationEarnings if HOST) — bps snapshot
  ES->>L: postLedgerTxn(booking:<paymentId>)
  L->>DB: Dr funding legs == Cr PLATFORM_FEE + CONSULTANT_PAYABLE + ORG_PAYABLE + GST_PAYABLE
  Note over ES,L: single-consultant booking posts inline;<br/>multi-collaborator defers the journal (#773)
```

The `walletDebit` in step 2 moves only the **cache** ([wallet & top-ups](04-wallet-and-topups.md)); the authoritative `Dr WALLET` leg is posted later, inside the booking transaction, where the full split is known.

---

## 2. `RateCard` — the split

```prisma
model RateCard {
  id              String  @id @default(uuid())
  ownerOrgId      String?       // org-scoped card …
  ownerContractId String?       // … or contract-scoped (never both)
  planType        CoveredPlanType?  // null = any
  planId          String?           // null = any
  minGrossPaise   Int?
  maxGrossPaise   Int?
  // Basis points — sum must equal 10000. Integer math; no float drift.
  platformBps     Int
  orgBps          Int
  consultantBps   Int
  effectiveFrom   DateTime  @default(now())
  effectiveTo     DateTime?
}
```

Two scoping columns let a card live at the **org** level (default across contracts) or the **contract** level (a negotiated per-customer split). Exactly one owner is set.

**Time-scoped, never updated.** A rate change closes the old card (`effectiveTo = now()`) and inserts a new one (`effectiveFrom = now()`) in one transaction (`bumpRateCard()`, `lib/api/organizations/rate-card.ts`). Yesterday's booking still resolves the card where `effectiveFrom <= booking.createdAt < effectiveTo`.

**Resolution order** (`resolveEffectiveRateCard()`, most-specific → least):
1. `Membership.rateCardOverride` (per-expert).
2. Contract-scoped + `planId`. 3. Org-scoped + `planId`.
4. Contract-scoped + `CoveredPlanType`. 5. Org-scoped + `CoveredPlanType`.
6. Contract-scoped default. 7. Org-scoped default.
8. Hardcoded `DEFAULT_RATE_CARD` = **10% / 10% / 80%** (platform / org / expert); `rateCardId = null` is the sentinel for "defaults used".

**The bps invariant:** `platformBps + orgBps + consultantBps === 10000` on every row — enforced at the creation site (`bumpRateCard()` + the rate-card POST handler), not yet a Postgres CHECK (follow-up).

> **Everything is bps now.** #772 unified splits on integer basis points (`10000 = 100%`). The old `Float` `sharePercentage` / `revenueSharePercentage` columns are gone — `ConsultantEarnings.shareBps` and the collaborator `revenueShareBps` columns replace them. Float money math is banned.

---

## 3. The `BOOKING` posting

The split becomes one balanced transaction (`booking:<paymentId>`, kind `BOOKING`). The funding legs ([payment legs](08-payment-legs.md)) are the debits; the split is the credits:

```
Dr CASH / WALLET(org) / ORG_RECEIVABLE(org) / PLATFORM_PROMO   (the funding legs)
Dr DISCOUNT            max(0, originalAmount + taxAmount − Σ(funding-leg debits))
   Cr PLATFORM_FEE              platform fee
   Cr CONSULTANT_PAYABLE(consultant)   total consultant pool
   Cr ORG_PAYABLE(org)         org share (only if > 0)
   Cr GST_PAYABLE              tax amount
```

See [ledger & postings §4.2](03-ledger-and-postings.md) for the exact leg-to-account mapping. **Single-consultant bookings post inline; multi-collaborator bookings defer the journal** (tracked gap **#773**) — their per-collaborator HOST-org settlement still writes `OrganizationEarnings`, but the balanced booking transaction is posted later.

---

## 4. Earnings rows are reconciled caches

Both earnings tables carry **bps snapshots** so a later rate bump can't rewrite them, plus cached amount columns the reconciler checks:

```prisma
model OrganizationEarnings {
  orgSharePaise        Int
  platformFeePaise     Int
  consultantSharePaise Int
  rateCardIdApplied    String?
  platformBpsApplied   Int?
  orgBpsApplied        Int?
  consultantBpsApplied Int?
  @@unique([paymentId, organizationId])  // one row per (payment, HOST org)
}
model ConsultantEarnings {
  shareBps             Int    // multi-collaborator split, basis points
  platformFeePaise     Int
  consultantSharePaise Int
  status               EarningStatus  // PENDING → READY → HELD → PAID
  holdUntil            DateTime?
}
```

Settlement/payout code reads the `*Applied` / `*AtBooking` snapshots and the cached amounts — **never** the live `RateCard`. The reconciler asserts the cached amounts equal the booking journal's `PLATFORM_FEE + CONSULTANT_PAYABLE + ORG_PAYABLE` credits (`EARNINGS_LEDGER_DRIFT`, [ledger integrity](09-ledger-integrity.md)).

Note (per-collaborator, A3): one `Payment` can carry **N** `OrganizationEarnings` rows — the primary expert's org plus one per collaborator-at-a-different-HOST-org, capped by the `@@unique([paymentId, organizationId])` constraint.

---

## 5. `PayoutRecipient` — who gets the expert leg

`Membership.payoutRecipient` decides where the consultant share lands:
- `SELF` (default, marketplace) — booked to `ConsultantEarnings` for the expert's own payout.
- `ORGANIZATION` — internal/salaried expert; the expert-share leg is booked to the org, collapsing the three-way split into platform + org for that booking.

See [expert lifecycle](../30-programs-and-lifecycle/03-expert-lifecycle.md) for how an org flips an expert to `ORGANIZATION` on approval.

---

## 6. Program overage — when a booking breaches the cap

A sponsored booking can exceed the covering `ProgramAssignment`'s cap (a LICENSED_SEAT's `coveredEngagementsPerCycle` or a CREDIT_POOL's `creditsPerCycle`). What happens is governed by the program's `OverageBehavior` (`BLOCK` / `CHARGE_MEMBER` / `CHARGE_ORG`) and computed by one pure mapper, `computeOverageForBooking` (`lib/payments/billing/overage.ts`), shared by both the pre-checkout preview and the at-checkout recorder so the two can never drift.

### 6.1 The marginal: base + surcharge
The marginal is the **over-cap portion of the real booking price** (consulting rates are heterogeneous, so it's a pass-through, optionally capped per engagement by `priceCapPerEngagementPaise`), then marked up by `overageSurchargeBps`. `OverageEvent` itemizes both so the charge stays auditable and GST-splittable:

- `basePaise` — the pass-through over-cap portion. **Invariant: `coveredPaise + basePaise == booking price`.**
- `surchargePaise` — `floor(basePaise × overageSurchargeBps / 10000)`. The surcharge is what can push the marginal *above* a single booking price (overage costs more, by design).
- `marginalPaise` — the authoritative charged total, `basePaise + surchargePaise`.

### 6.2 Pre-checkout preview
`previewOverageForBooking` (`lib/payments/billing/overage-preview.ts`, surfaced at `POST /api/organizations/[orgId]/checkout/overage-preview`) answers "if this member books this plan via this org now, will it breach the cap and what does it cost?" — so the checkout UI warns **before** pay. It resolves the same active assignment as checkout and runs the same mapper over the assignment's *current* (pre-booking) usage, returning `coveredPaise` / `marginalPaise` / `surchargePaise`, `willExceedCap`, `willBlock`, and `chargeTo`. PERSONAL funding, no covering assignment, or an unlimited LICENSE seat → `applicable: false` (no overage line shown).

### 6.3 At-checkout recording + the circuit breaker
On a real over-cap checkout, `recordOverageAtCheckout` (`lib/payments/billing/overage-settlement.ts`) runs inside the booking's Serializable tx:

- **Circuit breaker.** `maxOveragePerCyclePaise` is a per-cycle overage ceiling. If `cycleOverageSoFarPaise + marginal` would breach it, the mapper returns `decision: BLOCK, chargeTo: null` **regardless of `overageBehavior`** — the recorder throws `PROGRAM_CAP_EXHAUSTED` (HTTP 402), the same shape as a `BLOCK`-behavior refusal but with a distinct code so the dashboard can say "cycle ceiling" vs "per-member allocation". An unknown/missing `overageBehavior` also **fails safe to `BLOCK`**.
- **`CHARGE_MEMBER`** → a parent-linked **PENDING side-`Payment`** for the marginal (gateway *not* called inside the tx; the order is minted lazily when the member opens the resume-checkout surface) + an `OverageEvent(PENDING)`. To avoid double-collecting `basePaise`, checkout carves it out of the org-funded parent's `INVOICE_ACCRUAL` leg (fail-closed: a non-invoice-funded parent has no credit-back path yet, #715, so it aborts rather than double-charge). Member is notified (`notifyOrgProgramOverageDue`) with a pay deep link. The webhook later posts the `OVERAGE_MEMBER` org-relief leg ([§4.8 of ledger & postings](03-ledger-and-postings.md)).
- **`CHARGE_ORG`** → carve `basePaise` out of the base `INVOICE_ACCRUAL` leg and write the marginal as a distinct **`OVERAGE_INVOICE_ACCRUAL`** leg (the distinct source dodges the `@@unique([paymentId, source])` clash) + an `OverageEvent(PENDING)`. The cycle-close rollup turns it into an `InvoiceLineItem` and walks the event `PENDING → ACCRUED → CHARGED` ([invoicing](07-invoicing.md)).

The `chargeStatus` state machine itself is a single guarded transition (`transitionOverage`, `overage-transitions.ts`); the [overage-event lifecycle table](#) of states (`PENDING/ACCRUED/CHARGED/BLOCKED/REVERSED/FAILED`) is in [funding & programs](../00-foundations/03-funding-and-programs.md) / [programs](../30-programs-and-lifecycle/02-programs.md).

### 6.4 CHARGE_MEMBER timeout — two crons, two jobs
A member-pays overage sits `PENDING` until the side-payment SUCCEEDS. **Two distinct crons** retire never-settled ones — read both before touching either:

| Cron | Window | What it does | Notifies? |
| --- | --- | --- | --- |
| `jobs/cleanup/sweep-abandoned-overage-charges.ts` (#785) | 7 days off the synthetic `overage:` intent | FAILs **never-*started*** side-charges (member never even minted the order) so they stop counting toward the circuit-breaker ceiling — **silent ceiling relief** | No |
| `jobs/billing/timeout-member-overages.ts` (#779 §A) | hard **14-day** wall | FAILs the `OverageEvent` via the dedicated `chargeTimedOutAt` stamp + telemetry (`chargeAttemptCount` / `lastChargeAttemptAt` / `chargeFailureReason`) and **tells the member** the obligation lapsed | Yes |

They're idempotent against each other: a row the 7-day sweep already moved to `FAILED` no longer matches `chargeStatus = PENDING` in the 14-day cron, and both claim on a `…:null` gate so a re-run/replica matches zero rows. A late capture webhook can still recover a wrongly-swept charge (`FAILED → CHARGED`, see `transitionOverage`).

### 6.5 Refund-failed notification
Refunds (including overage reversals) are gateway-bound; a `Refund` that the gateway **rejects** is stamped `failedAt` + `failureReason`, and the refund reconcile cron (`jobs/refunds/reconcile-pending-refunds.ts`, every 15 min) pages the payer via `notifyFailedRefunds`, selecting `FAILED` refunds where `failedNotifiedAt IS NULL` and stamping it so the alert fires once. (`Refund.reason` is the *operator's* reason for refunding; `failureReason` is *why the gateway said no* — don't conflate them.) See [invoicing §8](07-invoicing.md) for the refund credit-note cascade.

---

### Related docs
- [Payment legs](08-payment-legs.md) — the funding side (the booking's debits).
- [Ledger & postings](03-ledger-and-postings.md) — the `BOOKING` transaction in full.
- [Payout pipeline](06-payout-pipeline.md) — how earnings roll up into payouts.
- [Ledger integrity](09-ledger-integrity.md) — `EARNINGS_LEDGER_DRIFT`.
- [Concurrency & idempotency](../30-programs-and-lifecycle/01-concurrency-and-idempotency.md) — the atomic rate-card bump.
- [Expert lifecycle](../30-programs-and-lifecycle/03-expert-lifecycle.md) · [Harness verdict](../60-scenarios-and-verdicts/02-harness-verdict.md).
