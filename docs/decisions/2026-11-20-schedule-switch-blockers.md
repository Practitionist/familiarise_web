# ADR: The Weekly/Custom switch is blocked only by bookings that still need the expert's hours

- **Status**: Accepted by the owner on 2026-11-20. Ships in the pull request that adds this record.
- **Date**: 2026-11-20
- **Author**: Platform engineering
- **Related**: [The availability contract](../onboarding/03-availability-contract.md#switching-schedule-type), [The booking follow-up train](2026-11-12-booking-follow-up-train.md)

## Context

Switching between Weekly and Custom hours deletes every row of the old kind, so the settings page refuses the switch while a booking still depends on those hours. `checkActiveAppointments` (`app/api/user/consultants/utils/consultant-appointments.ts`) decides the refusal, and its counts become the sentence on the Availability page ("You have … Complete or cancel them before you switch schedule types.").

The check counted consultations and subscriptions by request status alone (PENDING, APPROVED or APPROVED_PENDING_PAYMENT) and classes by `SCHEDULED` alone. A consultation whose only session was delivered last week, but whose status had not yet moved to COMPLETED, therefore blocked the switch, and so did a class whose sessions had all taken place. The sentence then called these rows "pending consultations" and "upcoming classes", which they were not. QA on a deploy preview read "16 pending consultations" for an expert with 2 sessions ahead.

## Worked example

Read from the shared database on 2026-11-20 with the same filters as the code:

| Expert | Kind          | Counted before | Counted now | Why the difference                                                    |
| ------ | ------------- | -------------- | ----------- | --------------------------------------------------------------------- |
| Hannah | Consultations | 16             | 1           | 15 are APPROVED and paid, but every session of theirs is in the past. |
| Hannah | Classes       | 2              | 2           | Neither has a session placed yet, so both still need hours.           |
| Grace  | Subscriptions | 2              | 2           | Both are paid plans with no session placed yet.                       |
| Grace  | Classes       | 4              | 4           | One has a session ahead; three have no sessions placed yet.           |

Hannah's sentence goes from "You have 16 pending consultations and 2 upcoming classes." to "You have 1 consultation with a session ahead or still to be placed and 2 classes with a session ahead or still to be scheduled." Grace stays locked, with the same counts in words that say what they count.

## Decisions

1. **A booking blocks the switch only while it still needs the expert's hours.** A live session is one that is not deleted and not CANCELLED, RESCHEDULED or VOIDED.
   - A consultation or subscription in PENDING, APPROVED or APPROVED_PENDING_PAYMENT blocks when it has a live session that starts after now, or when it has no live session at all and is approved (APPROVED or APPROVED_PENDING_PAYMENT) or paid (a SUCCEEDED payment). A booking whose live sessions are all in the past does not block, whatever its status.
   - A SCHEDULED class blocks when it has a live session ahead, or when it has no live session at all (it still needs hours to be scheduled). A class whose sessions are all past does not block.
   - Webinars and co-host seats keep their existing filter: a session ahead. Trials (SCHEDULED or AWAITING_PAYMENT) and open reschedule requests are unchanged.
2. **One function, one rule for both reads.** `GET /api/user/consultants/[id]/can-switch-schedule` and the settings PUT's pre-flight and in-transaction re-check all call `checkActiveAppointments(id, db, "scheduleSwitch")`; the re-check passes the transaction's `tx`. A test in the database tier (`__tests__/db/booking/schedule-switch-blockers.db.test.ts`) pins that the route and the transaction read the same answer.
3. **The sentence names what blocks.** Its counts read "N consultations with a session ahead or still to be placed", "N subscriptions with a session ahead or still to be placed" and "N classes with a session ahead or still to be scheduled"; the other kinds keep their words. The `breakdown` object in the route's answer uses neutral keys (`consultations`, `subscriptions`, `webinars`, `classes`, `trials`, `openReschedules`, `collaborations`).
4. **Profile and account deletion keep their rule.** The same function serves the consultant profile DELETE and account erasure. They pass `"removal"` and still count every open booking by status, because a delivered booking that has not completed can still owe settlement. Changing that gate is a separate decision.

## Consequences

- An expert whose delivered bookings have not yet been marked COMPLETED (the completion sweep is paused before launch) can switch schedule type. The delivered sessions are not affected: switching deletes availability rows, never sessions.
- A subscription between plan weeks, with every placed session in the past and later weeks still to place, does not block the switch under this rule. The next week is placed against whichever hours are published then.
- The statement count is unchanged: seven counts in one `Promise.all`; only the consultation, subscription and class filters grow.

## Deprecated & Superseded Approaches

- **Counting by status alone.** Consultations and subscriptions in an open status and classes in SCHEDULED blocked the switch regardless of when their sessions were. Replaced by decision 1 for the switch; the removal callers still use it on purpose (decision 4).
- **"pending consultations", "active subscriptions", "upcoming classes" in the lock sentence.** Replaced by the words in decision 3.
