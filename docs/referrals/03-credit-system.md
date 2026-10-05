# Referral Credits and the Ledger

A referral credit is a promotional balance in rupees that the platform grants to a referrer. It is not cash, cannot be withdrawn or transferred, and can only reduce what the holder pays on a later order. All amounts are in paise.

## 1. Credit sources

The `source` column records how a credit came to exist. Only the first one is created by the referral programme itself.

| Source                       | Created by                                           | Notes                                                                                          |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `REFERRAL_BONUS`             | Capture of the referee's first paid booking          | Starts `PENDING` at the configured reward, becomes spendable only when it vests.               |
| `COMPENSATION`               | An admin through `POST /api/admin/referrals/credits` | Issued spendable and already counted in the liability.                                         |
| `MANUAL`                     | An admin through the same route                      | Same as above, with an optional expiry.                                                        |
| `REFEREE_BONUS`, `PROMOTION` | Nothing at present                                   | Kept as enum values and in the admin filter. The referee's reward is a discount, not a credit. |

The pair `(userId, referralId, source)` is unique, so a referral can produce at most one `REFERRAL_BONUS` credit for the referrer.

## 2. Credit lifecycle

A `ReferralCredit` carries an explicit `state`. Only `VESTED` credits with a balance and an unexpired `expiresAt` are spendable.

```
   capture of the friend's first paid booking
              │
              ▼
        ┌─────────┐   vest sweep: delivered, held,    ┌────────┐   expiry passes,     ┌─────────┐
        │ PENDING │ ────────────────────────────────► │ VESTED │ ──────────────────►  │ EXPIRED │
        └─────────┘   no refund, caps and budget ok   └────────┘   breakage posted    └─────────┘
              │                                           │
              │ referral voided, or reopened               │ ops reversal
              ▼                                           ▼
          ┌──────┐                                    ┌──────┐
          │ VOID │ ◄───────────────────────────────── │ VOID │
          └──────┘                                    └──────┘
```

A `PENDING` credit holds nothing in the ledger. A `VOID` credit that was never vested can be revived to `PENDING` when the same referral is reopened and later qualifies again. The revival only applies to a credit that never vested, was never reversed and was never used.

Two database checks protect the balance. `referral_credit_balance_consistent` requires `remainingAmount = amount - usedAmount` with all three non-negative, and `referral_credit_usage_nonnegative` keeps every usage amount non-negative.

## 3. Redeeming a credit at checkout

The buyer opts in by sending `useReferralCredits` with the order. `deriveCheckoutAmount` computes the price in one fixed order: the list price, then any discount code, then the welcome discount, then GST on the discounted amount, then credits against the tax-inclusive total.

Credits are applied only when all of these hold.

- The tax-inclusive total is at least ₹500 (`MIN_CREDIT_REDEMPTION_PAISE`).
- The buyer's balance of spendable credits is greater than 0.
- The amount is the smallest of the balance, the tax-inclusive total, and the credit cap. The credit cap is `floor(list price × creditCapBps / 10 000)` minus the welcome discount already given. `creditCapBps` is the smaller of the configured redemption cap (20 % by default) and the order's take rate, so an own-link order at a 10 % take allows at most 10 %.

`applyCreditsToPayment` then draws from credits that expire soonest first. Each draw is a conditional update that requires the credit to still be `VESTED`, to hold at least the draw amount and to be unexpired. If a credit changed in the meantime, checkout fails with the typed 409 `CREDIT_SHORTFALL` and re-prices. Each draw writes a `ReferralCreditUsage` row, and one `REFERRAL_CREDIT` payment leg records the total, with `sourceRef` pointing at the first usage row. The leg is excluded from the funding-leg sum, because `Payment.amount` already excludes the credit.

## 4. The ledger

Every movement of a vested balance is a balanced two-line entry of kind `REFERRAL_CREDIT`, and each carries an idempotency key so a retry cannot post twice.

