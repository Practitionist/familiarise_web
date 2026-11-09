# Referral System: Overview

The referral system pays for growth out of the platform's own margin and never out of an expert's pocket. It runs three programmes, all governed by one editable configuration row and one versioned take-rate schedule. A reward is released only after the referred person has paid for a session, the session has been delivered, and the refund window has passed.

This overview describes what the code does today. The detailed documents are listed at the end.

## The three programmes

The table below names each programme, who receives what, and the event that releases the reward.

| Programme                     | What the new person gets                                                                                                                                          | What the referrer gets                                                                                                | What releases it                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consumer to consumer          | A welcome discount of up to 20 % before tax, at most ₹300 and never more than the platform's fee on that booking allows, on their first paid marketplace booking. | A promotional credit of up to ₹300, spendable only after it vests.                                                    | The first session of the friend's first booking is completed, the hold after it has passed, and no refund or open dispute exists.                              |
| Expert own link               | The expert's normal price. The buyer sees no change.                                                                                                              | The expert keeps 90 % of the sale instead of 80 %, because the take is 10 % instead of 20 % through the fee schedule. | The buyer arrived through the expert's signed share link, or already belongs to the expert from an earlier paid purchase.                                      |
| Expert to expert (fee waiver) | A waiver of the platform fee on their first 3 sessions, valid for 90 days.                                                                                        | The same waiver for the referring expert, when the referrer also has an expert profile.                               | The referred expert has a PAN and a verified default payout account, and has delivered a first paid session to a buyer who is not the referrer, past the hold. |

All consumer amounts, caps and windows are columns of `ReferralProgramConfig`. The take rates are columns of `PlatformFeeSchedule`. Nothing in this table is a constant in code, with one exception: no promotional credit may ever exceed the take of the order it is spent on.

## How a buyer comes to belong to a referral or an expert

There are three entry points, and they set three different things.

- A visit to `/r/<code>` stores the code in the `fam_ref` cookie for 30 days. A signed-in visitor has the code applied immediately. A visitor who is not signed in is sent to signup, and onboarding applies the stored code once the person is authenticated.
- A visit to an expert's public page or one of the expert's programme plans (`/explore/experts/*` or `/explore/programs/plans/*`) with `?via=<token>` stores the signed token in the `fam_via` cookie for 30 days. The token names one expert profile and carries an issue time and an HMAC. It is verified at checkout, not at the edge, and it expires 30 days after it was issued.
- The first paid purchase with an expert fixes who owns the buyer for that expert. The row in `ExpertCustomerRelationship` records whether the buyer came through the marketplace, the expert's own link, or a consumer referral. Every later purchase with the same expert uses that stored source, so an own-link buyer stays at the lower take and a marketplace buyer cannot be claimed afterwards by presenting an own-link token.

The full resolution order is in [01-architecture.md](./01-architecture.md).

## What the money rules guarantee

The rules below are enforced in code and, where marked, in Postgres. The reasoning behind each rule is in [03-reward-economics-and-decisions.md](./03-reward-economics-and-decisions.md).

- A promotional credit or discount never costs more than the platform earns on the order it touches. The welcome discount is capped at the order's take rate, and credit redemption is capped at the smaller of the configured cap and that take.
- A buyer may hold only one live welcome-discounted order at a time. A partial unique index in `prisma/sql/check-constraints.sql` enforces this.
- Promotional credit is never combined with an expert fee waiver, because the waiver removes the take that would have paid for the promotion.
- Sellers who belong to a host organisation never receive promotions on their sales.
- A monthly budget bounds the total cost. The welcome discount is counted against it at capture, and each reward is counted against it at vest. New referees pause at 90 % of the budget, while a referee who already signed up keeps the welcome discount as long as the programme is live.
- Per-code, weekly, yearly and expert-yearly caps bound how much any one person can earn.

## Fraud controls

Cheap checks run at the two moments where farming would pay off: when a code is applied and when a reward vests. No device-fingerprinting vendor is used. The rule thresholds are configuration fields whose values are set by the owner and kept in Notion.

- When a code is applied, the referee's email is normalised (lowercased, any `+tag` dropped, and dots ignored for Gmail), and the code is refused when that mailbox is the referrer's own or sits on a known disposable-mail domain. The refusal is the same generic 400 as every other refusal, so it reveals nothing.
- The apply step stores a keyed hash of the client IP and the user agent string, truncated to 256 characters and stored as sent rather than hashed, on the `Referral` row. Both are cleared 180 days after the referral ends, or 180 days after it was created if it never settles, and on erasure.
- At vest, a referral is voided with reason `SHARED_PAYER` when the friend's qualifying payment used a UPI address or phone number that the referrer has also paid with.
- At vest, a referral whose request signals recur across the referrer's other referrals moves to `HELD` instead of vesting, and waits in the admin "Held for review" queue.
- When the dispute on a vested referral's qualifying payment is lost, the unspent part of the referrer's credit is voided and the experts' unused fee-waiver sessions end.

