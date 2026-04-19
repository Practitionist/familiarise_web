# Payment legs and stackable funding

A single booking can be funded by more than one source at the same
time: a wallet covers most of the price, a referral credit chips in,
and the learner's card picks up whatever remains. `PaymentLeg` models
this — one `Payment` with N `PaymentLeg` rows whose amounts sum to
`Payment.amountPaid`.

## Schema

```prisma
model PaymentLeg {
  id          String           @id @default(uuid())
  paymentId   String
  payment     Payment          @relation(fields: [paymentId], references: [id], onDelete: Cascade)
  source      PaymentLegSource
  amountPaise Int
  sourceRef   String?   // wallet-entry id | referral-credit id | gateway txn id
  createdAt   DateTime  @default(now())
  @@index([paymentId])
  @@index([source])
}

enum PaymentLegSource {
  CARD              // external gateway charge
  WALLET            // BillingAccount wallet debit (was SEAT_PACK)
  REFERRAL_CREDIT   // platform-issued personal credit
  INVOICE_ACCRUAL   // rolled into an OrganizationInvoice at month-end
  LICENSE           // absorbed by a LICENSED_SEAT program (no money moves)
}
```

## Invariants

1. **Sum identity.** `sum(PaymentLeg.amountPaise) for a Payment ===
   Payment.amountPaid`. Enforced at the checkout write site; a
   follow-up cron verifies against historical data.
2. **Leg count.** Every successful `Payment` has at least one leg. A
   `Payment` with `status = SUCCEEDED` and zero legs is a data bug.
3. **Source uniqueness per payment.** Two legs of the same source on
   the same payment is illegal (you can't split a card charge in two
   at the checkout layer; refunds are modelled as a separate `Refund`
   row, not an inverse leg).
4. **sourceRef is always populated** for WALLET (→ `WalletEntry.id`)
   and REFERRAL_CREDIT (→ `ReferralCredit.id`). It's the join key for
   reversal. CARD and LICENSE legs may omit it (CARD keeps the gateway
   txn id here when populated; LICENSE has no reversal target).

## How each source ends up on a leg

| Source | Writer | Trigger |
|--------|--------|---------|
| `CARD` | Checkout handler | Learner paid via gateway (Stripe/Razorpay). `amountPaise` = remainder after wallet + credits. |
| `WALLET` | `walletDebit()` | Sponsor org has `fundingSource = WALLET`. Leg is written inside the same transaction as the WalletEntry. |
| `REFERRAL_CREDIT` | Referral consumption helper | Platform referral credits applied at checkout, up to the learner's available balance. |
| `INVOICE_ACCRUAL` | Checkout handler | Sponsor org has `fundingSource = INVOICE`. No money moves at booking time; the `sum of INVOICE_ACCRUAL legs across the month` becomes the invoice total. |
| `LICENSE` | Checkout handler | An active `LICENSED_SEAT` ProgramAssignment absorbs the booking (session within cap). `amountPaise = 0`. |

## Worked example: a stacked checkout

Learner price is ₹5,000 = 500,000 paise. Learner belongs to an
INVOICE-funded org with a LICENSED_SEAT Program that covers CONSULT
plans up to ₹3,000 per session; the remainder is
`CHARGE_MEMBER`. Learner has ₹500 of referral credits.

```
price:                500,000
  - licence absorbs:  300,000  → PaymentLeg(source=LICENSE,         amountPaise=0)
  - overage amount:   200,000
    - referral covers: 50,000  → PaymentLeg(source=REFERRAL_CREDIT, amountPaise=50000)
    - card covers:    150,000  → PaymentLeg(source=CARD,            amountPaise=150000)

sum of amountPaise (excluding LICENSE which is 0): 200,000
Payment.amountPaid: 200,000
```

The LICENSE leg is written with `amountPaise = 0` so the sum still
balances. The invariant `sum === Payment.amountPaid` holds because
LICENSE is the zero-amount marker, not part of the actual money flow.

## Refunds

Refunds are modelled by the `Refund` model (not an inverse leg). On
refund:

- WALLET legs → `walletCredit(reason=REFUND)` reverses the debit.
- REFERRAL_CREDIT legs → the referral balance is re-credited.
- CARD legs → gateway refund is issued.
- INVOICE_ACCRUAL legs → a credit line is added to the next invoice
  cycle.
- LICENSE legs → no money to refund; the corresponding
  `BookingUtilization` is stamped with `reversedAt` and the
  assignment's `sessionsUsed` is decremented.

## Why PaymentLeg and not N columns on Payment

- The number of sources is unbounded in practice — we already have 5
  and will add more (e.g. corporate gift-card).
- Columns would mean wide-and-mostly-null rows plus a schema change
  per new source.
- The leg table indexes the (paymentId, source) join that settlement
  and analytics both need, and the per-leg `sourceRef` avoids a JOIN
  to the wallet / credit / referral table from every settlement query.

## Related docs

- `02-funding-and-programs.md` — how each FundingSource maps to a leg
  source.
- `09-wallet-and-ledger.md` — WALLET leg mechanics.
- `10-invoicing.md` — how INVOICE_ACCRUAL legs roll up.
- `18-three-ledger-discipline.md` — the Settlement ledger that mirrors
  leg activity at the inter-entity level.
