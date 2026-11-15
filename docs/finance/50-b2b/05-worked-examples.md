---
title: B2B worked examples
type: tutorial
band: 50-b2b
audience: sde2
status: live
last-reviewed: 2026-10-23
---

# B2B worked examples

This page follows real money through four organisation-sponsored flows, step by step, with rupees and paise, the state after each step, and every journal line. It uses the seeded cast from `prisma/seedFiles/` (`14a-create-organizations.ts` and `1a-create-users.ts`): IIT Madras (a hybrid organisation on the `WALLET` rail, owned by Charlotte Anderson, with learner Rachel Anderson and experts Benjamin Anderson, who is paid directly, and Andrew Anderson, who is salaried), Wipro Limited (a sponsor on the `INVOICE` rail, with learner Olivia Anderson), and Grace Anderson, an independent marketplace consultant. Read the definitions first if a term is new: [funding rails](01-funding-rails-and-permutations.md), [wallet](02-wallet-and-top-ups.md), [rate cards and overage](03-rate-cards-and-overage.md), [invoices](04-invoices-purchase-orders-and-dunning.md). All times are IST unless a zone is given. Host organisations are enabled (`ENABLE_HOST_ORGS`), and a marketplace sale uses the 20 % fallback platform fee because no approved fee schedule is assumed.

## Example 1: IIT Madras tops up and a student books (wallet rail)

**Setup.** IIT Madras has a `WALLET` billing account holding 147,500,000 paise (₹14,75,000): three confirmed ₹5,00,000 top-ups less five ₹5,000 bookings. Its programme "IIT Student Coaching Pool" is a `CREDIT_POOL` of 10,000 credits a month (₹10,000, or 1,000,000 paise, per learner assignment) with a ₹5,000 (500,000 paise) per-engagement cap and the default `BLOCK` overage behaviour. Its rate card is 10 / 10 / 80.

1. **Tue 6 Oct 2026, 10:00.** Charlotte tops up ₹2,00,000 (20,000,000 paise). The row is `PENDING`; on capture the journal posts `Dr GATEWAY_CLEARING 20,000,000 / Cr WALLET(iit-madras) 20,000,000` under `topup:<orderId>`, the row becomes `CONFIRMED`, and the balance reads 167,500,000 paise (₹16,75,000) in the account and the cache.
2. **Mon 12 Oct 2026, 11:00.** Rachel books Benjamin's ₹4,000 consultation for Fri 16 Oct, 15:00. Pricing adds GST at 18 % (72,000 paise) for a total of 472,000 paise (₹4,720). The gates pass: IIT Madras is `ACTIVE`, can sponsor, Rachel is an `ACTIVE` member with session-booking consent, her assignment covers consultations, and the wallet is not frozen.
3. **Inside the checkout transaction.** The pool covers the booking, because 472,000 is within the ₹5,000 cap and the 1,000,000 budget. `walletDebit` takes 472,000, leaving 167,028,000 paise (₹16,70,280). The `Payment` is written `SUCCEEDED` with intent `org_wallet_...` and one `WALLET` leg of 472,000. The pool's `consumedPaise` rises by 472,000, leaving 528,000 of this month's budget.
4. **The split.** Benjamin sits at a host organisation with `payoutRecipient = SELF`, so IIT Madras's rate card applies to the 400,000 paise before GST: platform floor(400,000 x 1000 / 10000) = 40,000, expert floor(400,000 x 8000 / 10000) = 320,000, and the organisation takes 400,000 - 40,000 - 320,000 = 40,000.

| Journal `booking:<paymentId>`  | Dr      | Cr      |
| ------------------------------ | ------- | ------- |
| `WALLET(iit-madras)`           | 472,000 |         |
| `PLATFORM_FEE`                 |         | 40,000  |
| `ORG_PAYABLE(iit-madras)`      |         | 40,000  |
| `CONSULTANT_PAYABLE(benjamin)` |         | 320,000 |
| `GST_PAYABLE`                  |         | 72,000  |
| Total                          | 472,000 | 472,000 |

