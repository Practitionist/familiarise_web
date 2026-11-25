# ADR: A booking with a session waiting for an ops decision reads "Waiting on a decision", and auto-complete never completes it

- **Status**: Accepted (2026-11-18, owner); built 2026-11-24.
- **Date**: 2026-11-24
- **Author**: Platform engineering
- **Related**: issue #2844 "Bookings read Completed while their sessions wait for an ops decision (AWAITING_HUMAN)"; [Booking states and demand guidance](2026-11-14-booking-states-and-demand-guidance.md) (the one status function); [Session outcome report window](2026-11-23-session-outcome-report-window.md) (what parks a session); [Booking lifecycle](../booking/06-booking-lifecycle.md)
- **Supersedes**: nothing. It adds one word to the status function and one guard to the completion writes.

## Context

A past session is _parked_ when it matches `AWAITING_HUMAN` in `lib/booking/misses.ts`: it is `UNVERIFIED` and either its outcome is `INCONCLUSIVE` or `HOST_ABSENT`, or it has no outcome and its room was cut by maintenance, or nobody joined (`NOBODY_JOINED`, `OFFLINE`) on a booking with a succeeded payment. The rule beside the predicate says its booking neither completes nor releases earnings until ops decide, and the back office's "Sessions that need a decision" queue says "settlement on hold".

Two things contradicted that rule. The status function (`bookingStatus` in `lib/appointments/booking-status.ts`) read a stored `COMPLETED` as Completed whatever its sessions said, and `isOccurrenceHeld` (`lib/appointments/occurrences.ts`) counted every `UNVERIFIED` session as held, so a live booking whose only session was parked also read Completed in the lists. And auto-complete (`scripts/appointments/auto-complete-appointments.ts`) checked `AWAITING_HUMAN` only in its cohort read; its five completing writes (webinar, class, consultation, subscription, trial) matched by id and status, so a session parked between the read and the write did not stop the completion.

The shared database held 7 bookings stored `COMPLETED` with 16 parked sessions, all "Unverified · Nobody joined" on a paid booking. Their history shows each was completed by `auto-complete` between 29 September and 26 October 2026, after its sessions were parked and before the paid no-join arm joined `AWAITING_HUMAN` on 27 October. They are kept as they are: the seed holds odd cases on purpose, and ops decide each with "Set outcome".

## Decision

