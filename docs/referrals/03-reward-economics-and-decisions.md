# Referral Economics, Guards and Owner Decisions

This document explains why each money rule exists, lists every guard and where it lives, and records the owner's decisions that shape current behaviour.

## 1. The one principle

A promotion may never cost more than the platform earns on the order it touches. The marketplace take is 20 % of the list price, so a promotion capped at the take can lower the platform's margin on that order to zero but never below it, apart from the payment gateway's own fee. Every guard below follows from that.

## 2. Programme economics at launch

The default values below sit in `ReferralProgramConfig` and the active fee schedule. Operations can change any of them without a code change. The launch budget (`monthlyBudgetPaise`) and the review-hold thresholds (`holdSameIpReferrals`, `holdSameDeviceReferrals`, `holdWindowDays`) are owner-set values kept in Notion (Familiarise / Growth & Marketing), not in this repository.

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
| A referee cannot use the referrer's own mailbox or a disposable-mail domain.                                  | `normaliseEmail` and `isDisposableEmail` in `lib/referrals/email-signals.ts`, called from `applyReferralCode`.                       |
| A friend who paid with the referrer's UPI address or phone does not vest a reward.                            | `paidWithReferrerInstrument` in `settleQualifyingReferral`, voiding with `SHARED_PAYER`.                                             |
| Referrals whose request signals recur across one code wait for a person before they vest.                     | `reviewHoldReason` and `holdReferral` in `lib/referrals/vesting.ts`; the decisions in `lib/referrals/review.ts`.                     |
| A lost chargeback after vest takes back the unspent credit.                                                   | `voidVestedReferralRewards` in `lib/referrals/credit-reversal.ts`, called from `settleLostDispute`.                                  |
| A configuration or schedule edit never rewrites history.                                                      | Each referral and credit stores `configVersion`, and each payment stores the `platformFeeBps` it was charged.                        |

The weekly cap defers a vest to a later week instead of voiding it. The lifetime and yearly caps void it, because waiting would not help.

## 4. Take rate and fee schedule

The take rates live in `PlatformFeeSchedule`, a versioned and approved table. Each row has an effective time. The active schedule is the approved row with the latest `effectiveFrom` that has already passed. The database requires the own-link rate not to exceed the marketplace rate, and requires a maker and checker.

Changing a rate is a two-person act because it reprices every later sale. The ADMIN who proposes a schedule cannot approve it while another ADMIN exists. While exactly one ADMIN exists, that person may approve their own proposal at least 24 hours after proposing it, with a reason, so a sole operator is not locked out and still has a cooling-off period. The 24-hour bound is checked by the database as well as by the route.

Expert waivers and own-link rates change only how a sale is split between the expert and the platform. GST remains on the full price and the withholding base for marketplace operators remains the gross amount.

## 5. Owner decisions of 2026-11-08

Two decisions hardened learner referral before it goes live.

- Cheap fraud controls come first: email aliases are normalised and disposable domains refused at apply, a vest is voided when the friend and the referrer paid with the same UPI address or phone, the IP hash and user agent are stored on the referral, suspicious vests wait in a "held for review" state with an admin queue, and the code-customise and expert-link routes are rate limited. No paid device-fingerprinting vendor is added until abuse appears.
- A lost chargeback after vest voids what is left of the referrer's credit through the existing reversal posting, and the platform absorbs any part already spent.

## 6. Owner decisions of 2026-10-05

These two decisions describe how a refunded first booking is treated. They are stated here as current behaviour.

### The welcome discount after a refund

The welcome discount comes back only when the expert or the platform caused the refund of the buyer's first booking. In that case the referral returns to `SIGNED_UP` inside its original window, the first order stops counting as a purchase, the discounted order releases its place in the one-live-order index, and the buyer's relationship row with that expert is removed. The referrer's pending credit is voided.

When the buyer cancelled, the referral becomes `VOID` with reason `REFUNDED`, the discount is not returned, and the referrer's pending credit is voided as well. A refund whose initiator was never recorded counts as a buyer cancellation.

### The value of a restored credit

When a refund caused by the expert or the platform restores credit that an order had used, the restored credit is valid for at least 30 more days. When the buyer cancelled, the credit keeps its original expiry, and a credit that has already expired is lost.

`restoreUsageToCredit` in `lib/referrals/service.ts` implements this rule. It extends a live credit's expiry in place, and it moves value from an `EXPIRED` credit to a new `VESTED` credit rather than reviving the old row.

## 7. Owner decisions of 2026-10-04

These earlier decisions remain in force.

- The referee receives an instant discount before tax and no cash. The referrer receives a promotional credit after the friend's first completed session.
- The first paid purchase with an expert fixes the source for every later purchase with that expert.
- The credit redemption cap starts at 20 % of an order and may not exceed the order's take.
- Expert to expert is a platform-fee waiver for 3 delivered sessions on both sides for 90 days, with no cash reward.
- Rewards are promotional credit for buyers and fee waivers for experts. There are no cash rewards, no contests and no organisation referrals at launch.

## 8. Switching the programme on

The programme stays off until both actions below are done. They are owner actions and need no code change.

1. Set `monthlyBudgetPaise` with `PATCH /api/admin/referrals/config`, including a reason. Each expert referral is charged `expertReferralBudgetPaise` against it at vest.
2. Approve the launch fee schedule, called `fee-schedule-launch`, with `POST /api/admin/fee-schedules/[scheduleId]/approve`. Without an approved schedule, both rails use the marketplace rate, so an expert's own-link sale is charged the 20 % take instead of 10 %.

The review-hold thresholds are set through the same `PATCH` route. While they are null the hold rules are off and only the other controls apply.

## 9. Not built yet

The following parts of the design are not in the code.

- A weighted risk score that also uses account age and cycles in the referral graph. The review hold uses the request signals and the shared-payer void uses the payment instruments.
- Comparing card payments for a shared payer. Razorpay exposes no card fingerprint that stays the same across customers.
- Ops console reports for referrals by state, void rate by reason, budget burn, liability and breakage.
- Notices for a voided referral and for credit that is about to expire. The welcome, reward-earned and credits-applied notices exist.

Several smaller gaps between the design and the code are worth knowing.

- The design drops `Referral.organizationId`, the unused status values and the unused code columns. They are still in the schema and are dropped in a later expand-and-contract step.
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
