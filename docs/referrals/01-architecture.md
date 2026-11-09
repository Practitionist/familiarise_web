# Referral System: Architecture and Flows

This document follows a referral from the shared link to the vested reward. It describes the code at the head of the referral v2 branch.

## 1. Moving parts

A referral touches four moments in a payment's life, and each moment has one owner in code.

| Moment          | Where it runs                                                                                   | What it does                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Apply           | `applyReferralCode` in `lib/referrals/service.ts`                                               | Creates the `Referral` row in `SIGNED_UP` for a new account, with the request's IP hash and user agent.       |
| Price and stamp | `resolveCheckoutAttribution` in `lib/referrals/attribution.ts`, called when the order is minted | Decides the source, the take rate, the welcome discount and the credit cap, and stamps them on the `Payment`. |
| Capture         | `recordReferralCapture` in `lib/referrals/capture.ts`, inside the payment confirmation          | Records who owns the buyer, moves the referral to `QUALIFYING`, and creates the referrer's `PENDING` credit.  |
| Vest            | `settleQualifyingReferral` in `lib/referrals/vesting.ts`, run by the ticker                     | Vests, voids, reopens, holds or defers each waiting referral.                                                 |

The capture step runs inside its own database savepoint. A fault in referral code rolls back to the savepoint, is reported to Sentry once, and never undoes a confirmed booking. Only a serialization failure aborts the whole capture so that it retries.

## 2. Share links and the two cookies

Two first-party cookies carry attribution for 30 days, which equals the default qualify window.

| Cookie    | Set by                                                                                                   | Contents                                                                                      | Used for                                                   |
| --------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `fam_ref` | `app/r/[code]/route.ts`                                                                                  | The consumer referral code, validated against `^[A-Za-z0-9_-]{3,32}$` and an active code row. | Onboarding reads it and calls `POST /api/referrals/apply`. |
| `fam_via` | The `rememberExpertVia` step of `middleware.ts`, on `/explore/experts/*` and `/explore/programs/plans/*` | `<consultantProfileId>.<issued-at seconds>.<HMAC>`, checked at the edge for shape only.       | Checkout verifies the HMAC and the 30-day age.             |

The HMAC key is derived from `BETTER_AUTH_SECRET` with a fixed purpose string, so the token cannot be reused as any other credential. A token is rejected when it is malformed, forged, older than 30 days, or issued more than five minutes in the future. An expert obtains a freshly signed link from `GET /api/referrals/expert-link`.

## 3. Who owns the buyer: the source resolution order

`resolveCheckoutAttribution` picks the attribution source for an order in a fixed order. The first rule that matches wins.

1. If there is no expert, or the buyer is the expert, the source is `MARKETPLACE`.
2. If an `ExpertCustomerRelationship` already exists for this buyer and expert, its stored source is used and no referral is attached.
3. If the `fam_via` token verifies for this exact expert, the source is `OWN_LINK`.
4. If the order is funded by an organisation, or the programme takes no new referees, the source is `MARKETPLACE`.
5. If the buyer has a `Referral` in `SIGNED_UP` inside the qualify window, the referrer is not the expert, and the buyer has no earlier succeeded payment that was not released, the source is `CONSUMER_REFERRAL` and the referral is attached.
6. Otherwise the source is `MARKETPLACE`.

The take rate then comes from the active fee schedule: `ownLinkBps` for `OWN_LINK` and `marketplaceBps` for everything else. The schedule in force is the latest approved row whose `effectiveFrom` has passed. With no approved row, both rails use the marketplace constant. The chosen basis points are stamped on the `Payment` as `platformFeeBps`, so a later schedule change never reprices a sale that already exists.

The first paid purchase with an expert fixes the relationship. At capture, a payment with a gateway (cash) leg writes the `ExpertCustomerRelationship` row with the payment's source, and an insert that already exists is ignored. A credit-only, zero-value or organisation-funded sale never creates a relationship.

## 4. Referral lifecycle

A `Referral` moves through the states shown below. `EXPIRED` is not written to the row. The listing endpoint reports a `SIGNED_UP` row whose window has lapsed as `EXPIRED`, and attribution and capture simply stop matching it.

