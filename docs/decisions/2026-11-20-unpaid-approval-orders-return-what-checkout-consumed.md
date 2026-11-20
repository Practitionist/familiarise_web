# ADR: An approved request's unpaid order returns what its checkout consumed

- **Status**: Accepted by the owner on 2026-11-20. Ships in the pull request that adds this record.
- **Date**: 2026-11-20
- **Author**: Platform engineering
- **Related**: [Approval payments](../finance/10-money-in/05-approval-payments.md#3-time-and-expiry), [Checkout and pricing](../finance/10-money-in/01-checkout-and-pricing.md), [Referral credits](../finance/20-ledger/07-referral-credits.md)

## Context

A checkout consumes three things when it mints an order: the buyer's referral credit, one use of a discount code, and one engagement of an organisation programme. Every exit from `PENDING` that is not a payment gives all three back, through `expirePendingPaymentsInTx` (`lib/booking/pending-payment-expiry.ts`) or the same three helpers called directly: `reverseCreditsForPayment`, `returnDiscountUse` and `reverseBookingUtilization`. Two paths of an approved, still-unpaid request did not.

- **The lapse.** `lapseApprovedRequest` (`lib/booking/lapse-approved-request.ts`) ends an approved request that was not paid. Four callers use it: the pay-link sweep (`cleanupExpiredApprovalPendingPayments`), the seven-day backstop in `expire-stale-requests` (one pass for consultations, one for subscriptions), the consultant's Withdraw, and the too-close lapse that runs when an approval's pay window can no longer open (`lapseTooCloseApproval`). It moved the open order to `EXPIRED` with a plain update and gave nothing back.
- **The re-mint.** When an approval finds a live order whose figures differ from the approval price, `createApprovalPaymentIntent` re-mints into the same row (`claimRowForRemint`) and keeps the old gateway order on an `EXPIRED`, appointment-less tombstone (`tombstonePriorIntent`). The tombstone took the old order's referral-credit usages with it, and nothing returned them unless a late capture on the old order was refunded. The row also kept the checkout's `discountCodeId`, so the code's use stayed counted although the new price applies no code. It also kept the checkout's `welcomeDiscountPaise`, so the full-price order held the buyer's one live welcome-order slot, and at capture it would meter a welcome discount nobody got.

Both cases arise when a direct-checkout request that used credit is approved while its checkout order is still open. That order is net of the credit, so its amount never matches the approval price.

## Worked example

Charlotte Brown books a ₹1,000.00 (100,000 paise) consultation. She applies ₹200.00 (20,000 paise) of referral credit and a 10% code, and her organisation's seat counts one engagement. She does not finish paying, and the expert approves the request.

- **Re-mint.** The approval re-mints her order at the full ₹1,000.00, because no credit or code rides a pay link (`priceWithTax` passes neither to `deriveCheckoutAmount`). Before, the ₹200.00 stayed spent on the tombstone and the code's use stayed counted. Now, in the re-mint's own transaction, the ₹200.00 is back in her balance with its original expiry, the code's `currentUses` drops by one and the code is removed from her order. Had she been a referee whose order carried a welcome discount instead of the code, the field would be cleared too.
- **Lapse.** She does not pay the link, and the sweep lapses the request. Before, her seat's engagement stayed counted (and, without a re-mint, her code use and her credit). Now the lapse returns whatever the order still holds: here the engagement, because the re-mint already returned the credit and the code use.
- **Late capture.** Had she paid the old order after the re-mint, the capture lands on the tombstone and is refunded in full. The tombstone has no credit usage and no code, so nothing is returned a second time.

## Decisions

1. **The lapse goes through the shared unpaid exit.** After the request's compare-and-swap wins, `lapseApprovedRequest` calls `expirePendingPaymentsInTx(tx, { appointmentId, reason })`. That function claims each `PENDING` order with its own compare-and-swap (`updateMany` on `id` and `paymentStatus: PENDING`, count checked). For each order it moved, it returns the credit, the code use and the engagement, all in the lapse's transaction. An order that was captured, is already `EXPIRED`, or belongs to a request whose compare-and-swap lost returns nothing. The engagement row records the reason (`LAPSE_NOTE`).
2. **The lapse calls no gateway.** The gateway cancels that `expirePendingPaymentsInTx` returns are not run, as on the decline path. A Razorpay "cancel" only reads the order, and a capture that lands on the `EXPIRED` row is refunded.
3. **A re-mint returns the old order's credit and code use at once.** In `claimRowForRemint` the compare-and-swap also carries the row's `discountCodeId` in its `WHERE`. Once it has matched exactly one row, the same transaction runs `reverseCreditsForPayment(existing.id, tx)`. If the row carried a code, it then runs `returnDiscountUse(tx, existing.id)` when the replaced order was still `PENDING`, and clears `discountCodeId` with a conditional update on the new pre-mint intent (count checked). An `EXPIRED` or `FAILED` row being re-minted gave its use back when it ended, so its code is cleared without a second return. The compare-and-swap's own `data` also sets `welcomeDiscountPaise` to null, for live and dead rows alike. All of this runs before the tombstone is written. Keeping the credit or the code on the live order would be wrong, because that order charges the full price and uses neither, and moving them to the tombstone strands them.
4. **The welcome discount is cleared, not returned.** A referee's welcome discount is computed at checkout (`resolveCheckoutAttribution` in `lib/referrals/attribution.ts`) and stored only as `Payment.welcomeDiscountPaise`; checkout decrements nothing. The programme budget is metered at capture, from the captured row's field (`recordReferralCapture` in `lib/referrals/capture.ts`). The only thing an unpaid order holds is the buyer's one live welcome-order slot, the partial unique index `Payment_live_welcome_discount_user_key` on a non-null field of a `PENDING` or `SUCCEEDED` row. So the re-mint has nothing to return. Clearing the field frees the slot, keeps the capture from metering a discount that was not given, and lets the fee waiver apply (`carriesPromo` in `lib/payments/pricing/platform-fee.ts`). A dead row re-minted to `PENDING` with the field still set would also collide with any other live welcome order of the buyer. The tombstone is written without the field, so a late capture on it holds no slot and meters nothing.
5. **Each give-back happens once.** A lapse or re-mint that loses its compare-and-swap writes nothing. A full credit restore deletes the usage row, and a re-mint clears the code from the row, so a later lapse or the refund of a late capture on either row returns nothing more.
6. **The buyer's rules for expired credit apply.** No refund row is passed, so a credit that expired in the meantime stays spent, and a live one keeps its original expiry. This also holds for the consultant's Withdraw.
7. **No backfill.** This applies from this release on. Orders that lapsed or were re-minted earlier keep what they consumed; nothing restores it.

## Consequences

- The lapse reads each open order once before claiming it, and adds the give-back reads and writes that every other unpaid exit already makes.
- `lib/booking/lapse-approved-request.ts` now imports `lib/booking/pending-payment-expiry.ts`, which imports `scripts/payments/cleanup-abandoned-payments.ts`, which imports the lapse module. The cycle is safe because none of the three calls another at module load.
- A re-minted order keeps its referral attribution (`attributionSource`, `attributionReferralId`), so paying it still counts as the referee's first purchase, without a welcome discount.

## Deprecated & Superseded Approaches

- **The lapse expired the open order with its own `updateMany`.** It first returned nothing, then only the referral credit (one `updateManyAndReturn` and a `reverseCreditsForPayment` loop). Both are replaced by decision 1.
- **The re-mint tombstone kept the old order's credit usages, and the live row kept its discount code and welcome discount.** Replaced by decisions 3 and 4. `tombstonePriorIntent` still moves any usage left on the row, and on an approval re-mint none is left.
