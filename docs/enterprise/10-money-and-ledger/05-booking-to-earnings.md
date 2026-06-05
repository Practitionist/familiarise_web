---
title: Booking → earnings
band: 10-money-and-ledger
audience: sde2
status: live
last-reviewed: 2026-06-05
---

# Booking → earnings

**What this covers:** how a sponsored booking turns into money — the three-way split (`RateCard`, basis points, snapshots), the `BOOKING` ledger posting it produces, and the `ConsultantEarnings` / `OrganizationEarnings` rows that cache the result for payout. The funding side (which sources paid) is in [payment legs](09-payment-legs.md); the journal mechanics are in [ledger & postings](03-ledger-and-postings.md).

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

### 2.1 Two worked splits — marketplace vs HOST org

The split a booking gets depends on whether the expert settles to a HOST org. `resolveOrgSplit` looks for an `ACTIVE` `EXPERT` membership on a `canHost` org (`earnings-service.ts:136`); if there isn't one, the booking takes the **marketplace path**, and if there is, it takes the **RateCard three-way path**. Same ₹8,000 booking (`grossAmount = 800_000` paise; GST is computed separately on the fee region), two outcomes:

**Marketplace — Arjun Anderson (seeded freelance solo, no HOST-org panel).** No org split resolves, so the platform takes a flat `PLATFORM_FEE_PERCENTAGE` (**20%**) and the consultant gets the rest — there is no org leg at all (`earnings-service.ts:279`):

```
grossAmount          = 800_000 paise
platformFeePaise     = round(800_000 × 20 / 100) = 160_000   (platform's 20%)
totalConsultantPool  = 800_000 − 160_000         = 640_000   (Arjun's ConsultantEarnings)
```

Arjun nets **₹6,400**; the platform recognizes **₹1,600**. His `ConsultantEarnings.consultantSharePaise` carries the full ₹6,400 — no `OrganizationEarnings` row exists because no org is in the loop.

**HOST org — a LearnPro panel expert (seeded RateCard 10 / 10 / 80).** Now `resolveOrgSplit` finds the LearnPro EXPERT membership and runs `computeSplit` with the seeded card. Each independent share is **floored**, and the **org leg absorbs the rounding remainder** (`earnings-service.ts:162`):

```
grossAmount          = 800_000 paise
platformFeePaise     = floor(800_000 × 1000 / 10000) = floor(80_000.0)  =  80_000  (10%)
consultantSharePaise = floor(800_000 × 8000 / 10000) = floor(640_000.0) = 640_000  (80%)
orgShare             = 800_000 − 80_000 − 640_000                       =  80_000  (the 10% org leg, by subtraction)
```

So the same ₹8,000 splits ₹800 platform / ₹6,400 to the panel expert / ₹800 retained by LearnPro — a three-way posting (`Cr PLATFORM_FEE` + `Cr CONSULTANT_PAYABLE` + `Cr ORG_PAYABLE`), see [chart of accounts §4](02-chart-of-accounts.md). The floors matter on odd amounts: a ₹8,001 booking (`800_100`) gives `platformFee = 80_010`, `consultantShare = 640_080`, `orgShare = 800_100 − 80_010 − 640_080 = 80_010` — the remainder lands in the org leg, never lost. Two independent `floor`s can each shave a paise; subtracting-the-rest into `orgShare` is what keeps `platformFee + consultantShare + orgShare == gross` exactly.

> Note the marketplace path uses the `PLATFORM_FEE_PERCENTAGE` constant (20%), **not** the `DEFAULT_RATE_CARD` (10/10/80). The default card is the fallback *inside* `computeSplit` — it only applies on the HOST-org path when no more-specific card resolves. A true solo marketplace booking never reaches `computeSplit`, so the two figures (20% vs 10%) are *not* a contradiction: they're two different code paths gated on whether a `canHost` EXPERT membership exists.

---

## 3. The `BOOKING` posting

The split becomes one balanced transaction (`booking:<paymentId>`, kind `BOOKING`). The funding legs ([payment legs](09-payment-legs.md)) are the debits; the split is the credits:

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

Settlement/payout code reads the `*Applied` / `*AtBooking` snapshots and the cached amounts — **never** the live `RateCard`. The reconciler asserts the cached amounts equal the booking journal's `PLATFORM_FEE + CONSULTANT_PAYABLE + ORG_PAYABLE` credits (`EARNINGS_LEDGER_DRIFT`, [ledger integrity](13-ledger-integrity.md)).

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
- **`CHARGE_ORG`** → carve `basePaise` out of the base `INVOICE_ACCRUAL` leg and write the marginal as a distinct **`OVERAGE_INVOICE_ACCRUAL`** leg (the distinct source dodges the `@@unique([paymentId, source])` clash) + an `OverageEvent(PENDING)`. The cycle-close rollup turns it into an `InvoiceLineItem` and walks the event `PENDING → ACCRUED → CHARGED` ([invoicing](08-invoicing.md)).

The `chargeStatus` state machine itself is a single guarded transition (`transitionOverage`, `overage-transitions.ts`); the overage-event lifecycle table of states (`PENDING/ACCRUED/CHARGED/BLOCKED/REVERSED/FAILED`) is in [funding & programs](../00-foundations/03-funding-and-programs.md) / [programs](../30-programs-and-lifecycle/02-programs.md).

---

## 7. Design decisions & trade-offs