```
                       capture of the first paid purchase
   ┌────────────┐  ───────────────────────────────────────►  ┌────────────┐
   │  SIGNED_UP │                                            │ QUALIFYING │
   └────────────┘  ◄───────────────────────────────────────  └────────────┘
     │      ▲        reopen: expert or platform cancelled        │      │
     │      │        the refunded first booking                  │      │
     │      │                                                    │      │ delivered, held, no refund,
     │      │                                                    │      │ caps and budget allow
     │      │                                                    │      ▼
     │      │                                                    │  ┌────────┐
     │      │                                                    │  │ VESTED │
     │      │                                                    │  └────────┘
     │      │                                                    ▼
     │      │                                               ┌────────┐
     │      │                                               │  VOID  │  (voidReason set)
     │      │                                               └────────┘
     ▼
  EXPIRED  (computed when read, after the qualify window)
```

One more state sits beside `QUALIFYING`. A referral that trips a review rule at vest moves `QUALIFYING` to `HELD`. An ADMIN then moves it `HELD` to `QUALIFYING` (release) or `HELD` to `VOID` with reason `REVIEW_REJECTED` (void).

The vest sweep decides each `QUALIFYING` referral in this order:

1. A succeeded refund on the qualifying payment ends the referral. If the buyer asked for the refund, or the refund's initiator was never recorded, the referral becomes `VOID` with reason `REFUNDED`. If the expert or the platform caused the refund, a consumer referral reopens to `SIGNED_UP`, and an expert referral becomes `VOID`.
2. A lost dispute becomes `VOID` with reason `CHARGEBACK`.
3. If the qualifying session was cancelled, rescheduled away or voided, the referral becomes `VOID` with reason `SESSION_NOT_DELIVERED`. A rescheduled session moves the referral to the appointment's next live session. If no live session remains, or the session is not completed within the qualify window, the reason is `WINDOW_LAPSED`.
4. A pending refund, an unsettled dispute, or a session that has not yet ended plus the appointment type's hold period makes the sweep wait.
5. The referrer being the seller (consumer referral) or the buyer (expert referral) becomes `VOID` with reason `SELF_DEALING`.
6. A qualifying payment made with a UPI address or phone number that the referrer has also paid with becomes `VOID` with reason `SHARED_PAYER`.
7. A programme that is not live defers the referral without changing it.
8. A referral that trips a review rule moves to `HELD` and leaves its `PENDING` credit untouched. The rules are described in [Review hold](#review-hold).
9. Otherwise the referral vests under the consumer or expert rules below.

Every transition is a conditional update that names the expected prior status. One referral is settled per Serializable transaction, so a failed row never blocks the others. The ticker passes a limit of 10 per tick, the sweep stops starting rows after 12 seconds, and a row that waits is moved behind unexamined rows so waiting referrals cannot starve ready ones.

### Consumer referral vest

The consumer vest, in one transaction, does the following.

1. It finds the referrer's `PENDING` credit for this referral. If none exists, the referral becomes `VOID` with reason `MISSING_CREDIT`.
2. It claims a slot on the referrer's code in one conditional update that checks the lifetime cap (25 vests), the yearly reward cap (₹10,000), and the weekly cap (5 vests). A refused slot becomes `VOID` for the lifetime or yearly cap, and a weekly refusal defers the referral to a later run.
3. It claims the reward from the monthly budget by conditional update on the configuration `version`. If the budget cannot cover the reward, the whole row rolls back and waits for the next month.
4. It moves the referral to `VESTED`, the credit to `VESTED` with an expiry of `creditExpiryDays` from now, and posts the ledger entry described in [Referral credits and the ledger](../finance/20-ledger/07-referral-credits.md).
5. It stages the referrer's `referral-bonus-earned` bell and `REFERRAL_BONUS_EARNED` email in the same transaction (`stageReferralReward`, `lib/referrals/referral-notify.ts`), attempted after commit. Applying a code stages the referee's welcome notice the same way, stating the programme's `discountMaxPaise` as a cap, and the payment that redeems credits stages `referral-credits-applied` in its checkout or capture transaction (notification decision 17).

### Expert referral vest

An expert referral qualifies when a referred expert receives a first paid sale that has a cash leg from a buyer who is not the referrer. The vest additionally requires:

1. An expert profile for the referred user, or the reason is `NO_EXPERT_PROFILE`.
2. A PAN on file and a verified default payout account. Until both exist the referral is deferred, and it becomes `VOID` with reason `KYC_NOT_COMPLETED` once the qualify window has passed since the session ended.
3. A free expert-yearly slot on the referrer's code, or the reason is `REFERRER_YEARLY_CAP`.
4. A budget claim of `expertReferralBudgetPaise`, which stands for the take the waived sessions forgo.

On success the referral vests and a `ConsultantFeeWaiver` row is created for the referred expert with reason `REFERRED_EXPERT`, and another for the referring expert with reason `REFERRING_EXPERT` when the referrer has a profile. Each waiver carries `expertWaiverSessions` sessions and expires after `expertWaiverDays`.

### Shared payer

The capture webhook carries the payer's UPI address (`vpa`, or `upi.vpa`) and phone (`contact`). `recordPayerInstruments` in `lib/payments/payer-instruments.ts` stores keyed hashes of them on the `Payment` as `payerVpaHash` and `payerPhoneHash`, once, after the capture has been confirmed. The raw values are never stored. The vest compares the qualifying payment's hashes with every other payment of the referrer. Razorpay exposes no stable card fingerprint across customers, so card payments are not compared. A payment that arrived before these columns existed carries no hashes and cannot match.

### Review hold

Two rules, both configuration fields on `ReferralProgramConfig`, decide whether a referral is held instead of vested. A rule is off while its field is null, and the values are set by the owner and kept in Notion.

| Field                     | The referral is held when                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `holdSameIpReferrals`     | at least this many referrals of the same code carry the same `ipHash` (reason `SAME_IP`).                     |
| `holdSameDeviceReferrals` | at least this many referrals of the same code carry the same `ipHash` and `userAgent` (reason `SAME_DEVICE`). |
| `holdWindowDays`          | limits both counts to referrals that signed up within this many days; null counts every referral.             |

A held referral is listed under "Held for review" in the referrals back office. An ADMIN either releases it, which moves it back to `QUALIFYING` and stamps `reviewReleasedAt` so the rules never hold it again, or voids it, which sets reason `REVIEW_REJECTED` and voids the `PENDING` credit. Both decisions need a reason and write an ops audit row. The referrer's own list shows a held referral as still waiting.

### Chargeback after vest

When a dispute on a payment settles `LOST` or `CHARGE_REFUNDED` (or `CLOSED` with an amount deducted), `settleLostDispute` calls `voidVestedReferralRewards` in the same transaction. For every `VESTED` referral that payment qualified, the referrer's `REFERRAL_BONUS` credit, and any credit restored from it (`sourceCreditId`), loses its unspent balance through the operator reversal (`reverseCreditBalance`, journal key `referral-reverse:<creditId>`), and any part already spent is absorbed by the platform. A credit with nothing left, because it is spent, reserved by an unpaid checkout or expired, is stamped as reversed anyway, so a later restore lands on a non-spendable row. The referral itself stays `VESTED`. For an expert referral, every fee waiver of that referral with sessions left is set to zero sessions. A replayed verdict finds the credit already reversed and the waivers already at zero, so it changes nothing.

## 5. Fee waivers

A waiver is spent when the payment's earnings are written. `consumeFeeWaiver` picks the live waiver that expires first and decrements `sessionsRemaining` by a conditional update, so two concurrent captures cannot spend the same session. A spent waiver makes the platform fee 0 for that sale, and the stamped `platformFeeBps` becomes 0. The database also enforces that `sessionsRemaining` never goes below 0.

A waiver is refused when the payment carries promotion, either a welcome discount or a referral credit leg. In the other direction, an expert with a live waiver cannot fund promotion, so `resolveCheckoutAttribution` returns no welcome discount and a credit cap of 0 for that expert. A host-organisation seller is treated the same way because the organisation's rate card sets that take, not the stamped basis points.

## 6. Scheduling

Two jobs are registered in `lib/cron/cleanup-registry.ts`. Each has one implementation and a `CRON_SECRET` HTTP twin under `/api/cleanup/[job]`.

| Job                       | Scheduler                                                                                                                   | Limit per run                               | Action                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| `vest-referral-credits`   | The Netlify ticker, every 30 minutes, with a limit of 10 (`netlify/functions/cron-tick.mts`)                                | 50 by default, 10 when called by the ticker | Settles `QUALIFYING` referrals, oldest examined first.          |
| `expire-referral-credits` | The Netlify ticker, hourly in a window that opens at 03:10 UTC on the 1st of each month (`netlify/functions/cron-tick.mts`) | 50 by default, 50 when called by the ticker | Moves expired `VESTED` credits to `EXPIRED` and posts breakage. |

Both jobs hold a Postgres cron lease through `withCronLock` and fail closed if the lease cannot be taken. Failures are collected and reported to Sentry once per run, never per row.

## 7. Configuration and the budget

`ReferralProgramConfig` is a single row with the id `singleton`. The programme is live only when the row is active, not paused, and `monthlyBudgetPaise` is greater than 0. Every credit and referral stores the configuration `version` it was created under, so an edit never rewrites history.

The budget window is a UTC calendar month. The welcome discount is added to the month's spend at capture, and it is metered even if it pushes spend past the budget, because the buyer has already been charged the lower price. A reward or expert-waiver cost is claimed at vest by a conditional update that refuses to exceed the budget. New referees stop being accepted at 90 % of the budget: the apply route refuses and `/api/referrals/code` returns no terms. Referees already in flight are honoured, because checkout attribution still attaches an existing `SIGNED_UP` referral whenever the programme is live, and the 10 % headroom absorbs those discounts while the vest CAS keeps the hard cap for referrer rewards.

## 8. Referral code rules

A user has one code, either generated from the name or random, plus an optional vanity code of 3 to 20 letters and digits. A code accepts at most 25 applies (`maxReferrals`). `applyReferralCode` runs as a Serializable transaction and refuses when any of these hold: the code is unknown or inactive, the code belongs to the applier, the code is full, the programme takes no new referees, the account was created before the qualify window began, the account's email is on a disposable-mail domain (`lib/referrals/disposable-domains.ts`), the account's normalised email equals the referrer's, the account already has a succeeded payment, or the account already has a referral. Normalising lowercases the address, drops a `+tag`, and for `gmail.com` and `googlemail.com` also drops dots. The apply route is rate limited to 3 tries per day per user, and the vanity-code route to 5 tries per hour.

The `ipHash` stored at apply is an HMAC of the middleware-stamped client IP (`stampedClientIp` in `lib/request-ip.ts`) under a key derived from `BETTER_AUTH_SECRET` with its own purpose label (`lib/referrals/signal-hash.ts`). The user agent is kept to 256 characters and stored as sent, not hashed; the privacy policy says so. Neither is shown to the referrer. `referralSignalPruneWhere` (`lib/compliance/signal-retention.ts`) nulls both 180 days after the referral ends, or 180 days after creation for a referral that never settles, and `scrubUser` nulls them on erasure.

## Deprecated & Superseded Approaches

The first version qualified a referral on any successful payment, including ₹1 payments, credit-funded bookings and organisation-sponsored bookings, and it granted both rewards at that moment with no hold and no clawback. It also computed credit expiry only when credits were read and had no budget, so the programme was neither safe nor measurable. The current design replaced it with the capture, hold and vest sequence above.

Residual artifacts to delete when found:

- Any code that grants a `REFERRAL_BONUS` credit as spendable at capture. Capture now creates only `PENDING` credits.
- Any reference to `processQualifyingAction`, a `QUALIFIED` or `REWARDED` referral status, or a 6-month expiry constant.
- Any dashboard that sums `remainingAmount` over all credits without filtering to `VESTED` and not expired.
- The `/r/[code]/page.tsx` landing page. The route is now a route handler that sets a cookie and redirects.
