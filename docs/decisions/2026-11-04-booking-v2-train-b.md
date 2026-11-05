# ADR: Booking v2 train B: Regular time, rolling horizon, plan-end choice and frozen plan terms

- **Status**: Accepted on 2026-11-04 by the owner. Built across the train-B pull requests. An item marked **(planned)** is not built yet; the pull request that builds it removes the marker and links itself, as decision 10 does.
- **Date**: 2026-11-04
- **Author**: Platform engineering
- **Related**: [Booking v2 direction](2026-11-03-booking-v2-direction.md), [V2A appendix C](../booking/research/04-v2a-appendix-c-allocation-multiweek-naming.md), issues [#2561](https://github.com/Practitionist/familiarise_web/issues/2561), [#2568](https://github.com/Practitionist/familiarise_web/issues/2568), [#2563](https://github.com/Practitionist/familiarise_web/issues/2563), [#2464](https://github.com/Practitionist/familiarise_web/issues/2464), [#1743](https://github.com/Practitionist/familiarise_web/issues/1743), [#2577](https://github.com/Practitionist/familiarise_web/issues/2577), [#2578](https://github.com/Practitionist/familiarise_web/issues/2578), handoff [#2574](https://github.com/Practitionist/familiarise_web/issues/2574)

## Context

Phase 0 (the booking v2 correctness pull request) moved 1:1 plans to calendar plan weeks and added consultant week reminders, but a consultant still places every week by hand or with a one-tap Auto. A re-check of `dev` at f681d1bba on 2026-11-04 found:

- The plan-end settlement already refunds every undelivered session pro rata (`settleEndedPlan`, `planEndMarker` in `scripts/appointments/settle-cancelled-sessions.ts`, key `plan-end:<subscription>:pay:<payment>`), and a learner no-show already counts as delivered (`LEARNER_ABSENT` → `COMPLETED`).
- The ADMIN class-wide cancel already exists (`app/api/admin/class-series/[classId]/cancel-series`, surface `classSeries.money`, `ADMIN_ONLY`).
- **Two defects.** (1) The earnings release (`RELEASABLE_PAYMENT`, `scripts/earnings/release-earnings.ts`) waits only for a `PENDING` Refund row, not for an owed refund marker (`Payment.refundOwedKey`), so a plan-end refund that keeps failing can let the host's earnings go out. (2) A plan edit (`PATCH /api/plans/subscriptions/[id]`) changes the weekly cap and the session length of subscriptions already sold, because only `sessionsTotal` is frozen at purchase.

## Decisions

1. **Regular time** (planned). The consultant sets one weekly pattern per 1:1 plan (weekday + local start, in the plan's zone), mobile-first. The client is told; no consent step. An edit applies only to plan weeks not yet placed (`validFrom`/`validUntil` versioning, `createdByUserId`). Starts that fall off the UTC half-hour lattice (for example 09:00 in Kathmandu) are refused when set. Classes keep their host-set series.
2. **Rolling horizon** (planned). An hourly registry job keeps the next 4 plan weeks of real sessions placed for every plan that has a Regular time. Setting one is the consultant's consent to automatic placement; plans without one keep the Phase 0 behaviour. It uses the Postgres lease, fair rotation (`lastRolledAt`), a start deadline and Sentry once per run. It places through the allocator's normal commit path (slot locks, the EXCLUDE constraint). A lost race is not an error: the slot shows on the conflict list. Setting a Regular time places only the current week in the request; the job fills the rest.
3. **Conflict list, derived on read** (planned). For each horizon week: Regular-time slots with no session (taken by another booking, outside hours, too soon, past the plan end), plus placed sessions now outside availability. There is no table, so nothing drifts. Time off or an availability shrink over a placed session is never refused and never moves a confirmed session; it is listed. It counts as a consultant-caused miss only if it is still unresolved when its start passes.
4. **Catch-up** (planned). While a plan has a backlog, a week may hold one session more than `sessionsPerWeek` (still at most one a day), inside the plan end. A placed session still unresolved when its plan week ends becomes missed and joins that backlog to be caught up. Alternatives are in [#2577](https://github.com/Practitionist/familiarise_web/issues/2577).
5. **Pause** (planned). After 3 consecutive plan weeks with nothing placed, the plan's roll-forward pauses (`rollPausedAt`), both sides are told, and the consultant must re-confirm the Regular time.
6. **Plan length in weeks.** New plans choose `durationInWeeks` (1–52; presets 4, 8, 12, 26, 52). The price stays the plan price, and sessions = weeks × sessions a week. Existing plans keep months, with no backfill (built in [#2588](https://github.com/Practitionist/familiarise_web/pull/2588)).
7. **Frozen purchase terms.** `Subscription.sessionsPerWeek` and `sessionMinutes` are stamped at purchase (null = read the plan, for rows sold before). Plan edits apply to new buyers only: an edit stamps those older rows from the plan before it changes (built in [#2588](https://github.com/Practitionist/familiarise_web/pull/2588)).
8. **Missed sessions and support refunds.**
   - **"Missed" is derived; no mid-plan auto refund** (current). Money for 1:1 plans moves at plan end (decision 9), or **through support** when an expert or the platform fails badly. Support can cancel through the platform cancel door (100% of unheld sessions) or refund part of the plan through the refund review door. The dedicated support flow is P2 ([#2578](https://github.com/Practitionist/familiarise_web/issues/2578)).
   - **A partial refund of k sessions removes k sessions from the plan.** `Subscription.sessionsRefunded` records them, so the plan-end formula stays exact and the expert never delivers a session whose earnings were already reversed. Staff enter k on the refund recommendation; the amount is `min(floor(paid × k / sessions sold), refundable)` and the approval removes the sessions in the same commit (built in [#2588](https://github.com/Practitionist/familiarise_web/pull/2588)).
9. **Plan-end choice** (planned). It is offered when a plan ends with host- or system-caused unused sessions (voided, never placed, returned and not replaced), and it waits while a session is parked for ops or a reschedule is open, as the settlement already does. The plan stays live with an `OFFERED` `PlanEndChoice`, and the settlement skips it.
   - The learner picks "Add N extra weeks" (N = ceil(unused / sessions a week), at most 4). This is offered only when the roll-forward can place those weeks in the expert's hours.
   - Or the learner picks "Refund the unused sessions". No answer within 7 days means a refund.
   - The expert can tap "Can't do these weeks" until the first extra session starts, which restores the plan end and refunds.
   - One extension per plan, stacking on top of session returns (≤ 2 × 7 days). Anything still unused at the extended end is refunded with no second choice.
   - No extension is offered when a renewal is paid or pending.
   - The refund follows the payment rail (an org-funded plan refunds the org). A partly used credit-funded plan goes to a human, as today.
   - Refunds and timeouts run the existing settlement unchanged.
   - One `extendPlan()` door serves the plan-end choice and, later, the support make-up remedy.
10. **Earnings wait for owed refunds.** The release requires no owed refund marker on the payment: `RELEASABLE_PAYMENT` requires `refundOwedKey: null`, so a marker still retrying, or spent and waiting on support, holds every earning on the payment until a drive or a hand refund clears it (built in [#2579](https://github.com/Practitionist/familiarise_web/pull/2579)). While a plan-end choice is open, the unused sessions' tranches stay unmatured (planned).
11. **Long-class exit right.** A learner may leave a class with a refund of the sessions not yet held after 3 host misses in any rolling 30 days, or total misses ≥ max(3, 15% of N) (`exitRightFor`; 12 sessions → 3, 100 → 15). "Any 30 days" means any window in the class's history, not the last 30 days. Misses only accumulate, so the right does not lapse with time; the one exception is an ops correction (an un-void, or a relabel of a miss that was not the host's fault), which can withdraw a right the learner has not used yet. Once the learner has left with the refund, it is final. A whole-event cancel commits only if it owns every seat's refund marker: a seat whose payment owes another door's refund refuses the cancel with 409 `REFUND_IN_PROGRESS` / `REFUND_NEEDS_SUPPORT`, and a door that proceeds after losing the stamp holds the payment's earnings (`OPERATOR`) and lists the hand top-up for ops (built in [#2587](https://github.com/Practitionist/familiarise_web/pull/2587)).

### Refund math (example: ₹15,600 for 26 weeks × 3 = 78 sessions, ₹200 each)

| Case                                             | Calculation                                    | Refund                               |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------ |
| Plan end: 70 delivered, 8 unused                 | floor(15,600 × 8 / 78)                         | ₹1,600, or 3 extra weeks             |
| Extension taken, 6 of 8 delivered                | floor(15,600 × 2 / 78)                         | ₹400 (automatic)                     |
| Support refunds 9 missed sessions in week 10     | floor(15,600 × 9 / 78); `sessionsRefunded` = 9 | ₹1,800                               |
| … then plan end with 61 delivered                | floor(15,600 × 17 / 78) − 1,800                | ₹1,600                               |
| Support platform cancel in week 10, 27 delivered | floor(15,600 × 51 / 78)                        | ₹10,200 (ADMIN, above the STAFF cap) |

Rows 3 and 4 rely on `sessionsRefunded` (decision 8). The platform absorbs the gateway fee; each refund reverses earnings and discount pro rata and mints a GST credit note.

## Alternatives considered

- **Catch-up:** grace weeks after the plan, no mid-plan catch-up, uncapped catch-up ([#2577](https://github.com/Practitionist/familiarise_web/issues/2577)).
- **Missed weeks:** a stored `missedSessions` counter and a mid-plan "Refund now / Keep" offer every week (research C-04). Rejected: the count drifts, and the owner chose catch-up plus plan-end settlement plus support.
- **Expert step:** a 48-hour pending decline, or an explicit accept. Rejected: offering only placeable weeks plus "Can't do these weeks" gives the same outcome with no timer state.
- **Plan state during the choice:** completing the plan and creating a continuation subscription. Rejected: two plans for one purchase.
- **Renewal overlap:** shifting a renewal's start by the extension. Rejected: it moves a paid product's dates.
- **Org-sponsored plans:** an automatic refund to the org, or the org operator chooses. Rejected: the learner uses the sessions; the money still returns to the payer.
- **Regular time consent:** the client must accept (#1908's proposal aggregate). Not built now: it conflicts with the no-flags rule.
- **Conflicts:** a stored `PlanWeekConflict` table. Rejected: derived state cannot drift. Refusing time off over a booking (#2210 D-C3) was rejected for 1:1 plans.
- **Partial refunds:** goodwill money with the entitlement unchanged (the expert loses earnings for sessions they still deliver), or no partial refunds on plans.

## Not built (and why)

- `planStartsAt` @map rename: churn with no behaviour change; moved to the reset batch (#2210).
- Self-pick inside the Regular time: expert opt-in; wait for demand.
- In-app credit instead of cash (#1828): deferred; the choice is an enum, so a credit option can be added later.
- A blackout table: availability edits plus the conflict list cover it.

## Consequences

- A consultant sets times once per plan; the job keeps four weeks booked and asks only about conflicts.
- Plan edits no longer change what existing clients bought.
- Clients with unused sessions at plan end choose more time or money; experts never lose earnings for sessions they deliver.

## Deprecated & Superseded Approaches

- **Placing every plan week by hand or with a weekly one-tap Auto as the only path.** It remains for plans without a Regular time.
- **Research C-04's mid-plan refund offer and stored missed counter.** Superseded by decision 8.