## Background jobs

Two jobs run the programme, both on the ticker. `vest-referral-credits` runs every 30 minutes and decides each waiting referral. `expire-referral-credits` runs in a monthly window and releases expired balances. See [01-architecture.md](./01-architecture.md) for details.

## Switching the programme on

The programme is off until the owner completes two actions. The first creates the budget and the second activates the launch take rates. Setting the review-hold thresholds is a third, optional edit of the same configuration row.

1. Set `monthlyBudgetPaise` through `PATCH /api/admin/referrals/config` with a reason. The default of 0 keeps the programme off.
2. Approve the launch fee schedule (`fee-schedule-launch`) through `POST /api/admin/fee-schedules/[scheduleId]/approve`. Until a schedule is approved, both rails use the marketplace rate.

The shared database already holds a pending schedule with the id `fee-schedule-launch` (20 % marketplace, 10 % own-link), drafted by `system-seed`, so the owner approves it as the second person. A freshly seeded database gets a pre-approved 20 % and 10 % schedule from the seed file instead.

## Not built yet

These items are designed but not implemented.

- A weighted risk score that combines account age and cycles in the referral graph. The review hold uses the request signals only.
- Ops console reports for referral graph, budget burn, liability and breakage.
- Notices for a voided referral and for credit that is about to expire. The welcome, reward-earned and credits-applied notices already exist.

## File map

The table below lists where each part of the system lives.

| Area                                   | Location                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Codes, apply, credits, refund restores | `lib/referrals/service.ts`                                                                  |
| Attribution at checkout                | `lib/referrals/attribution.ts`, `lib/referrals/attribution-token.ts`                        |
| Capture inside the payment transaction | `lib/referrals/capture.ts`                                                                  |
| Vest, void, reopen, hold, breakage     | `lib/referrals/vesting.ts`                                                                  |
| Fraud signals and review decisions     | `lib/referrals/email-signals.ts`, `lib/referrals/signal-hash.ts`, `lib/referrals/review.ts` |
| Credit reversal and chargeback void    | `lib/referrals/credit-reversal.ts`                                                          |
| Configuration and budget               | `lib/referrals/program-config.ts`                                                           |
| Discount and credit arithmetic         | `lib/referrals/promo-math.ts`, `lib/payments/pricing/derive-checkout-amount.ts`             |
| Take rate, waiver, schedule approval   | `lib/payments/pricing/platform-fee.ts`                                                      |
| Share links                            | `app/r/[code]/route.ts`, the `?via=` handling in `middleware.ts`                            |
| User routes                            | `app/api/referrals/**`, `app/api/checkout/referral-pricing/route.ts`                        |
| Admin routes                           | `app/api/admin/referrals/**`, `app/api/admin/fee-schedules/**`                              |
| Job registration                       | `lib/cron/cleanup-registry.ts`, `netlify/functions/cron-tick.mts`                           |
| Ledger reconciliation                  | `scripts/reconcile/reconcile-ledgers.ts`                                                    |

## Related documents

- [01 — Architecture and flows](./01-architecture.md)
- [02 — API reference](./02-api-reference.md)
- [Credit system and ledger](../finance/20-ledger/07-referral-credits.md)
- [03 — Economics, guards and owner decisions](./03-reward-economics-and-decisions.md)
- [04 — Authentication and onboarding integration](./04-auth-onboarding-integration.md)

## Deprecated & Superseded Approaches

The first version of the referral system paid a flat ₹500 to the referrer and ₹200 to the referee as soon as the referee's first payment was captured. Credits expired after six months, expiry was computed only when credits were read, and nothing bounded total cost. It was replaced because a reward paid at capture could be farmed with refunds and tiny payments, and because the platform could not cap its liability.

Leftovers from that version that engineers may still meet and may delete when touched:

- The `referrerReward` and `refereeReward` columns on `ReferralCode`. Nothing reads or writes them, and they are dropped in a later expand-and-contract step.
- The `QUALIFIED`, `REWARDED` and `FRAUDULENT` values of `ReferralStatus`, and `Referral.organizationId`. No code path writes them; the status values are dropped in the same later step.
- The `REFEREE_BONUS` credit source. The referee now receives a discount on the invoice and no credit row.
- The `processQualifyingAction` function and the daily `scripts/referrals/expire-credits.ts` job. Both are gone. The cron reference in `docs/maintenance/04-cron-jobs-reference.md` still lists an `expire-credits` row that no longer matches the registry.
