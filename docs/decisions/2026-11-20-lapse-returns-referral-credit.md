# ADR: An approved request that lapses unpaid returns the referral credit its order used

- **Status**: Accepted by the owner on 2026-11-20. Ships in the pull request that adds this record.
- **Date**: 2026-11-20
- **Author**: Platform engineering
- **Related**: [Approval payments](../finance/10-money-in/05-approval-payments.md#3-time-and-expiry), [Referral credits](../finance/20-ledger/07-referral-credits.md)

## Context

An approved request that is still unpaid ends through one function, `lapseApprovedRequest` (`lib/booking/lapse-approved-request.ts`). Four callers use it: the pay-link sweep (`cleanupExpiredApprovalPendingPayments`), the seven-day backstop in `expire-stale-requests` (one pass for consultations, one for subscriptions), the consultant's Withdraw, and the too-close lapse that runs when an approval's pay window can no longer open (`lapseTooCloseApproval`). The function moves the request's open order from `PENDING` to `EXPIRED`.

Every other unpaid exit from `PENDING` (the buyer's cancel, the abandoned-payments sweep, a payment failure, the reconcile, a decline) also returns the referral credit the order used, through `reverseCreditsForPayment` (`lib/referrals/service.ts`). The lapse did not. A buyer whose checkout order carried referral credit lost that credit when the request it belonged to lapsed. One way this happens: a direct-checkout request is approved while its checkout order is still open, and the session is too close for a new pay window. The order is never re-minted, and the too-close lapse expires it with the credit still spent.

## Worked example

Charlotte Brown books a ₹800.00 (80,000 paise) consultation and applies ₹200.00 (20,000 paise) of referral credit, so her order is for ₹600.00. She does not finish paying. The expert approves the request 40 minutes before the session starts. That is too close to open a pay window, so the approval lapses at once.

- Before: the order moved to `EXPIRED` and her credit stayed spent. Her balance showed ₹0.00 of the ₹200.00.
- Now: the same transaction that moves the order to `EXPIRED` gives the ₹200.00 back. Her balance shows ₹200.00 again, with the credit's original expiry date.

## Decisions

1. **The lapse returns the credit.** Inside its transaction, `lapseApprovedRequest` claims the request's open orders with one conditional update (`updateManyAndReturn` with `paymentStatus: PENDING` in the `WHERE`). It then calls `reverseCreditsForPayment(paymentId, tx)` for each order that update moved. Nothing else returns credit on this path.
2. **The credit comes back once.** An order that was captured, or is already `EXPIRED`, is not in the update's result, so its credit is not touched. A second lapse of the same request loses the request's compare-and-swap and writes nothing. A capture that lands on the expired order later is refunded through the booking refund door, and that refund finds no usage row left to restore.
3. **The buyer's rules for expired credit apply.** The lapse passes no refund row, so `reverseCreditsForPayment` treats it like a buyer cancel. A credit that has expired in the meantime stays spent, and a live one keeps its original expiry. This holds for the consultant's Withdraw too.
4. **No backfill.** The change applies to lapses from this release on. Orders that lapsed earlier keep their credit spent; nothing in the code or the database restores them.

## Consequences

- The lapse adds one statement per claimed order that used credit (the usage read), plus the restore writes and the ledger posting `reverseCreditsForPayment` already makes on every other path. An order with no credit adds one read.
- The lapse still does not return a discount-code use or an organisation's programme engagement (`returnDiscountUse`, `reverseBookingUtilization`), which `expirePendingPaymentsInTx` returns on the other unpaid exits. Whether it should is a separate decision.
- A re-minted approval order moves its credit usages to the `EXPIRED` tombstone that keeps the old gateway order (`tombstonePriorIntent`). That credit is returned only if a late capture on the old order is refunded. This record does not change it.

## Deprecated & Superseded Approaches

- **The lapse expired the order with a plain `updateMany`** and left its referral credit spent. Replaced by decision 1. Any test or doc that says the lapse moves no money, or that it expires the order without touching credit, is out of date.