1. **A parked session is not held.** `isOccurrenceHeld` returns false for an `UNVERIFIED` session whose outcome is in `PARKED_OUTCOMES` (`INCONCLUSIVE`, `HOST_ABSENT`; the list `AWAITING_HUMAN` itself uses). A paid no-join is still held by this test, which knows nothing of payments; the stage below covers it.
2. **"Waiting on a decision" is the eighth word.** The stage `AWAITING_DECISION` (tone caution) is derived from the fact `parkedSessions`, the booking's number of parked sessions, which every reader computes with the database predicate itself: the `_count` entry `PARKED_SESSIONS_COUNT` in the same statement, or `parkedSessionCounts` (`lib/booking/awaiting-decision.ts`, one `groupBy`) where the read already counts sessions for another reason. The stage wins over:
   - a stored `COMPLETED` booking (not `CONVERTED`);
   - a booking that would read Completed or "We're confirming what happened" because every session is over, except a subscription before its plan end, which stays Confirmed (the lists read the plan end as the page does, with `subscriptionIsOver`);
   - on a read without sessions, a one-session booking (consultation, trial, webinar).

   A host's own webinar or class shows the word too, instead of its event word. The learner and expert read "Our team is checking what happened in a session. This booking settles once they decide."; staff read that the session is in Sessions that need a decision. The booking page offers no "Rate this session" while it waits, its timeline's next step reads "Our team decides what happened" instead of "Completed", and its "N completed" count leaves out the parked sessions (`isCompletedOccurrence` still counts them as held for the entitlement).

   **A live booking keeps its word (owner decision, 2026-11-24).** An active subscription or a scheduled class with sessions still ahead, or before its plan end, keeps its stored word ("Confirmed", or the host's "Scheduled"), because its future sessions are still on. Its parked sessions read "Waiting on a decision" at session level, and the booking names them in its reason line: "2 sessions are waiting on a decision." That line shows under the badge on the learner and expert booking pages, on the list rows that print the reason line, and in the staff drawer. A plan waiting for its next placement keeps its prompt first ("Week done. Schedule the next 2. 2 sessions are waiting on a decision."). The seed's subscription `a253a6cd` is the example: Confirmed, with 2 parked sessions named.

3. **Every completing write repeats the guard.** The five CASes carry `appointment: { occurrences: { none: AWAITING_HUMAN } }` in their WHERE (`NO_PARKED_SESSION`), so a session parked after the cohort read makes the write match zero rows and the booking stays open for the next run. `transitionWebinarEvent` and `transitionClassEvent` take `whereAnd` for this, as `transitionTrial` already did.

   The guard alone does not cover a park that commits while the CAS statement runs: under READ COMMITTED the statement's subquery reads the snapshot taken when it started. So each completion runs under the appointment lock (`appointment-lock:<appointmentId>`) the lifecycle doors take, which the ops outcome door (`overturnSessionOutcome`) holds across its transaction. A park through that door either commits before the CAS starts, so the guard sees it, or waits for the completion to commit. The lock waits at most about 0.9 s (`SWEEP_LOCK_RETRY_CONFIG`); a busy or unreachable lock leaves the booking for the next run. No completion notice is staged unless the CAS moved the row. A Postgres row lock on the sessions was rejected: it would lock sessions before the parent, the opposite of the cancel doors, so a cron and a user request could deadlock. The other writers that park a session, the slot pass and the window-close pass, run inside auto-complete itself, one after the other.

4. **Waiting bookings are not in the staff Completed tab.** `buildStatusWhere("completed")` (`lib/data/staff-appointments.ts`) asks for `occurrences: { none: AWAITING_HUMAN }` on a stored `COMPLETED` row, for the list and its count; a `CONVERTED` trial is completed either way.
5. **No reseed.** Every list and detail view renders the seed's parked bookings with the eighth word.

### Worked example

Priya paid ₹1,500.00 (150000 paise) for a consultation on Monday 23 November 2026, 10:00 to 11:00 IST. Nobody joined, so at 17:15 IST the slot pass parks the session `UNVERIFIED · NOBODY_JOINED`. Before this decision a run of auto-complete that had read the booking before 17:15 would still have written `COMPLETED` at 17:16, and Priya, her expert and the back office would all have read Completed. Now that write matches nothing, and every surface reads "Waiting on a decision" until ops set the outcome. If the same booking had been free, the no-join would not be parked, it completes as before and reads Completed.

## Where it is enforced

- `bookingStatus` and `isOccurrenceHeld`, pinned by `__tests__/appointments/booking-status-surfaces.test.ts`.
- The booking page's count and timeline step, and the live-booking line on the learner list, booking page and staff drawer, pinned through the real readers by `__tests__/db/booking/awaiting-decision.db.test.ts`.
- The parked count adds no statement to the booking-page read: it is a `LEFT JOIN LATERAL` inside the one joined statement, and on the shared data it runs in about 0.25 ms on four index scans.
- The readers: `lib/data/consultant-appointments.ts`, `lib/data/consultee-events-read.ts`, `app/api/trials/route.ts`, `lib/data/appointment-detail.ts`, `lib/api/scope/list-appointments.ts`, `lib/data/staff-appointments.ts`, `lib/support/case-workspace.ts`; pinned through their real output on Postgres by `__tests__/db/booking/awaiting-decision.db.test.ts`.
- The five CASes and the appointment lock around them, pinned by the same database suite: a park through the ops door, uncommitted while auto-complete reads, keeps a consultation and a webinar open and stages no completion notice.
- The staff Completed tab and its count, pinned by the same database suite.

## Not decided here

The other two writers already refuse a parked session and are unchanged: the plan-end completion in `scripts/appointments/settle-cancelled-sessions.ts` counts `AWAITING_HUMAN` sessions inside its transaction and waits, and `release-earnings` (`scripts/earnings/release-earnings.ts`) keeps an earning `PENDING` while its appointment has one. The seed's 7 bookings were completed by auto-complete before the paid no-join arm existed; whether their earnings released is for ops to read row by row.

## Deprecated & Superseded Approaches

Before this record the status function had seven words, and `isOccurrenceHeld` treated any recorded outcome, a parked one included, as held. Auto-complete guarded parked sessions in its cohort read only.