- **Snapshot the card at booking, never resolve it retroactively.** A `RateCard` is time-scoped and immutable: a rate change closes the old row and inserts a new one (`bumpRateCard()`), and every earnings row stamps the `*Applied` bps it was split on (`OrganizationEarnings.platformBpsApplied/orgBpsApplied/consultantBpsApplied`, `ConsultantEarnings.shareBps`). The rejected alternative — a mutable card that settlement reads live — is simpler by one table-write but **corrupts history**: a Monday rate bump would silently restate Sunday's already-posted booking, and the reconciler's `EARNINGS_LEDGER_DRIFT` ([§4](#4-earnings-rows-are-reconciled-caches)) would then fire on every pre-bump payment because the cached amounts no longer match a card that changed underneath them. The cost is the snapshot columns + the close-and-insert dance; the benefit is that yesterday's money is *frozen* — settlement code reads the snapshot, never the live card.
- **`floor` each independent share, subtract-the-rest into the org leg.** Three `round`s could sum to gross ± 1 paise; flooring `platformFee` and `consultantShare` independently and computing `orgShare = gross − platformFee − consultantShare` makes the identity `platformFee + consultantShare + orgShare == gross` hold *by construction* (§2.1). The org leg deliberately absorbs the ≤1 paise remainder — it's the residual party, and a clamp guards the rare negative-`orgShare` case (`earnings-service.ts:185`).
- **Earnings rows are reconciled caches, not the source of truth.** The authoritative split is the `BOOKING` journal's credits; the `Earnings` tables cache it (with bps snapshots) so payout can read one row instead of re-summing the journal per consultant. Same contract as `walletBalance` ([money model overview §4](01-money-model-overview.md)): append-only journal is truth, the cache is reconciled nightly (`EARNINGS_LEDGER_DRIFT`).

### 🛠️ What this design survived

- **The silently-dropped `DISCOUNT` plug on referral-funded bookings (`d335901e`, #776 / #785 review).** The `BOOKING` posting's `DISCOUNT` leg is the platform-absorbed gap between gross (`originalAmount + taxAmount`) and the funding actually applied. It was computed off `Payment.amount` — but a `REFERRAL_CREDIT` leg funds the booking (debited as `PLATFORM_PROMO`) and is **already excluded** from `Payment.amount` (the post-credit figure). So the credit was counted twice (once as `PLATFORM_PROMO`, once inside `DISCOUNT`), the posting failed `Σdebit == Σcredit`, and `postLedgerTxn` threw — silently dropping the *entire booking transaction* for any referral-funded booking while the earnings rows still wrote. The fix bases the plug on `Σ(funding-leg debits)` (`fundingDebitTotal`, `earnings-service.ts:468`), counting the credit once. **Full narrative + the posting block lives in [ledger & postings §5b](03-ledger-and-postings.md#5b-what-this-design-survived)** — this doc owns the booking-split side; that doc owns the journal mechanics. The `DISCOUNT … max(0, originalAmount + taxAmount − Σ(funding-leg debits))` line in §3's posting box is the trace back to this fix: it bases on the funding-leg sum precisely so the referral credit isn't double-counted.

### 6.4 CHARGE_MEMBER timeout — two crons, two jobs
A member-pays overage sits `PENDING` until the side-payment SUCCEEDS. **Two distinct crons** retire never-settled ones — read both before touching either:

| Cron | Window | What it does | Notifies? |
| --- | --- | --- | --- |
| `jobs/cleanup/sweep-abandoned-overage-charges.ts` (#785) | 7 days off the synthetic `overage:` intent | FAILs **never-*started*** side-charges (member never even minted the order) so they stop counting toward the circuit-breaker ceiling — **silent ceiling relief** | No |
| `jobs/billing/timeout-member-overages.ts` (#779 §A) | hard **14-day** wall | FAILs the `OverageEvent` via the dedicated `chargeTimedOutAt` stamp + telemetry (`chargeAttemptCount` / `lastChargeAttemptAt` / `chargeFailureReason`) and **tells the member** the obligation lapsed | Yes |

They're idempotent against each other: a row the 7-day sweep already moved to `FAILED` no longer matches `chargeStatus = PENDING` in the 14-day cron, and both claim on a `…:null` gate so a re-run/replica matches zero rows. A late capture webhook can still recover a wrongly-swept charge (`FAILED → CHARGED`, see `transitionOverage`).

### 6.5 Refund-failed notification
Refunds (including overage reversals) are gateway-bound; a `Refund` that the gateway **rejects** is stamped `failedAt` + `failureReason`, and the refund reconcile cron (`jobs/refunds/reconcile-pending-refunds.ts`, every 15 min) pages the payer via `notifyFailedRefunds`, selecting `FAILED` refunds where `failedNotifiedAt IS NULL` and stamping it so the alert fires once. (`Refund.reason` is the *operator's* reason for refunding; `failureReason` is *why the gateway said no* — don't conflate them.) See [invoicing §8](08-invoicing.md) for the refund credit-note cascade.

---

### Related docs
- [Payment legs](09-payment-legs.md) — the funding side (the booking's debits).
- [Ledger & postings](03-ledger-and-postings.md) — the `BOOKING` transaction in full.
- [Payout pipeline](07-payout-pipeline.md) — how earnings roll up into payouts.
- [Ledger integrity](13-ledger-integrity.md) — `EARNINGS_LEDGER_DRIFT`.
- [Concurrency & idempotency](../30-programs-and-lifecycle/01-concurrency-and-idempotency.md) — the atomic rate-card bump.
- [Expert lifecycle](../30-programs-and-lifecycle/03-expert-lifecycle.md) · [Harness verdict](../60-scenarios-and-verdicts/02-harness-verdict.md).
