# Referral System: API Reference

This document lists every route that belongs to the referral programme. Request and response shapes are summarised, and the route files are the source of truth for exact fields. All amounts are paise.

## 1. Share links

Two kinds of link start attribution. Neither is an API call, and both set a cookie that lasts 30 days.

| Link                                | Handler                                 | Behaviour                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/r/<code>`                         | `app/r/[code]/route.ts`                 | An invalid or unknown code redirects to `/auth/signup`. A visitor who is not signed in is sent to `/auth/signup?ref=<code>`. A signed-in visitor has the code applied at once, subject to the apply rate limit, and lands on the dashboard. The `fam_ref` cookie is set in every valid case. |
| `/explore/experts/<id>?via=<token>` | The `?via=` handling in `middleware.ts` | A token of the right shape is stored in the `fam_via` cookie. The signature and age are checked later, at checkout.                                                                                                                                                                          |

## 2. Signed-in user routes

Every route in this section requires a session and returns 401 without one.

| Route                                  | Purpose                                                                                                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/referrals/code`              | The caller's code row, plus `terms`, which is the public description of the offer or `null` when the programme takes no new referees.                                                                             |
| `POST /api/referrals/code`             | Creates the caller's code if none exists, or returns the existing one. Returns the same shape as the GET.                                                                                                         |
| `POST /api/referrals/code/customize`   | Body `{ customCode }`. Sets a vanity code of 3 to 20 letters and digits that is unique across both code columns. Returns 400 when it is taken or out of range.                                                    |
| `GET /api/referrals`                   | The people the caller referred, with name and image. A `SIGNED_UP` row past the qualify window is reported as `EXPIRED`.                                                                                          |
| `POST /api/referrals/apply`            | Body `{ code }`. Applies a code to the caller's new account. It is limited to 3 tries per 24 hours per user. A refusal returns a single generic 400 so that codes cannot be probed.                               |
| `GET /api/referrals/credits`           | `{ totalAvailable, history }`, where the history includes pending, used, expired and void credits.                                                                                                                |
| `GET /api/referrals/credits/available` | `{ totalAvailable, currency: "INR" }` for spendable credits only.                                                                                                                                                 |
| `GET /api/referrals/expert-link`       | For an expert, the share path `/explore/experts/<id>?via=<signed token>`. Returns 404 for a user without an expert profile.                                                                                       |
| `GET /api/checkout/referral-pricing`   | Query `consultantProfileId`. Returns `{ welcomeDiscount, creditCapBps }`, which is exactly what checkout will apply, so the price preview matches the charge. It is rate limited by the checkout context limiter. |

`welcomeDiscount` is `null` or an object with `bps`, `maxPaise` and `minOrderPaise`. It is `null` when the buyer has no eligible referral, the order carries a discount code, the seller has a live fee waiver or belongs to a host organisation, or the programme is not live.

## 3. Public route

`GET /api/referrals/code/check/[code]` needs no session and is limited to 10 requests per minute per IP address. It returns `{ valid, referrerName, terms }`, and `terms` is present only for a valid code while the programme takes new referees. The signup page uses it to show the banner.

## 4. Backoffice routes

Admin routes run through `withOpsAction`, which requires a written reason and stores a before and after snapshot in the ops audit log in the same transaction. Reading needs the `referrals.read` or `payments.read` surface, which STAFF and ADMIN both hold. Writing needs `referrals.manage` or `payments.manage`, which only ADMIN holds.

