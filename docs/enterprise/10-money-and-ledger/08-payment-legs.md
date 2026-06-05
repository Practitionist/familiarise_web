# Payment legs & stackable funding

**What this covers:** how one booking can be funded by several sources at once (`PaymentLeg`), and how each leg source maps to a **debit in the `BOOKING` ledger posting**. This is the funding side of [booking → earnings](05-booking-to-earnings.md).

> A single checkout can stack funding: a wallet covers most of the price, a referral credit chips in, the learner's card picks up the rest. `PaymentLeg` models it — one `Payment`, N legs whose amounts sum to `Payment.amount`. Those same legs become the **debit side** of the booking journal transaction.

---

## 1. Schema

```prisma
model PaymentLeg {
  id          String           @id @default(uuid())
  paymentId   String
  payment     Payment          @relation(fields: [paymentId], references: [id], onDelete: Cascade)
  source      PaymentLegSource
  amountPaise Int
  sourceRef   String?   // referral-credit id | gateway txn id | accrual ref
  createdAt   DateTime  @default(now())
  @@unique([paymentId, source])
  @@index([paymentId])
  @@index([source])
}

enum PaymentLegSource {
  CARD                      // external gateway charge
  WALLET                    // BillingAccount wallet debit
  REFERRAL_CREDIT           // platform-issued personal credit
  INVOICE_ACCRUAL           // rolled into an OrganizationInvoice at month-end
  OVERAGE_INVOICE_ACCRUAL   // program-overage portion, billed via invoice
  LICENSE                   // absorbed by a LICENSED_SEAT program (no money moves)
}
```

---

## 2. Each leg → the account it debits in the `BOOKING` posting

```mermaid
flowchart LR
  subgraph Legs["PaymentLeg.source"]
    C[CARD]
    W[WALLET]
    IA["INVOICE_ACCRUAL /<br/>OVERAGE_INVOICE_ACCRUAL"]
    RC[REFERRAL_CREDIT]
    LIC["LICENSE (0)"]
  end
  subgraph Debits["BOOKING transaction — debit legs"]
    CASH[(CASH)]
    WALLET[("WALLET(org)")]
    AR[("ORG_RECEIVABLE(org)")]
    PROMO[(PLATFORM_PROMO)]
  end
  C --> CASH
  W --> WALLET
  IA --> AR
  RC --> PROMO
  LIC -. "no money moves" .-> X[" "]
```

`earnings-service.ts` sums the legs by source and emits one debit per non-zero bucket; `LICENSE` legs (`amountPaise = 0`) post nothing. The credit side is the fee/payable/GST split ([§3 of booking → earnings](05-booking-to-earnings.md)).

| Source | Writer | Trigger | Booking debit |
|--------|--------|---------|---------------|
| `CARD` | checkout handler | learner paid via gateway; `amountPaise` = remainder after wallet + credits | `CASH` |
| `WALLET` | `walletDebit()` | sponsor org `fundingSource = WALLET`; leg written in the same tx as the cache decrement | `WALLET(org)` |
| `REFERRAL_CREDIT` | referral consumption helper | platform referral credits applied at checkout | `PLATFORM_PROMO` |
| `INVOICE_ACCRUAL` | checkout handler | sponsor org `fundingSource = INVOICE`; no cash at booking, sum-per-cycle becomes the invoice | `ORG_RECEIVABLE(org)` |
| `OVERAGE_INVOICE_ACCRUAL` | checkout handler | program-overage portion billed via invoice | `ORG_RECEIVABLE(org)` |
| `LICENSE` | checkout handler | active `LICENSED_SEAT` assignment absorbs the session; `amountPaise = 0` | — (no money) |

---

## 3. Invariants

