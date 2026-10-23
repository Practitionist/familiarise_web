# Referral Economics, Guards and Owner Decisions

This document explains why each money rule exists, lists every guard and where it lives, and records the owner's decisions that shape current behaviour.

## 1. The one principle

A promotion may never cost more than the platform earns on the order it touches. The marketplace take is 20 % of the list price, so a promotion capped at the take can lower the platform's margin on that order to zero but never below it, apart from the payment gateway's own fee. Every guard below follows from that.

## 2. Programme economics at launch

The default values below sit in `ReferralProgramConfig` and the active fee schedule. Operations can change any of them without a code change.

| Item                                  | Default                                              | Where it is set                            |
| ------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| Marketplace take                      | 20 %                                                 | `PlatformFeeSchedule.marketplaceBps`       |
| Own-link take                         | 10 %                                                 | `PlatformFeeSchedule.ownLinkBps`           |
| Welcome discount                      | 20 % before tax, at most ₹300                        | `discountBps`, `discountMaxPaise`          |
| Referrer credit                       | ₹300                                                 | `referrerRewardPaise`                      |
| Credit redemption cap                 | 20 % of list price, and never above the order's take | `redemptionCapBps`                         |
| Minimum cash paid                     | ₹500                                                 | `minOrderPaise`                            |
| Credit validity after vest            | 90 days                                              | `creditExpiryDays`                         |
| Qualify window and attribution window | 30 days                                              | `qualifyWindowDays`, cookie age            |
| Expert waiver                         | 3 sessions, 90 days, both sides                      | `expertWaiverSessions`, `expertWaiverDays` |

A worked example makes the discount concrete. At a list price of ₹1,500 the welcome discount is 20 %, which is ₹300, so the buyer's taxable amount is ₹1,200 and GST at 18 % makes the total ₹1,416. The expert still receives ₹1,200, which is 80 % of the list price. The platform margin on that order is ₹0 before gateway costs. A ₹500 order receives a ₹100 discount, not a flat ₹300.

An own-link order has only a 10 % take. Because promotion is capped at the take, credit redemption on such an order is limited to 10 %, and a consumer-referral discount does not apply at all, since the source of an own-link order is never `CONSUMER_REFERRAL`.

## 3. Guards

Each guard below is a rule the code enforces. The right column says where, so that nobody re-implements it elsewhere.

| Guard                                                                                                         | Where it is enforced                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| The welcome discount is `min(round(list × bps / 10 000), maxPaise, list)` and is taken before tax.            | `computeWelcomeDiscountPaise` in `lib/referrals/promo-math.ts`, called from `deriveCheckoutAmount`.                                  |
| The welcome rate cannot exceed the order's take: `min(discountBps, platformFeeBps)`.                          | `resolveCheckoutAttribution`.                                                                                                        |
| The discount is dropped when cash paid after discount and credits falls under the minimum order.              | `keepsWelcomeDiscount`. The capture step checks the same floor again before qualifying the referral.                                 |
| The discount is never combined with a discount code.                                                          | `hasDiscountCode` in `resolveCheckoutAttribution`, and `deriveCheckoutAmount` ignores the welcome discount when a code is set.       |
| A buyer has at most one live welcome-discounted order.                                                        | The partial unique index `Payment_live_welcome_discount_user_key`, which surfaces as 409 `WELCOME_DISCOUNT_IN_USE`.                  |
| Credit redemption needs a tax-inclusive total of at least ₹500.                                               | `MIN_CREDIT_REDEMPTION_PAISE` and `isCreditRedemptionEligible`.                                                                      |
| Redemption is at most `min(config cap, the order's take)`, less any welcome discount already given.           | `creditCapPaise` with `creditCapBps` from `resolveCheckoutAttribution`.                                                              |
| Promotion is never combined with an expert fee waiver, in either direction.                                   | `takeCannotFundPromo` (no discount, cap 0) and `consumeFeeWaiver` (refuses a payment that carries promotion).                        |
| Host-organisation sellers receive no promotion.                                                               | `takeCannotFundPromo`, when the host-organisation feature is on and the expert is an active member of an organisation that can host. |
| Organisation-funded orders (wallet, invoice, licence) are never consumer referrals.                           | `orgFunded` in `resolveSource`, and capture requires a gateway cash leg.                                                             |
| A zero-value, credit-only or organisation-funded sale never creates a customer relationship.                  | `recordReferralCapture`, which requires a positive cash leg.                                                                         |
| Referrer, referee and seller must be different people.                                                        | Apply refuses your own code, attribution refuses the expert being the referrer, and vest voids `SELF_DEALING`.                       |
| Referees must be new: account created inside the window, no earlier succeeded payment, one referral per user. | `applyReferralCode`, backed by the unique constraint on `Referral.referredUserId`.                                                   |
| Rewards vest only after delivery, the hold period and a clean refund and dispute record.                      | `deliveryState` and the `vestableWhere` predicates repeated inside the vest update.                                                  |
| The monthly budget cannot be overrun by a vest.                                                               | `claimBudget`, a conditional update on the configuration version, spend and period.                                                  |
| New referees pause at 90 % of the month's budget.                                                             | `acceptsNewReferees`.                                                                                                                |
| Per-code lifetime, yearly and weekly caps, and the expert-yearly cap.                                         | One conditional update on the `ReferralCode` counters, in `vestConsumerReferral` and `vestExpertReferral`.                           |
| Expert referrals need a PAN and a verified default payout account.                                            | `vestExpertReferral`.                                                                                                                |
| A configuration or schedule edit never rewrites history.                                                      | Each referral and credit stores `configVersion`, and each payment stores the `platformFeeBps` it was charged.                        |

