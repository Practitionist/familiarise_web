---
title: Growth — Referrals
type: explanation
status: live
last-reviewed: 2026-11-08
---

# Referrals

This page is the growth view of referrals: what is switched on at launch, how fraud is held back, and what happens when a payment is charged back. It is deliberately short. The mechanics are in [the referral overview](../referrals/00-overview.md), [the architecture](../referrals/01-architecture.md), [the API](../referrals/02-api-reference.md) and [the economics and decisions](../referrals/03-reward-economics-and-decisions.md), and the ledger lines are in [the referral credits ledger](../finance/20-ledger/07-referral-credits.md). Nothing from those pages is copied here. Behaviour not on `dev` yet carries the tag `#2657` for #2657 "Growth: referral fraud controls, review hold, shared-payer and chargeback voids".

## The three programmes and the launch scope

| Programme          | The new person gets                                      | The referrer gets                                                                                            | At launch                                                                   |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Expert's own link  | The expert's normal price                                | A lower platform fee on that expert's sales to the people the link brings                                    | On. It costs no cash.                                                       |
| Expert to expert   | Fee-free sessions                                        | Fee-free sessions                                                                                            | On. It costs no cash.                                                       |
| Learner to learner | A welcome discount on the first paid marketplace booking | A platform credit of ₹300 after the friend's session is delivered; the credit expires 90 days after it vests | On, within a capped monthly budget, reviewed after 60 days of booking data. |

The budget is set by the owner and the value is kept in Notion (Familiarise / Growth & Marketing). The programme row `ReferralProgramConfig` holds it, and a budget of zero keeps the learner programme off, so **setting the budget is an owner go-live step**; see [the roadmap](./05-roadmap.md). Attribution is unchanged: an expert's own link wins over a learner referral for that expert's sales.

Why the reward is a credit and not cash: a credit can only be spent on the platform, it vests late, and it never exceeds the platform's take on the order it is spent on. The first design paid cash at the friend's first payment and could be farmed (see the closing section and [the research page](./04-market-research-india-first.md#indian-referral-programmes)).

## Fraud controls

Every control is cheap and works from data the platform already has. No paid device-fingerprinting vendor is used until abuse appears. The thresholds that decide a hold are configuration fields on `ReferralProgramConfig`, set by the owner and kept in Notion. **(after #2657)**

| Control                                  | What it does                                                                                                                                                        | Enforcer                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Email alias and disposable-domain checks | When a code is applied, `normaliseEmail` drops `+tag` and Gmail dots, and a disposable-mailbox domain is refused.                                                   | `applyReferralCode` in `lib/referrals/service.ts`, `lib/referrals/email-signals.ts`, `lib/referrals/disposable-domains.ts` |
| Rate limits                              | Applying a code, customising a code and creating an expert link are each limited per user.                                                                          | `referralApplyLimiter`, `referralCustomizeLimiter`, `expertLinkLimiter` in `lib/rate-limit.ts`                             |
| Hashed request signals                   | A keyed hash of the apply request's IP and the user agent are stored on the referral. They are never shown to the referrer.                                         | `lib/referrals/signal-hash.ts`, `app/api/referrals/apply/route.ts`                                                         |
| Shared payer instrument                  | The vest voids a referral (`SHARED_PAYER`) when the friend paid with a UPI address or phone number the referrer has also paid with. Card payments are not compared. | `recordPayerInstruments` in `lib/payments/payer-instruments.ts`, the vest in `lib/referrals/vesting.ts`                    |
| Review hold                              | A referral that trips a review rule is held instead of vested.                                                                                                      | `settleQualifyingReferral` in `lib/referrals/vesting.ts`                                                                   |
| Vesting after real delivery              | The strongest control: the reward waits for a paid, delivered session, a closed refund window and no live dispute.                                                  | The vest sweep, `vest-referral-credits` in `lib/cron/cleanup-registry.ts`                                                  |

## The review hold

At vest time, two rules decide whether to hold a referral: how many referrals of the same code share the same IP hash, and how many share both the IP hash and the user agent (reason `SAME_IP` or `SAME_DEVICE`), counted over a window of days. Each rule is off while its field (`holdSameIpReferrals`, `holdSameDeviceReferrals`, `holdWindowDays`) is empty. The values are set by the owner; the value is kept in Notion.

A held referral moves `QUALIFYING` to `HELD` and its credit stays `PENDING`. An administrator sees it under "Held for review" in the referrals back office (`HeldReferralsPanel`, `app/api/admin/referrals/held/route.ts`) and either **releases** it, which returns it to `QUALIFYING` and stamps `reviewReleasedAt` so the rules never hold it again, or **voids** it with the reason `REVIEW_REJECTED`, which voids the pending credit. Both decisions need a reason and write an audit row. The referrer's own list shows a held referral as still waiting, so a held referral does not reveal the rule that caught it.

For example, Daniel Brown shares a code and four friends sign up from one office network within a week. Suppose the owner's rule holds a code's referrals at three from one IP. The fourth friend's vest becomes `HELD` instead of paying out. An administrator opens the queue, sees the reason `SAME_IP`, checks the friend's real activity and releases it, or voids it.

## The chargeback void

When a dispute on the friend's qualifying payment settles as lost, the platform has paid a reward on money that came back. `settleLostDispute` (`app/api/webhooks/utils.ts`) calls `voidVestedReferralRewards` (`lib/referrals/credit-reversal.ts`) in the same transaction as the verdict, so the webhook and the dispute poll both apply it. The unspent balance of the referrer's credit is voided through the existing reversal posting (`reverseCreditBalance`, journal key `referral-reverse:<creditId>`), and any part already spent is absorbed by the platform as a promotion cost. A negative credit balance was rejected, because it would add a money state for a loss capped at one reward. Replaying the verdict changes nothing, because a credit is reversed at most once. **(after #2657)**

For example, Priya Anderson's friend pays ₹1,180, Priya's ₹300 credit (30,000 paise) vests, and Priya spends ₹100 (10,000 paise) of it. The friend's bank then wins a chargeback. The remaining ₹200 (20,000 paise) leaves the liability; the ₹100 already spent stays as a platform cost.

## Not built yet

Notices that tell a referrer their referral was voided or that credit expires soon are **planned** (P2 in [the roadmap](./05-roadmap.md)). Vendor device fingerprinting is deferred until abuse appears.

## Handed to the taxes session

Whether the credit and the welcome discount carry GST (a discount shown on the invoice before supply may reduce the taxable value), and whether TDS under section 194R applies to expert rewards and fee waivers, are open tax questions. They are in [the research page](./04-market-research-india-first.md#tax-flags) and the [roadmap](./05-roadmap.md), not decided here.

## Where in code

`lib/referrals/**`, `app/api/referrals/**`, `app/api/admin/referrals/**`, `app/r/[code]/route.ts`, `lib/payments/payer-instruments.ts`, and the lost-dispute settlement in `app/api/webhooks/utils.ts`.

## Deprecated & Superseded Approaches

- **The ₹500 and ₹200 cash reward.** The first version paid a flat ₹500 to the referrer and ₹200 to the friend at the friend's first payment. It could be farmed with refunds and tiny payments, and it bounded no liability. The vested credit and the welcome discount replaced it.
- **`QUALIFIED`, `REWARDED` and `FRAUDULENT`.** Unused `ReferralStatus` values, dropped in a later expand-and-contract step with the `referrerReward` and `refereeReward` columns.
- **Rewards at capture.** The reward is no longer granted at payment capture. It vests only after delivery and the hold.
- **A paid device-fingerprinting vendor.** Rejected for now: it adds cost and a new processor of personal data before there is abuse to stop.
