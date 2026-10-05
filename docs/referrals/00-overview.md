# Referral System: Overview

The referral system pays for growth out of the platform's own margin and never out of an expert's pocket. It runs three programmes, all governed by one editable configuration row and one versioned take-rate schedule. A reward is released only after the referred person has paid for a session, the session has been delivered, and the refund window has passed.

This overview describes what the code does today. The detailed documents are listed at the end.

## The three programmes

The table below names each programme, who receives what, and the event that releases the reward.

| Programme                     | What the new person gets                                                                      | What the referrer gets                                                                                                | What releases it                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consumer to consumer          | A welcome discount of 20 % before tax, at most ₹300, on their first paid marketplace booking. | A promotional credit of ₹300, spendable only after it vests.                                                          | The first session of the friend's first booking is completed, the hold after it has passed, and no refund or open dispute exists.                              |
| Expert own link               | The expert's normal price. The buyer sees no change.                                          | The expert keeps 90 % of the sale instead of 80 %, because the take is 10 % instead of 20 % through the fee schedule. | The buyer arrived through the expert's signed share link, or already belongs to the expert from an earlier paid purchase.                                      |
| Expert to expert (fee waiver) | A waiver of the platform fee on their first 3 sessions, valid for 90 days.                    | The same waiver for the referring expert, when the referrer also has an expert profile.                               | The referred expert has a PAN and a verified default payout account, and has delivered a first paid session to a buyer who is not the referrer, past the hold. |

All consumer amounts, caps and windows are columns of `ReferralProgramConfig`. The take rates are columns of `PlatformFeeSchedule`. Nothing in this table is a constant in code, with one exception: no promotional credit may ever exceed the take of the order it is spent on.

## How a buyer comes to belong to a referral or an expert

There are three entry points, and they set three different things.

- A visit to `/r/<code>` stores the code in the `fam_ref` cookie for 30 days. A signed-in visitor has the code applied immediately. A visitor who is not signed in is sent to signup, and onboarding applies the stored code once the person is authenticated.
- A visit to an expert's public page with `?via=<token>` stores the signed token in the `fam_via` cookie for 30 days. The token names one expert profile and carries an issue time and an HMAC. It is verified at checkout, not at the edge, and it expires 30 days after it was issued.
- The first paid purchase with an expert fixes who owns the buyer for that expert. The row in `ExpertCustomerRelationship` records whether the buyer came through the marketplace, the expert's own link, or a consumer referral. Every later purchase with the same expert uses that stored source, so an own-link buyer stays at the lower take and a marketplace buyer cannot be claimed afterwards by presenting an own-link token.

The full resolution order is in [01-architecture.md](./01-architecture.md).

## What the money rules guarantee

The rules below are enforced in code and, where marked, in Postgres. The reasoning behind each rule is in [04-reward-economics-and-decisions.md](./04-reward-economics-and-decisions.md).

- A promotional credit or discount never costs more than the platform earns on the order it touches. The welcome discount is capped at the order's take rate, and credit redemption is capped at the smaller of the configured cap and that take.
- A buyer may hold only one live welcome-discounted order at a time. A partial unique index in `prisma/sql/check-constraints.sql` enforces this.
- Promotional credit is never combined with an expert fee waiver, because the waiver removes the take that would have paid for the promotion.
- Sellers who belong to a host organisation never receive promotions on their sales.
- A monthly budget bounds the total cost. The welcome discount is counted against it at capture, and each reward is counted against it at vest. New referees pause at 90 % of the budget.
- Per-code, weekly, yearly and expert-yearly caps bound how much any one person can earn.

## Background jobs

Two jobs run the programme. `vest-referral-credits` runs on the Netlify ticker every 30 minutes and decides each waiting referral. `expire-referral-credits` runs monthly from GitHub Actions through its `CRON_SECRET` HTTP twin and releases expired balances. See [01-architecture.md](./01-architecture.md) for details.

## Switching the programme on

The programme is off until the owner completes three actions. The first creates the budget, the second activates the launch take rates, and the third lets the monthly job run.