| Route                                                  | Who          | Purpose                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/referrals/config`                      | STAFF, ADMIN | The `ReferralProgramConfig` row, or `null` before it exists.                                                                                                                                                                                                                                                                                |
| `PATCH /api/admin/referrals/config`                    | ADMIN        | Edits any of the economics fields and bumps `version` by one using a conditional update on the current version. An edit must send the `expectedVersion` it loaded, or it is refused with 400 `VERSION_REQUIRED`; a stale one fails with 409 `CONFIG_CHANGED`. An empty patch is refused with `EMPTY_PATCH`. The first call creates the row. |
| `GET /api/admin/referrals/credits`                     | STAFF, ADMIN | A paginated credit list with user, code and usages. Filters are `userId`, `q`, `source`, derived `status`, `page` and `limit`.                                                                                                                                                                                                              |
| `POST /api/admin/referrals/credits`                    | ADMIN        | Issues a `COMPENSATION` or `MANUAL` credit with an optional `idempotencyKey` and expiry. The credit is spendable at once and is posted to the liability.                                                                                                                                                                                    |
| `POST /api/admin/referrals/credits/[creditId]/reverse` | ADMIN        | Voids the unused balance of a credit and releases it from the liability. Refused when the credit is already reversed, expired, void or empty.                                                                                                                                                                                               |
| `GET /api/admin/fee-schedules`                         | STAFF, ADMIN | The latest 50 schedules and the active one.                                                                                                                                                                                                                                                                                                 |
| `POST /api/admin/fee-schedules`                        | ADMIN        | Proposes a schedule with `marketplaceBps`, `ownLinkBps`, `effectiveFrom` and a reason. The own-link rate may not exceed the marketplace rate, and `effectiveFrom` may not be in the past. The row stays unapproved and has no effect.                                                                                                       |
| `POST /api/admin/fee-schedules/[scheduleId]/approve`   | ADMIN        | The checker step of maker-checker. See the rules below.                                                                                                                                                                                                                                                                                     |

### Editable configuration fields

The fields that `PATCH /api/admin/referrals/config` accepts, with their bounds, are shown below. Each is optional and at least one must be present.

| Field                                      | Meaning                                                                   | Default       |
| ------------------------------------------ | ------------------------------------------------------------------------- | ------------- |
| `paused`                                   | Stops new referees and vests while true.                                  | false         |
| `monthlyBudgetPaise`                       | The month's ceiling for discounts, rewards and waiver costs. 0 means off. | 0             |
| `referrerRewardPaise`                      | The referrer's credit.                                                    | 30,000        |
| `discountBps`, `discountMaxPaise`          | The welcome discount rate (max 10,000) and its ceiling.                   | 2,000; 30,000 |
| `redemptionCapBps`                         | The most of an order's list price that credits and discount may cover.    | 2,000         |
| `minOrderPaise`                            | Floor for cash paid after the discount and credits.                       | 50,000        |
| `creditExpiryDays`                         | Days a vested credit stays spendable (1 to 3,650).                        | 90            |
| `qualifyWindowDays`                        | Days the referee has to pay and be delivered (1 to 365).                  | 30            |
| `perCodeLifetimeCap`                       | Vests one code may ever earn.                                             | 25            |
| `perReferrerYearlyCapPaise`                | Reward value one code may earn per calendar year.                         | 1,000,000     |
| `weeklyVestCap`                            | Vests one code may earn per ISO week.                                     | 5             |
| `expertYearlyReferralCap`                  | Expert referrals one code may vest per year.                              | 10            |
| `expertWaiverSessions`, `expertWaiverDays` | Waived sessions per expert and their validity.                            | 3; 90         |
| `expertReferralBudgetPaise`                | Budget charged when an expert referral vests.                             | 180,000       |

A database check, `referral_program_config_ranges`, repeats these bounds.

### Fee schedule approval

A different ADMIN may always approve a schedule. The proposer may approve their own schedule only when exactly one active ADMIN exists, at least 24 hours after proposing it, and with a reason. A refusal is a 409 with `SAME_PERSON` or `SELF_APPROVAL_TOO_SOON`. The database check `platform_fee_schedule_valid` enforces the 24-hour bound on `approvedAt` and also enforces that a schedule with a checker has an approval time, so the rule holds even if application code is bypassed.

## 5. Where the programme hooks into payments

The payment code calls into the referral code at three points.

- `resolveCheckoutAttribution` runs when an order is minted, both in `lib/payments/operations/checkout.ts` and in the pricing preview route. A second live welcome-discounted order for the same buyer fails with the typed 409 `WELCOME_DISCOUNT_IN_USE`.
- `recordReferralCaptureInSavepoint` runs inside the payment confirmation, from the checkout capture path and from the webhook handlers.
- `reverseCreditsForPayment` and `restoreCreditsForPaymentUpTo` run in the refund and cancel paths.

## Deprecated & Superseded Approaches

The first version exposed one apply route that granted a referee credit immediately and a payment webhook step that called `processQualifyingAction(userId, "first_paid_booking")` to pay the referrer at once. It also had a server-rendered `/r/[code]` page, and its code endpoints returned the reward amounts stored on the code row.

Residual artifacts to delete when found:

- Any client that reads `referrerReward` or `refereeReward` from the code row to show an offer. The offer now comes from the `terms` field.
- Any reference to a REFEREE_BONUS credit at signup.
- Any caller of a removed payment hook for referral qualification. Qualification is now `recordReferralCapture`.