The weekly cap defers a vest to a later week instead of voiding it. The lifetime and yearly caps void it, because waiting would not help.

## 4. Take rate and fee schedule

The take rates live in `PlatformFeeSchedule`, a versioned and approved table. Each row has an effective time. The active schedule is the approved row with the latest `effectiveFrom` that has already passed. The database requires the own-link rate not to exceed the marketplace rate, and requires a maker and checker.

Changing a rate is a two-person act because it reprices every later sale. The ADMIN who proposes a schedule cannot approve it while another ADMIN exists. While exactly one ADMIN exists, that person may approve their own proposal at least 24 hours after proposing it, with a reason, so a sole operator is not locked out and still has a cooling-off period. The 24-hour bound is checked by the database as well as by the route.

Expert waivers and own-link rates change only how a sale is split between the expert and the platform. GST remains on the full price and the withholding base for marketplace operators remains the gross amount.

## 5. Owner decisions of 2026-10-05

These two decisions describe how a refunded first booking is treated. They are stated here as current behaviour.

### The welcome discount after a refund

The welcome discount comes back only when the expert or the platform caused the refund of the buyer's first booking. In that case the referral returns to `SIGNED_UP` inside its original window, the first order stops counting as a purchase, the discounted order releases its place in the one-live-order index, and the buyer's relationship row with that expert is removed. The referrer's pending credit is voided.

When the buyer cancelled, the referral becomes `VOID` with reason `REFUNDED`, the discount is not returned, and the referrer's pending credit is voided as well. A refund whose initiator was never recorded counts as a buyer cancellation.

### The value of a restored credit

When a refund caused by the expert or the platform restores credit that an order had used, the restored credit is valid for at least 30 more days. When the buyer cancelled, the credit keeps its original expiry, and a credit that has already expired is lost.

This rule is being implemented alongside this documentation. At the head of this branch the restore code skips an already-expired credit in every case and never extends an expiry.

## 6. Owner decisions of 2026-10-04

These earlier decisions remain in force.

- The referee receives an instant discount before tax and no cash. The referrer receives a promotional credit after the friend's first completed session.
- The first paid purchase with an expert fixes the source for every later purchase with that expert.
- The credit redemption cap starts at 20 % of an order and may not exceed the order's take.
- Expert to expert is a platform-fee waiver for 3 delivered sessions on both sides for 90 days, with no cash reward.
- Rewards are promotional credit for buyers and fee waivers for experts. There are no cash rewards, no contests and no organisation referrals at launch.

## 7. Switching the programme on

The programme stays off until all three actions below are done. They are owner actions and need no code change.

1. Set `monthlyBudgetPaise` with `PATCH /api/admin/referrals/config`, including a reason. For scale, a budget of ₹30,000 covers about 60 fully loaded consumer referrals, and each expert referral is charged ₹1,800 at vest.
2. Approve the launch fee schedule, called `fee-schedule-launch`, with `POST /api/admin/fee-schedules/[scheduleId]/approve`. Without an approved schedule, both rails use the marketplace rate, so an expert's own-link sale is charged the 20 % take instead of 10 %.
3. Add the `CRON_SECRET` secret to the GitHub repository so the monthly `expire-referral-credits` workflow can call its endpoint.

## 8. Not built yet

The following parts of the design are not in the code and are planned together as the second part of the referral work.

- A risk score computed at qualification from shared payment instrument, shared session address, account age and cycles in the referral graph, with a review queue that holds a referral before vest.
- Normalising email aliases and blocking disposable domains.
- A clawback that debits a referrer's remaining credit when a chargeback lands after the credit has vested.
- Ops console reports for referrals by state, void rate by reason, budget burn, liability and breakage.
- Novu notification families for applied, vested, voided and expiring-soon referrals.

Several smaller gaps between the design and the code are worth knowing.

- The design drops `Referral.organizationId`, the unused status values and the unused code columns. They are still in the schema.
- The design lets `ReferralCode.isActive` be switched off by a void cascade. No code writes it yet, so a code can be deactivated only by editing the row.
- The design says referees who already hold a discounted order are honoured at 90 % of the budget. The code honours only orders already minted.
- The design shows `EXPIRED` as a stored referral status. The code reports it only when the referral is read.

## Deprecated & Superseded Approaches

The role-weighted plan recorded on 2026-06-17 proposed ₹500 and ₹300 referrer credits, a ₹300 booking credit for the referee, and a 0 % commission for new experts for three sessions plus an optional ₹200 cash reward. It also proposed paying more for a consumer referee than for an expert referee. The delivered design replaced booking credit for the referee with a pre-tax discount, replaced the cash reward with a fee waiver only, made the amounts configuration, and tied every promotion to the order's take.

Residual artifacts to delete when found:

- Any hard-coded `₹300` or `₹500` reward constant outside `ReferralProgramConfig` defaults.
- Any code that gives a referee a spendable credit instead of a discount.
- Any cash reward path for referrals. Cash rewards would need PAN collection and withholding, and none exists.
- A fee-rate constant used for a sale instead of the stamped `platformFeeBps`. The constant is only the fallback when no schedule is approved.