1. Set `monthlyBudgetPaise` through `PATCH /api/admin/referrals/config` with a reason. The default of 0 keeps the programme off.
2. Approve the launch fee schedule (`fee-schedule-launch`) through `POST /api/admin/fee-schedules/[scheduleId]/approve`. Until a schedule is approved, both rails use the marketplace rate.
3. Add the `CRON_SECRET` secret to the GitHub repository so the monthly breakage workflow can authenticate.

The shared database already holds a pending schedule with the id `fee-schedule-launch` (20 % marketplace, 10 % own-link), drafted by `system-seed`, so the owner approves it as the second person. A freshly seeded database gets a pre-approved 20 % and 10 % schedule from the seed file instead.

## Not built yet

These items are designed but not implemented. They are tracked together as the second part of the referral work.

- An abuse risk score and a manual review queue.
- Blocking of email aliases and disposable domains.
- Clawback of a credit after a chargeback that lands once the credit has vested.
- Ops console reports for referral graph, budget burn, liability and breakage.
- Novu notification families for applied, vested, voided and expiring referrals.

## File map

The table below lists where each part of the system lives.

| Area                                   | Location                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Codes, apply, credits, refund restores | `lib/referrals/service.ts`                                                                             |
| Attribution at checkout                | `lib/referrals/attribution.ts`, `lib/referrals/attribution-token.ts`                                   |
| Capture inside the payment transaction | `lib/referrals/capture.ts`                                                                             |
| Vest, void, reopen, breakage           | `lib/referrals/vesting.ts`                                                                             |
| Configuration and budget               | `lib/referrals/program-config.ts`                                                                      |
| Discount and credit arithmetic         | `lib/referrals/promo-math.ts`, `lib/payments/pricing/derive-checkout-amount.ts`                        |
| Take rate, waiver, schedule approval   | `lib/payments/pricing/platform-fee.ts`                                                                 |
| Share links                            | `app/r/[code]/route.ts`, the `?via=` handling in `middleware.ts`                                       |
| User routes                            | `app/api/referrals/**`, `app/api/checkout/referral-pricing/route.ts`                                   |
| Admin routes                           | `app/api/admin/referrals/**`, `app/api/admin/fee-schedules/**`                                         |
| Job registration                       | `lib/cron/cleanup-registry.ts`, `netlify/functions/cron-tick.mts`, `.github/workflows/cron-weekly.yml` |
| Ledger reconciliation                  | `scripts/reconcile/reconcile-ledgers.ts`                                                               |

## Related documents

- [01 — Architecture and flows](./01-architecture.md)
- [02 — API reference](./02-api-reference.md)
- [03 — Credit system and ledger](./03-credit-system.md)
- [04 — Economics, guards and owner decisions](./04-reward-economics-and-decisions.md)
- [05 — Authentication and onboarding integration](./05-auth-onboarding-integration.md)

## Deprecated & Superseded Approaches

The first version of the referral system paid a flat ₹500 to the referrer and ₹200 to the referee as soon as the referee's first payment was captured. Credits expired after six months, expiry was computed only when credits were read, and nothing bounded total cost. It was replaced because a reward paid at capture could be farmed with refunds and tiny payments, and because the platform could not cap its liability.

Leftovers from that version that engineers may still meet and may delete when touched:

- `DEFAULT_REFERRER_REWARD` and `DEFAULT_REFEREE_REWARD` in `lib/referrals/service.ts`, and the `referrerReward` and `refereeReward` columns on `ReferralCode`. Rewards now come from `ReferralProgramConfig`, so these columns are never read for money.
- The `QUALIFIED`, `REWARDED` and `FRAUDULENT` values of `ReferralStatus`, and `Referral.organizationId`. No code path writes them.
- The `REFEREE_BONUS` credit source. The referee now receives a discount on the invoice and no credit row.
- The `processQualifyingAction` function and the daily `scripts/referrals/expire-credits.ts` job. Both are gone. The cron reference in `docs/maintenance/04-cron-jobs-reference.md` still lists an `expire-credits` row that no longer matches the registry.