| Event                       | Debit                       | Credit                      | Idempotency key                               |
| --------------------------- | --------------------------- | --------------------------- | --------------------------------------------- |
| Vest                        | `PLATFORM_PROMO`            | `REFERRAL_CREDIT_LIABILITY` | `referral-vest:<creditId>`                    |
| Redemption draw             | `REFERRAL_CREDIT_LIABILITY` | `PLATFORM_PROMO`            | `referral-redeem:<usageId>`                   |
| Restore after a refund      | `PLATFORM_PROMO`            | `REFERRAL_CREDIT_LIABILITY` | `referral-restore:<usageId>:<restored total>` |
| Breakage at expiry          | `REFERRAL_CREDIT_LIABILITY` | `PLATFORM_PROMO`            | `referral-breakage:<creditId>`                |
| Ops reversal of a balance   | `REFERRAL_CREDIT_LIABILITY` | `PLATFORM_PROMO`            | `referral-reverse:<creditId>`                 |
| Ops issuance (admin credit) | `PLATFORM_PROMO`            | `REFERRAL_CREDIT_LIABILITY` | `referral-issue:<creditId>`                   |

In plain words, the platform records the cost of a reward when the credit becomes spendable, and it owes the holder that amount until they use it. Using it pays down the debt, and an expired balance is released back as breakage. Draws, restores and breakage post only when the credit's `vestedAt` is set, which means the vest journal posted the liability.

The welcome discount has no ledger line of its own. It is an invoice discount before tax, so it lowers revenue at the sale, and the order's take funds it.

### The reconciler invariant

The ledger reconciler step `stepReferralCreditLiability` in `scripts/reconcile/reconcile-ledgers.ts` asserts that the liability account's credits minus its debits equals the sum of `remainingAmount` over credits that are `VESTED` and have `vestedAt` set. A mismatch is reported as `REFERRAL_CREDIT_LIABILITY_DRIFT`. This check spans the credit table and the ledger, which no single Postgres constraint can, so the reconciler is the right place for it.

## 5. Refunds and restoring credits

When a payment that used credits is refunded or cancelled, `reverseCreditsForPayment` returns the credit value through the `ReferralCreditUsage` rows. A full refund restores everything. A partial refund restores in proportion to the cumulative refunded amount, so rounding never drifts across several partial refunds. Credit-funded class seats, whose refund rows are for ₹0, use `restoreCreditsForPaymentUpTo`, which restores up to a stated amount and keeps the usage row at 0 so later returns have a stable basis.

The rules for what a restore is worth depend on who caused the refund.

- If the expert or the platform caused the refund, the restored credit is valid for at least 30 more days, even when its original expiry has passed in the meantime.
- If the buyer cancelled, the credit keeps its original expiry. When that expiry has already passed, the credit is lost.

These two rules are the owner's decision of 2026-10-05 and are being implemented in parallel. At the head of this branch the restore functions still skip a credit whose expiry has already passed and never extend an expiry, so the 30-day floor is not yet in the code.

## 6. Expiry and breakage

A credit expires `creditExpiryDays` after it vests (90 days by default). The expiry date matters in two places. Spending ignores credits past their date immediately. The monthly `expire-referral-credits` job later moves them to `EXPIRED` by a conditional update that checks the balance has not changed, and posts the breakage entry for the unused remainder. A credit with a zero balance expires without posting anything.

## 7. What the user sees

`GET /api/referrals/credits` returns the spendable total and the full history. `GET /api/referrals/credits/available` returns only the total. Spendable credits are those in `VESTED` with a positive balance, in INR, and not expired. The admin list in `GET /api/admin/referrals/credits` derives a filter status of `PENDING`, `ACTIVE`, `EXHAUSTED`, `EXPIRED` or `REVERSED` from the state and balance.

## Deprecated & Superseded Approaches

The first version gave a credit its full value at the moment of capture and had no `state` column. A credit was "active" when it had a balance and an unexpired date, expiry was only a filter at read time, and a nightly script that zeroed old balances was planned but later deleted. Nothing was posted to the ledger when a credit was issued, so cost appeared only at redemption through `PLATFORM_PROMO`, and there was no liability and no breakage.

Residual artifacts to delete when found:

- Any code that infers status from `remainingAmount` and `usedAt` instead of `state`.
- A `usedOnPaymentId` field on credits. Usage is tracked by `ReferralCreditUsage`.
- Any expectation that a refund deletes usage rows after a partial restore. Partial restores reduce the row and record `restoredAmount`.
- The 6-month expiry, the ₹500 and ₹200 amounts, and the flat FIFO example from the earlier credit guide.