`assertWalletDebitJournaled` finds the `Dr WALLET` line, or the whole checkout would roll back. Benjamin's earning is `PENDING` until its hold-until time (48 hours after the session ends, plus 3 extra days while he is a new expert), then `READY` for the weekly payout.

**What if Rachel had booked Andrew Anderson instead?** He is salaried (`payoutRecipient = ORGANIZATION`), so the organisation absorbs the expert slice: `CONSULTANT_PAYABLE` is 0 and `ORG_PAYABLE(iit-madras)` is 360,000 (the 40,000 plus 320,000). IIT Madras spends 472,000 from its wallet and earns 360,000 back, so its net pre-tax cost is the 40,000 platform fee.

**What if the pool were spent?** After a second ₹4,720 booking the same month (944,000 paise consumed), a third finds only 56,000 paise of budget left (1,000,000 - 944,000), so 416,000 paise of its 472,000 falls outside the pool. The behaviour is `BLOCK`, so checkout refuses with the session-cap message (402), the transaction rolls back and the wallet is untouched. **What if the wallet were short?** `WALLET_INSUFFICIENT_FUNDS` (402) and nothing moves. **What if the nightly audit had frozen it?** `WalletFrozenError` (409).

**Cancellation.** If Rachel cancels on Thu 15 Oct at 15:00, 24 hours before the session, the platform ladder returns 100 %. The wallet cache and the `WALLET` account are credited back, an organisation `WALLET_REFUND` audit row is written, and the pool consumption is reversed. The journal and cascade are in [refunds](../30-refunds-disputes/01-refunds.md).

## Example 2: Wipro's learner goes past the cap (invoice rail)

**Setup.** Wipro's programme "Wipro Engineer Leadership Program" is `LICENSED_SEAT`: 12 covered engagements per cycle, a per-engagement price cap of ₹10,000 (1,000,000 paise), `CHARGE_ORG`. For this example the programme also carries a 15 % surcharge (`overageSurchargeBps = 1500`) and a ₹20,000 (2,000,000 paise) per-cycle ceiling (`maxOveragePerCyclePaise`); the seed does not set these, so assume the programme was configured with them. Olivia's seat has used 12 engagements. Grace Anderson sells at the 20 % fallback fee.

1. **Covered booking, earlier in the cycle.** Olivia's third session with Grace costs ₹4,000, so 472,000 paise with GST. The leg is `INVOICE_ACCRUAL` for 472,000 and the journal is `Dr ORG_RECEIVABLE(wipro) 472,000 / Cr PLATFORM_FEE 80,000 / Cr CONSULTANT_PAYABLE(grace) 320,000 / Cr GST_PAYABLE 72,000`. No cash moves; Wipro owes the amount until the invoice.
2. **Tue 20 Oct 2026, 14:00. The 13th booking, ₹12,000.** GST is 216,000, so the price is 1,416,000. Olivia is at 12 of 12, so the booking is past the cap. `computeOverage` works on the tax-inclusive 1,416,000:
   - marginal = min(1,416,000, price cap) = 1,000,000, so `basePaise = 1,000,000`;
   - `surchargePaise = floor(1,000,000 x 1500 / 10000) = 150,000`;
   - the cycle's overage so far is 0, and 1,150,000 is within the 2,000,000 ceiling, so the booking proceeds.
3. **The carve.** `recordOrgOverageCharge` takes 1,000,000 out of the `INVOICE_ACCRUAL` leg (leaving 416,000), computes the GST on the surcharge (18 % of 150,000 = 27,000), and writes an `OVERAGE_INVOICE_ACCRUAL` leg of 1,000,000 + 150,000 + 27,000 = 1,177,000. `Payment.amount` grows by 177,000 to 1,593,000, `taxAmount` to 243,000, and the legs sum to 416,000 + 1,177,000 = 1,593,000, which the `payment_legs_sum_to_amount` trigger checks at commit. The `OverageEvent` is `PENDING` with `basePaise` 1,000,000, `surchargePaise` 150,000 and `marginalPaise` 1,177,000.

