# ADR: A learner and an expert keep every trial they had; at most one holds the pair

- **Status**: Accepted by the owner on 2026-11-15 (option 2 of the issue "Re-requesting a trial deletes the earlier trial record and leaves its booking with no trial"). Ships in the pull request that adds this record; the database half waits for the owner's schema push.
- **Date**: 2026-11-15
- **Author**: Platform engineering
- **Related**: [Trial sessions](../booking/09-trials.md), [Booking state machines](../booking/18-state-machines.md), [Prisma and the live database](../prisma/README.md), [One target lifecycle per product](2026-11-13-product-lifecycles.md)

## Context

A learner may ask an expert for a trial again once the earlier one was cancelled or lapsed unpaid. Until this change the `Trial` table allowed one row per (learner, expert) pair (`@@unique([consulteeProfileId, consultantProfileId])`), so `POST /api/trials` deleted the earlier, cancelled row before it inserted the new one. The earlier trial's booking (its `Appointment`, its sessions, and for a paid trial its `Payment`) stayed behind with no trial attached. The back office could only label it "Trial (record removed)", and support could no longer trace who booked it, when, and at what price.

## Worked example

Learner X requests a paid ₹499 trial with expert Y for Tuesday 10:00. X does not pay, and the expire-unpaid-trials sweep cancels the hold on Monday.

| Moment                                | `Trial` rows for (X, Y)                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| X's first request                     | T1 `AWAITING_PAYMENT`, linked to appointment A1                                          |
| The pay window lapses                 | T1 `CANCELLED`, still linked to A1 (its session tombstoned, its unpaid order expired)    |
| X requests again for Thursday         | T1 `CANCELLED` with A1, untouched; T2 `AWAITING_PAYMENT`, linked to a new appointment A2 |
| X tries a third time while T2 is open | Refused with 409 `TRIAL_ALREADY_REQUESTED`, as before; no row is written                 |

Before this change the Thursday request deleted T1, and A1 became a booking with no trial.

## Decisions

1. **Keep every trial record (option 2).** A pair may hold any number of `Trial` rows. A new request never deletes, resets or edits an earlier trial: its status, appointment link, payment and price stay as they were. The table carries a plain `@@index([consulteeProfileId, consultantProfileId])` in place of the unique.

2. **At most one trial holds the pair, enforced by Postgres.** Every `TrialStatus` is classified, and the classification is the one the request door already used (`TRIAL_REQUEST_BLOCKING_STATUSES` and `TRIAL_REQUEST_FREEING_STATUSES` in `lib/trials/eligibility.ts`):

   | Status             | Holds the pair? | Why                                                     |
   | ------------------ | --------------- | ------------------------------------------------------- |
   | `AWAITING_PAYMENT` | Yes (live)      | A paid trial holding its time while its pay window runs |
   | `SCHEDULED`        | Yes (live)      | Confirmed and upcoming                                  |
   | `COMPLETED`        | Yes (delivered) | The trial was given: the real one-per-pair rule         |
   | `CONVERTED`        | Yes (delivered) | Given, and the learner subscribed                       |
   | `CANCELLED`        | No (ended)      | The learner never received a trial                      |

   "Live" in the owner's wording is the set that blocks a new request, which includes a delivered trial: narrowing it to `AWAITING_PAYMENT` and `SCHEDULED` would let a learner take a second trial after a delivered one, a product rule this decision does not change. `CANCELLED` is terminal in the trial state machine (`TRIAL_ALLOWED_FROM` in `lib/booking/transitions.ts` has no edge out of it), so a row can only enter the holding set at insert, never by a transition.
   - **Enforced by** the partial unique index `trial_one_blocking_per_pair_key` in `prisma/sql/check-constraints.sql`, over the pair `WHERE status IN ('AWAITING_PAYMENT', 'SCHEDULED', 'COMPLETED', 'CONVERTED')`. The request door reads the pair's holding trial first and refuses with 409 `TRIAL_ALREADY_REQUESTED`; when two requests for the same pair race past that read, the loser's insert hits the index and the route answers the same 409 (`isUniqueViolationOn` with the index name). `__tests__/db/booking/trial-history.db.test.ts` runs every status against the index.

3. **Readers name the trial they mean.** A reader that asks "may this pair book a trial" reads the pair's holding trial (status in the blocking set); a reader that shows history reads every row or the latest by `requestedAt`. No reader looks a trial up by the pair alone.

4. **No backfill.** A booking whose trial was deleted before this change keeps the "Trial (record removed)" label in the back office. Nothing re-creates the lost rows (doctrine: no backfill migrations).

## Options not chosen

- **(1) Reset the earlier row in place.** Keeps one row per pair, but the reset overwrites the earlier trial's status, appointment link, payment and price, so its history has to move into an activity or history record that every reader then has to join. The earlier booking would still point at a trial that now describes a different booking.
- **(3) Keep deleting, after copying the earlier trial's facts into a log.** Leaves the earlier `Appointment` with no `Trial`, which is the defect; the log would be a second, weaker copy of a row the database could simply keep.
- **Refuse any second trial ever.** Moves `CANCELLED` into the blocking set and makes a trial one-shot. A learner whose expert cancelled, or whose hold lapsed unpaid, never received a trial, and the request door has always let them ask again.
- **Accept the orphan.** The "Trial (record removed)" label already shipped; it names the loss but does not stop it, and it repeats each time a learner asks again.

## Consequences

- A pair's trials read as a history. Counts of a learner's or an expert's active trials are unchanged, because at most one row per pair is active.
- The schema change drops a unique index, so the owner's push needs that statement in `destructiveStatementsAllowed` (`prisma/sql/known-drift.json`) and the sidecar index applied straight after. Until the push, the live database still carries the old unique, and a request after a cancelled trial is refused by it with the same 409 instead of creating a second row.
- Before the push, the read-only check in the pull request confirms that no pair already holds two blocking trials, which would make the index fail to build.

## Deprecated & Superseded Approaches

- **`@@unique([consulteeProfileId, consultantProfileId])` with a delete on re-request.** One row per pair; the request door deleted a cancelled row so the insert could pass the unique, and the earlier booking lost its trial. Replaced by decisions 1 and 2.
