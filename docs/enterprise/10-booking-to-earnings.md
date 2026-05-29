# Booking → earnings

**What this covers:** how a sponsored booking turns into money — the three-way split (`RateCard`, basis points, snapshots), the `BOOKING` ledger posting it produces, and the `ConsultantEarnings` / `OrganizationEarnings` rows that cache the result for payout. The funding side (which sources paid) is in [payment legs](13-payment-legs.md); the journal mechanics are in [ledger & postings](08-ledger-and-postings.md).

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

The `walletDebit` in step 2 moves only the **cache** ([wallet & top-ups](09-wallet-and-topups.md)); the authoritative `Dr WALLET` leg is posted later, inside the booking transaction, where the full split is known.

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

The split becomes one balanced transaction (`booking:<paymentId>`, kind `BOOKING`). The funding legs ([payment legs](13-payment-legs.md)) are the debits; the split is the credits:

```
Dr CASH / WALLET(org) / ORG_RECEIVABLE(org) / PLATFORM_PROMO   (the funding legs)
Dr DISCOUNT            max(0, originalAmount + taxAmount − amount)
   Cr PLATFORM_FEE              platform fee
   Cr CONSULTANT_PAYABLE(consultant)   total consultant pool
   Cr ORG_PAYABLE(org)         org share (only if > 0)
   Cr GST_PAYABLE              tax amount
```

See [ledger & postings §4.2](08-ledger-and-postings.md) for the exact leg-to-account mapping. **Single-consultant bookings post inline; multi-collaborator bookings defer the journal** (tracked gap **#773**) — their per-collaborator HOST-org settlement still writes `OrganizationEarnings`, but the balanced booking transaction is posted later.

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

Settlement/payout code reads the `*Applied` / `*AtBooking` snapshots and the cached amounts — **never** the live `RateCard`. The reconciler asserts the cached amounts equal the booking journal's `PLATFORM_FEE + CONSULTANT_PAYABLE + ORG_PAYABLE` credits (`EARNINGS_LEDGER_DRIFT`, [ledger integrity](14-ledger-integrity.md)).

Note (per-collaborator, A3): one `Payment` can carry **N** `OrganizationEarnings` rows — the primary expert's org plus one per collaborator-at-a-different-HOST-org, capped by the `@@unique([paymentId, organizationId])` constraint.

---

## 5. `PayoutRecipient` — who gets the expert leg

`Membership.payoutRecipient` decides where the consultant share lands:
- `SELF` (default, marketplace) — booked to `ConsultantEarnings` for the expert's own payout.
- `ORGANIZATION` — internal/salaried expert; the expert-share leg is booked to the org, collapsing the three-way split into platform + org for that booking.

See [expert lifecycle](22-expert-lifecycle.md) for how an org flips an expert to `ORGANIZATION` on approval.

---

### Related docs
- [Payment legs](13-payment-legs.md) — the funding side (the booking's debits).
- [Ledger & postings](08-ledger-and-postings.md) — the `BOOKING` transaction in full.
- [Payout pipeline](11-payout-pipeline.md) — how earnings roll up into payouts.
- [Ledger integrity](14-ledger-integrity.md) — `EARNINGS_LEDGER_DRIFT`.
- [Concurrency & idempotency](20-concurrency-and-idempotency.md) — the atomic rate-card bump.
- [Expert lifecycle](22-expert-lifecycle.md) · [Harness verdict](51-harness-verdict.md).
