# ADR: An approved request's unpaid order returns what its checkout consumed

- **Status**: Accepted by the owner on 2026-11-20. Ships in the pull request that adds this record.
- **Date**: 2026-11-20
- **Author**: Platform engineering
- **Related**: [Approval payments](../finance/10-money-in/05-approval-payments.md#3-time-and-expiry), [Checkout and pricing](../finance/10-money-in/01-checkout-and-pricing.md), [Referral credits](../finance/20-ledger/07-referral-credits.md)

## Context

A checkout consumes three things when it mints an order: the buyer's referral credit, one use of a discount code, and one engagement of an organisation programme. Every exit from `PENDING` that is not a payment gives all three back, through `expirePendingPaymentsInTx` (`lib/booking/pending-payment-expiry.ts`) or the same three helpers called directly: `reverseCreditsForPayment`, `returnDiscountUse` and `reverseBookingUtilization`. Two paths of an approved, still-unpaid request did not.

- **The lapse.** `lapseApprovedRequest` (`lib/booking/lapse-approved-request.ts`) ends an approved request that was not paid. Four callers use it: the pay-link sweep (`cleanupExpiredApprovalPendingPayments`), the seven-day backstop in `expire-stale-requests` (one pass for consultations, one for subscriptions), the consultant's Withdraw, and the too-close lapse that runs when an approval's pay window can no longer open (`lapseTooCloseApproval`). It moved the open order to `EXPIRED` with a plain update and gave nothing back.
- **The re-mint.** When an approval finds a live order whose figures differ from the approval price, `createApprovalPaymentIntent` re-mints into the same row (`claimRowForRemint`) and keeps the old gateway order on an `EXPIRED`, appointment-less tombstone (`tombstonePriorIntent`). The tombstone took the old order's referral-credit usages with it. Nothing returned them unless a late capture on the old order was refunded.

Both cases arise when a direct-checkout request that used credit is approved while its checkout order is still open. That order is net of the credit, so its amount never matches the approval price.

## Worked example

Charlotte Brown books a ₹1,000.00 (100,000 paise) consultation. She applies ₹200.00 (20,000 paise) of referral credit and a 10% code, and her organisation's seat counts one engagement. She does not finish paying, and the expert approves the request.

- **Re-mint.** The approval re-mints her order at the full ₹1,000.00, because no credit or code rides a pay link. Before, the ₹200.00 stayed spent on the tombstone. Now it is back in her balance in the re-mint's own transaction, with its original expiry.
- **Lapse.** She does not pay the link, and the sweep lapses the request. Before, her code use and her seat's engagement stayed counted. Now the lapse returns the code use (the code's `currentUses` drops by one) and the engagement (her seat's `engagementsUsed` drops by one). Had the lapse come first, without a re-mint, it would also have returned the ₹200.00.
- **Late capture.** Had she paid the old order after the re-mint, the capture lands on the tombstone and is refunded in full. That refund finds no credit usage left, so the ₹200.00 is not returned a second time.

## Decisions

1. **The lapse goes through the shared unpaid exit.** After the request's compare-and-swap wins, `lapseApprovedRequest` calls `expirePendingPaymentsInTx(tx, { appointmentId, reason })`. That function claims each `PENDING` order with its own compare-and-swap (`updateMany` on `id` and `paymentStatus: PENDING`, count checked). For each order it moved, it returns the credit, the code use and the engagement, all in the lapse's transaction. An order that was captured, is already `EXPIRED`, or belongs to a request whose compare-and-swap lost returns nothing. The engagement row records the reason (`LAPSE_NOTE`).
2. **The lapse calls no gateway.** The gateway cancels that `expirePendingPaymentsInTx` returns are not run, as on the decline path. A Razorpay "cancel" only reads the order, and a capture that lands on the `EXPIRED` row is refunded.
3. **A re-mint returns the old order's credit at once.** In `claimRowForRemint`, once the row's compare-and-swap has matched exactly one row, `reverseCreditsForPayment(existing.id, tx)` runs in the same transaction, before the tombstone is written. The tombstone then has no usage left to take. Keeping the usage on the live order would be wrong, because that order charges the full price and does not use the credit. Moving it to the tombstone strands it.
4. **Credit comes back once.** A lapse or re-mint that loses its compare-and-swap writes nothing. A full restore deletes the usage row, so the refund of a late capture on either the expired order or the tombstone restores nothing more.
5. **The buyer's rules for expired credit apply.** No refund row is passed, so a credit that expired in the meantime stays spent, and a live one keeps its original expiry. This also holds for the consultant's Withdraw.
6. **No backfill.** This applies from this release on. Orders that lapsed or were re-minted earlier keep what they consumed; nothing restores it.

## Consequences

- The lapse reads each open order once before claiming it, and adds the give-back reads and writes that every other unpaid exit already makes.
- `lib/booking/lapse-approved-request.ts` now imports `lib/booking/pending-payment-expiry.ts`, which imports `scripts/payments/cleanup-abandoned-payments.ts`, which imports the lapse module. The cycle is safe because none of the three calls another at module load.
- A re-minted order keeps the old checkout's `discountCodeId` while charging the full price. If the new order is paid, that code use stays counted although no discount was given. If it lapses, decision 1 returns the use. This record does not change the paid case.

## Deprecated & Superseded Approaches

- **The lapse expired the open order with its own `updateMany`.** It first returned nothing, then only the referral credit (one `updateManyAndReturn` and a `reverseCreditsForPayment` loop). Both are replaced by decision 1.
- **The re-mint tombstone kept the old order's credit usages.** Replaced by decision 3. `tombstonePriorIntent` still moves any usage left on the row, and on an approval re-mint none is left.