| Journal `booking:<paymentId>` | Dr        | Cr        |
| ----------------------------- | --------- | --------- |
| `ORG_RECEIVABLE(wipro)`       | 1,593,000 |           |
| `PLATFORM_FEE`                |           | 390,000   |
| `CONSULTANT_PAYABLE(grace)`   |           | 960,000   |
| `GST_PAYABLE`                 |           | 243,000   |
| Total                         | 1,593,000 | 1,593,000 |

The platform fee is 240,000 (20 % of the 1,200,000 gross) plus the 150,000 surcharge. Grace is paid on the ₹12,000, not on the marked-up amount.

4. **The 14th booking, same price.** The cycle's overage so far is 1,150,000 (base plus surcharge), and another 1,150,000 would make 2,300,000, over the 2,000,000 ceiling. The breaker returns `BLOCK` whatever the behaviour, checkout throws `PROGRAM_CAP_EXHAUSTED` (402), the transaction rolls back, and no booking, leg or event is written.

## Example 2b: a credit pool straddling its budget (reference sponsor)

Acmeware is the reference sponsor used in the architecture documents; it is not in the seed. It is on the `INVOICE` rail with a `CREDIT_POOL` of 50,000 credits a month (₹50,000, or 5,000,000 paise), `CHARGE_ORG`, a 10 % surcharge (`overageSurchargeBps = 1000`) and a ₹10,000 (1,000,000 paise) per-cycle ceiling. An engineer has consumed 4,900,000 paise this month, so 100,000 paise (₹1,000) of budget remains.

1. The engineer books a ₹5,000 session with Grace Anderson: GST is 90,000, so the price is 590,000.
2. The pool covers 100,000. The rest, 490,000, is the marginal: `basePaise = 490,000`, `surchargePaise = floor(490,000 x 1000 / 10000) = 49,000`, GST on the surcharge 18 % of 49,000 = 8,820, charged 490,000 + 49,000 + 8,820 = 547,820. The overage so far plus this base and surcharge (539,000) is within the 1,000,000 ceiling.
3. Legs: `INVOICE_ACCRUAL` 590,000 - 490,000 = 100,000 and `OVERAGE_INVOICE_ACCRUAL` 547,820, so `Payment.amount` is 647,820 and `taxAmount` 98,820.

| Journal `booking:<paymentId>`                              | Dr      | Cr      |
| ---------------------------------------------------------- | ------- | ------- |
| `ORG_RECEIVABLE(acmeware)`                                 | 647,820 |         |
| `PLATFORM_FEE` (20 % of 500,000 plus the 49,000 surcharge) |         | 149,000 |
| `CONSULTANT_PAYABLE(grace)` (80 % of 500,000)              |         | 400,000 |
| `GST_PAYABLE` (90,000 plus 8,820)                          |         | 98,820  |
| Total                                                      | 647,820 | 647,820 |

## Example 3: the overage reaches the invoice

Continue from Example 2 with that booking as Wipro's only accrual.

1. **Sun 1 Nov 2026, 04:45 UTC.** `settle-invoice-accruals` runs. `rollupOrgInvoiceAccruals` finds the payment with its two legs, writes one line, and builds an invoice with subtotal 1,350,000 (the ₹12,000 booking plus the ₹1,500 surcharge) and GST 243,000 for a total of 1,593,000 (₹15,930), numbered from Wipro's gapless fiscal-year series (`WIPRO-2026-0002` if the October invoice in the [invoices page example](04-invoices-purchase-orders-and-dunning.md) took `-0001`). It stamps `billableToOrgInvoiceId` on the payment, moves the `OverageEvent` from `PENDING` to `ACCRUED`, and issues the invoice with a due date of Thu 31 Dec 2026 (NET-60). It posts nothing at issue, since the booking journal already holds the receivable and the GST.
2. **Wed 16 Dec 2026.** Wipro pays by card on `/pay`. The order is for the outstanding 1,593,000. The capture posts `Dr GATEWAY_CLEARING 1,593,000 / Cr ORG_RECEIVABLE(wipro) 1,593,000` under `invoicepaid:<invoiceId>`, writes the receipt and flips the invoice `PAID` in one transaction, and the `OverageEvent` moves `ACCRUED` to `CHARGED` with `settledAt`. `ORG_RECEIVABLE(wipro)` for this booking is now zero: 1,593,000 debited at booking and credited at payment.