1. **Sum identity.** `sum(PaymentLeg.amountPaise) === Payment.amount` (LICENSE is 0). Enforced at checkout; the reconciler's `PAYMENT_LEG_SUM_MISMATCH` is the retroactive detector ([ledger integrity](09-ledger-integrity.md)).
2. **Leg count ≥ 1.** A `SUCCEEDED` payment with zero legs is a data bug.
3. **Source uniqueness per payment.** `@@unique([paymentId, source])` — a duplicate-source leg fails on insert (`P2002`) rather than corrupting the sum. If split-billing across sub-orgs becomes real, drop this and add a `legGroupId` (tracked follow-up).
4. **`sourceRef` for reversal.** Populated for `REFERRAL_CREDIT` (→ `ReferralCredit.id`) and where a gateway/accrual ref exists. `WALLET` legs no longer reference a per-row wallet log (`WalletEntry` was removed in #772) — the authoritative wallet movement is the booking journal's `Dr WALLET(org)` leg; the cache decrement is `walletDebit()`. `LICENSE`/`CARD` may omit `sourceRef`.

---

## 4. Worked example: a stacked checkout

Learner price ₹5,000 (500,000 paise). INVOICE-funded org with a `LICENSED_SEAT` program covering CONSULT plans up to ₹3,000/session; the remainder is `CHARGE_MEMBER`. Learner has ₹500 of referral credits.

```
price:                500,000
  - licence absorbs:  300,000  → PaymentLeg(LICENSE,         amountPaise=0)
  - overage amount:   200,000
    - referral covers: 50,000  → PaymentLeg(REFERRAL_CREDIT, amountPaise=50000)
    - card covers:    150,000  → PaymentLeg(CARD,            amountPaise=150000)

sum (excl. LICENSE=0): 200,000  ==  Payment.amount: 200,000
```

The resulting booking posting debits `PLATFORM_PROMO` 50,000 + `CASH` 150,000 against the fee/payable/GST credits.

### 4.1 A wallet + referral + card stack

The canonical three-source stack the mental model opens with. A learner books a ₹3,000 (300,000 paise) session sponsored by a **WALLET-funded org** (`fundingSource = WALLET`) that has ₹2,000 of wallet balance left; the learner also holds ₹200 of referral credit; the card covers the rest. Checkout allocates **in priority order** — entitlement/wallet first, then platform credits, card last:

```
price:                 300,000
  - wallet covers:     200,000  → PaymentLeg(WALLET,          amountPaise=200000)
  - referral covers:    20,000  → PaymentLeg(REFERRAL_CREDIT, amountPaise=20000)
  - card covers:        80,000  → PaymentLeg(CARD,            amountPaise=80000)

sum: 300,000  ==  Payment.amount: 300,000
```

The `walletDebit()` overdraft guard ([wallet & top-ups §4](04-wallet-and-topups.md)) atomically tests-and-decrements the ₹2,000 → ₹0 cache in the same tx the `WALLET` leg is written. The booking posting then debits `WALLET(org) 200,000` + `PLATFORM_PROMO 20,000` (the referral credit the platform eats) + `CASH 80,000`, balanced against the fee/payable/GST credits ([booking → earnings §3](05-booking-to-earnings.md#3-the-booking-posting)). Three sources, three legs, one `Payment` — and the journal's debit side is exactly those three legs summed by source ([ledger & postings §4.2](03-ledger-and-postings.md#42-booking--booking-bookingpaymentid)). Note `Payment.amount` here is the **full** 300,000 because none of these legs is excluded from it — unlike a pure referral-funded booking, where the credit is netted out of `amount` and the `DISCOUNT` plug picks up the gap (the trap behind the [booking → earnings §7 war story](05-booking-to-earnings.md#7-design-decisions--trade-offs)).

---

## 5. Refunds

Refunds are a `Refund` row (not an inverse leg) plus a `REFUND` journal transaction that reverses the booking legs proportionally ([ledger & postings §4.7](03-ledger-and-postings.md)):
- `WALLET` legs → the refund's `Cr WALLET(org)` returns spending power; the cache is credited via `walletCredit(reason=REFUND)`.
- `REFERRAL_CREDIT` legs → referral balance re-credited.
- `CARD` legs → gateway refund issued.
- `INVOICE_ACCRUAL` legs → credit line on the next invoice cycle.
- `LICENSE` legs → no money; `BookingUtilization.reversedAt` set and `engagementsUsed` decremented ([programs](../30-programs-and-lifecycle/02-programs.md)).

---

## 6. Design decisions & trade-offs

- **Stackable legs, not single-source payments.** The whole reason `PaymentLeg` exists: a real checkout funds *one* booking from *several* pools at once — a sponsor's wallet, the learner's referral credit, and a card top-up, as in §4.1. A single `Payment.fundingSource` enum would force "pick one," which means either refusing a booking the wallet can't fully cover or losing the credit. Modelling each contribution as a leg lets the price be satisfied by any combination, and makes the booking journal's debit side a direct sum-by-source of the legs ([ledger & postings §4.2](03-ledger-and-postings.md#42-booking--booking-bookingpaymentid)). The cost is a child table + the sum-identity invariant (§3); the benefit is funding composes.
- **`PaymentLeg`, not N columns on `Payment`.** Given legs must exist, the next question is rows vs columns. Sources are unbounded (already 6, more coming); columns would mean wide, mostly-null rows + a migration per new source. The leg table indexes the `(paymentId, source)` join settlement and analytics need, and `sourceRef` avoids a JOIN to the credit/referral table from every settlement query.
- **`@@unique([paymentId, source])` — one leg per source, dodged by a distinct overage source.** A duplicate-source leg fails on insert (`P2002`) rather than corrupting the sum (§3). This is also *why* `OVERAGE_INVOICE_ACCRUAL` is a separate enum value from `INVOICE_ACCRUAL`: a `CHARGE_ORG` overage needs its own leg on a payment that may already carry a base `INVOICE_ACCRUAL` leg, and a distinct source sidesteps the unique clash without a `legGroupId`. If split-billing across sub-orgs ever becomes real, the trade-off flips — drop the unique and add `legGroupId` (tracked follow-up).

## 7. What this design survived

- **The `CHARGE_ORG` overage that double-billed via an extra leg (`7f7e7d12`, #785 C3).** When an org-charged overage was recorded at checkout, the code **added** an `OVERAGE_INVOICE_ACCRUAL` leg for the marginal *on top of* the base `INVOICE_ACCRUAL` leg — but the base leg already covered the over-cap pass-through (`basePaise`). Because `rollupOrgInvoiceAccruals` sums **both** leg sources into the invoice ([invoicing §9](07-invoicing.md#9-overage-roll-up-into-a-line-item-715--775)), the org was billed `basePaise` **twice**, and `sum(PaymentLeg.amountPaise)` no longer equalled `Payment.amount` — tripping the reconciler's `PAYMENT_LEG_SUM_MISMATCH` ([ledger integrity](09-ledger-integrity.md)). The fix **carves** `basePaise` *out* of the base `INVOICE_ACCRUAL` leg and writes only the genuinely-additional surcharge as the overage leg, so the two legs sum to the price exactly. The symmetric `CHARGE_MEMBER` carve (so `basePaise` isn't collected on both the org's parent leg and the member's side-charge) shipped in the same commit — latent, since no `CHARGE_MEMBER` program is configured yet. This is the invariant in §3 rule 1 doing its job: the leg-sum identity is what made a silent double-bill a *loud* reconcile finding.

---

### Related docs
- [Funding & programs](../00-foundations/03-funding-and-programs.md) — how each `FundingSource` maps to a leg source.
- [Booking → earnings](05-booking-to-earnings.md) — the credit side of the booking posting.
- [Wallet & top-ups](04-wallet-and-topups.md) — `WALLET` leg mechanics.
- [Invoicing](07-invoicing.md) — how `INVOICE_ACCRUAL` legs roll up.
- [Ledger & postings](03-ledger-and-postings.md) — the full booking/refund transactions.