**What if Wipro paid only ₹10,000 by bank transfer?** The receipt posts `Dr CASH 1,000,000 / Cr ORG_RECEIVABLE 1,000,000`, the invoice stays `ISSUED` with 593,000 outstanding, and `/pay` would charge 593,000. A capture of any other amount is parked in `UNAPPLIED_RECEIPTS` for an operator.

## Example 4: a top-up is refunded after the money was spent

Suppose IIT Madras confirmed a ₹5,00,000 top-up (50,000,000 paise), spent most of it on bookings, and its wallet cache now holds exactly 1,000,000 paise (₹10,000) of that credit.

1. **Mon 2 Nov 2026, 12:00.** Razorpay reports a refund of the whole 50,000,000 paise of that top-up (a refund issued at the gateway dashboard).
2. **`bookTopUpRefund` runs.** It posts `topup-refund:<gatewayRefundId>`: `Dr WALLET(iit-madras) 50,000,000 / Cr GATEWAY_CLEARING 50,000,000`.
3. **The wallet floor wins.** The cache can only give back what it holds, so it falls by 1,000,000 to 0, never below, because `billing_account_wallet_nonnegative` would reject a negative balance and the webhook would redeliver forever.
4. **The unrecovered part.** 50,000,000 - 1,000,000 = 49,000,000 paise (₹4,90,000) cannot be clawed back. It posts `topup-refund-shortfall:<gatewayRefundId>`: `Dr ORG_RECEIVABLE(iit-madras) 49,000,000 / Cr WALLET(iit-madras) 49,000,000`, a receivable from the organisation. The net `WALLET` movement is 50,000,000 - 49,000,000 = 1,000,000 debited, which equals the cache decrement, so the nightly audit stays clean.
5. **If the webhook and the admin door both fire,** the second call finds the same `topup-refund:` key already posted and does nothing.

## Which parts depend on configuration

The split in Example 1 depends on `ENABLE_HOST_ORGS` being on, and the rate card shown is the organisation-scoped card because `RATE_CARD_SCOPED_RESOLUTION` is off. The surcharge and ceiling in Example 2 are programme settings that the seed does not set. Everything else on this page is current behaviour on `dev`.

## Where in code

| Step                                  | Code                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Gates, synthetic intent, wallet debit | `lib/payments/checkout/org-funding.ts`, `commit/org-utilization.ts`, `lib/api/organizations/wallet.ts` |
| Split                                 | `lib/payments/payouts/earnings-service.ts` (`resolveOrgSplit`)                                         |
| Overage                               | `lib/payments/billing/overage.ts`, `overage-settlement.ts`                                             |
| Rollup and payment                    | `lib/payments/billing/invoice-rollup.ts`, `org-invoice-settlement.ts`                                  |
| Top-up refund                         | `lib/payments/operations/wallet-refund.ts`                                                             |

## Deprecated & Superseded Approaches

1. **Examples that debit `CASH` at top-up or invoice payment.** Card money lands in `GATEWAY_CLEARING`; only a bank-transfer receipt debits `CASH`.
2. **A fourth booking shown as `OverageEvent(BLOCKED)`.** The circuit breaker throws and rolls back; no event is stored.
3. **Hypothetical fictional organisations in place of the seeded cast.** The seeds in `prisma/seedFiles/14a-create-organizations.ts` are the reference.
