# Booking State Machines — Generated Reference

> **Generated from `lib/booking/transitions.ts`** (PR 2d, train #1169).
> The maps in that file are the single source of legality; this page is a
> human-readable projection. If the code and this table disagree, THE CODE
> WINS — fix the doc in the same PR as the map change.

## Request-status events (Consultation, Subscription)

`AppointmentStatus`, guarded by `REQUEST_ALLOWED_FROM`. Every write MUST go
through `transitionConsultationRequest` / `transitionSubscriptionRequest`
(doctrine rule 1); a miss rolls back / matches zero rows instead of
corrupting state.

The table below is `REQUEST_ALLOWED_FROM`, row by target state and column by the state the row must currently be in. A plan (`Subscription`) is guarded by the narrower `SUBSCRIPTION_ALLOWED_FROM` described after it.

| To ↓ From →                  | PENDING                                         | APPROVED                                                     | APPROVED_PENDING_PAYMENT                                                                                                                                                                             | COMPLETED | REJECTED | CANCELLED | EXPIRED |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------- | --------- | ------- |
| **PENDING**                  |                                                 |                                                              | ✓                                                                                                                                                                                                    |           |          |           |         |
| **APPROVED**                 | ✓                                               | ✓ self-edge only via `fromIn` (`ALLOCATION_APPROVABLE_FROM`) | ✓                                                                                                                                                                                                    |           |          |           |         |
| **APPROVED_PENDING_PAYMENT** | ✓                                               | ✓                                                            |                                                                                                                                                                                                      |           |          |           |         |
| **COMPLETED**                |                                                 | ✓                                                            |                                                                                                                                                                                                      |           |          |           |         |
| **REJECTED**                 | ✓                                               |                                                              | ✓                                                                                                                                                                                                    |           |          |           |         |
| **CANCELLED**                | ✓                                               | ✓                                                            | ✓                                                                                                                                                                                                    |           |          |           |         |
| **EXPIRED**                  | ✓ (48 h consultation / 30 d subscription sweep) | ✓ (PR 2c: APPROVED-unallocated cohort)                       | ✓ (the 24 h pay-link sweep with a consultee notice; the 7 d `updatedAt` fallback in `expirePaymentPendingRequests`; and since #1775 the consultant's own Withdraw, reason `WITHDRAWN_BY_CONSULTANT`) |           |          |           |         |

The `APPROVED_PENDING_PAYMENT → EXPIRED` edge has three writers that share one body since #1775: the 24 h pay-link sweep, the 7-day fallback and the consultant-initiated Withdraw all go through `lapseApprovedRequest` in `lib/booking/lapse-approved-request.ts`, which writes the history row with reason `PAYMENT_LAPSED` or `WITHDRAWN_BY_CONSULTANT`, keeps the money predicate in the CAS WHERE, tombstones the open PENDING order and releases the tentative holds by status. Two rows deserve a note. `PENDING` is reachable only from `APPROVED_PENDING_PAYMENT` in the map; the reschedule route's move to `PENDING` goes through `transitionConsultationRequest` with `fromIn` pinned to the status it read. There is no `SCHEDULED` request status: a consultation is `APPROVED` from capture or approval until it completes. The incident rebook (`reopenBooking` in `lib/booking/incident-rebook.ts`) moves a `COMPLETED` consultation whose session a declared platform incident voided back to `APPROVED` with `fromIn: [COMPLETED]`.

A plan is paid at checkout, so it never awaits payment and never enters `SCHEDULED`. `transitionSubscriptionRequest` guards with `SUBSCRIPTION_ALLOWED_FROM`, which has no edge into or out of either status: `PENDING` (paid, waiting for cycle 1) moves to `APPROVED` (placed), `REJECTED` (declined), `CANCELLED` or `EXPIRED`; `APPROVED` moves to `COMPLETED`, `CANCELLED` or `EXPIRED`. The helper also refuses `to: SCHEDULED` when a caller widens `fromIn`. `LIVE_SUBSCRIPTION_STATUSES` is `PENDING` and `APPROVED`. The detail PATCH accepts only `APPROVED` and `REJECTED` and refuses an unpaid plan with `409 SUBSCRIPTION_UNPAID`, as does the allocate path. A paid plan has one extra `PENDING → EXPIRED` writer, `expireUnallocatedPaidSubscriptions`, which fires 48 hours after the capture when no session has been allocated and records the history reason `UNALLOCATED_48H`; the 30-day `PENDING` arm skips paid rows so the two arms never share one.

### Subscription entitlement and fill-order cycles (#1766)

A subscription's request status does not move between cycles. The row stays `APPROVED` from its first allocation until the last delivered session, and what advances is a derived counter, not a column. `Subscription.sessionsTotal` is snapshotted from the plan at purchase, exactly as `Payment.amount` is, so a consultant editing the plan afterwards never changes what a buyer paid for; a pre-#1766 row with a null snapshot resolves through `plan.totalSessions`. The weekly cap and the session length are frozen the same way (`Subscription.sessionsPerWeek`, `sessionMinutes`; null on rows sold before the freeze, which read the plan through `soldTermsOf`). Everything else is computed by one pure helper, `subscriptionEntitlement` in `lib/booking/entitlement.ts`, from the wrapper's live occurrence rows: `total` is the schedulable count (`sessionsTotal − sessionsRefunded`, the sessions a support partial refund removed), `completed` is the count of COMPLETED and UNVERIFIED rows, `scheduled` the count of non-tentative SCHEDULED rows, `held` their sum and `remaining` `total` minus `held`. There is no consumed counter and no per-surface arithmetic.

Cycles are fill-order tranches rather than calendar buckets. The capacity of a cycle is the plan's `sessionsPerWeek` (the month arm only exists for a hand-zeroed plan), the plan holds `ceil(total / capacity)` cycles with a possibly short last one, and the cycle being filled is `floor(completed / capacity)`. The allocator accepts exactly `nextBatch = min(capacity of this cycle − sessions already filled into it, remaining)` sessions, so a fresh 12-session plan at four a week asks for 4, asks for 0 once those 4 are placed, asks for 4 again once they are delivered, tops up 2 when only 2 were placed, and asks for 1 when one delivered session is later corrected to CANCELLED. Because ranking is by delivered count, a reschedule across a calendar boundary changes nothing, and a future cycle can never be pre-scheduled because the allocator only ever accepts `nextBatch`. The window a batch may be placed in starts at the latest of the stored start, the last held session's end and now, and runs one cycle in the subscription's `schedulingTimezone`; checkout persists the first cycle only, through the same `firstCycleWindow` arithmetic.

Two consequences follow for the maps above. The `APPROVED` self-edge is what every subsequent cycle's allocation takes, and `COMPLETED` is reached only when `remaining` is zero: the auto-complete sweep reads the entitlement and leaves a plan with sessions left `APPROVED`, the two expiry sweeps skip any plan holding one delivered session, and the consultee is told a cycle closed through the `subscription-renewed` outbox row staged in the completing transaction and deduped on `sub:<id>:cycle:<n>`.

Special sets:

- `ALLOCATION_APPROVABLE_FROM = [PENDING, APPROVED_PENDING_PAYMENT, APPROVED]`
  — allocation re-stamps APPROVED with the self-edge legal there only; for a plan only `PENDING` and `APPROVED` can occur.
- The sponsoring-organisation allocate route passes `approvableFrom: [APPROVED]` to the allocator, which narrows the approval compare-and-swap for that call only. `ALLOCATION_APPROVABLE_FROM` itself is unchanged, so a sponsor can place times on a booking the expert has already approved but can never move a `PENDING` or `APPROVED_PENDING_PAYMENT` request to `APPROVED`. The host allocate route (`lib/scheduling/allocate-route.ts`) refuses a caller who is not the expert, a host-organisation operator or staff with 403 `ALLOCATE_FORBIDDEN`, so a consultee can no longer approve their own request.
- `RESCHEDULABLE_FROM = [PENDING, APPROVED, APPROVED_PENDING_PAYMENT]` — which bookings may open a reschedule.
- `CANCELLABLE_FROM = REQUEST_ALLOWED_FROM.CANCELLED`.

## Event lifecycle (Webinar, Class)

`EVENT_ALLOWED_FROM` / `CLASS_EVENT_ALLOWED_FROM` (identical maps), via
`transitionWebinarEvent` / `transitionClassEvent`:

| To ↓ From →   | DRAFT                                                              | SCHEDULED                       | COMPLETED | CANCELLED |
| ------------- | ------------------------------------------------------------------ | ------------------------------- | --------- | --------- |
| **SCHEDULED** | — (publishing is its own edge: `EVENT_PUBLISHABLE_FROM = [DRAFT]`) | ✓ self (re-allocation re-stamp) |           |           |
| **COMPLETED** |                                                                    | ✓                               |           |           |
| **CANCELLED** | ✓ (a draft with placed sessions is cancellable)                    | ✓                               |           |           |

A published event stays `SCHEDULED` while its sessions run, and the auto-complete pass moves it to `COMPLETED` once every session ended more than an hour ago.

DRAFT keeps its status through allocation (B2/#1060): "add a session, then
publish" is the editor flow. A draft is cancellable (`DRAFT → CANCELLED`) so a host with placed sessions is never stuck with it; `SCHEDULED` stays unreachable from `DRAFT` except by publishing, because a reschedule re-stamp must never publish an offering as a side effect.

No route other than the transition helpers writes an event status after creation. The `crud-with-plan` create body accepts `status` only as `DRAFT` or `SCHEDULED` (`EventEditorStatusSchema` in `schemas/event-instance.ts`); the webinar and class `PUT` bodies are parsed by a Zod schema in the same file, and a body carrying `status` is refused with 409 `USE_CANCEL_ROUTE`, so cancelling always goes through the cancel route, which refunds and writes history. The allocator's own status writes go through `transitionWebinarEvent` and `transitionClassEvent`, which write history rows.

## Class batch enrolment (#1819)

A class batch's enrolment state is derived, not stored, by `classEnrolmentFrom` in `lib/booking/class-enrolment.ts`. The derivation counts the sessions that have started (a live row whose start has passed, excluding rows released for rescheduling and cancelled rows whose make-up is still ahead), and `remaining` is the plan's `totalSessions` minus that count. The batch is open while `remaining` is above zero and the next session's ordinal (`totalSessions − remaining + 1`) is at most the host's cutoff, `lateJoinUntilSession`, which defaults to 1. Otherwise the batch is closed, and a batch with no live sessions at all is unscheduled. Checkout evaluates this twice, once when it prices the order and again inside the booking transaction, and a change in `remaining` between the two refuses with the typed 409 `CLASS_PRICE_CHANGED` so the buyer re-checks out at the new price.

## Trials

`TrialStatus` has five values, guarded by `TRIAL_ALLOWED_FROM` through `transitionTrial`:

| To ↓ From →   | AWAITING_PAYMENT | SCHEDULED | COMPLETED |
| ------------- | ---------------- | --------- | --------- |
| **SCHEDULED** | ✓ (capture)      |           |           |
| **COMPLETED** |                  | ✓         |           |
| **CONVERTED** |                  |           | ✓         |
| **CANCELLED** | ✓                | ✓         |           |

The learner picks the time at request and the expert is never asked: `bookTrialInTx` (`lib/trials/book-trial.ts`) creates the row directly in its final state with one creation history row, `SCHEDULED` with a confirmed session for a free trial, or `AWAITING_PAYMENT` with a tentative session and a `paymentDueAt` 15 minutes before the start at the latest for a paid one. `AWAITING_PAYMENT` therefore has no edge into it. The capture webhook moves `AWAITING_PAYMENT → SCHEDULED`. A reschedule leaves the trial `SCHEDULED` and moves only its session (a booking with a live `PENDING` payment cannot be rescheduled, 409 `PAY_LINK_LIVE`). Every door that ends a held trial (`DELETE`, the `PATCH` cancel, the expire-unpaid-trials sweep) expires its `PENDING` payment in the same transaction before the trial moves; the `PATCH` cancels only an unpaid trial, and trial `DELETE` is the one door from `SCHEDULED` to `CANCELLED`. An unpaid trial past its pay window moves `AWAITING_PAYMENT → CANCELLED` with `paymentId` null repeated in the CAS WHERE, and no money moves.

## Class sessions the host cancels (#1780 row 4)

A class session is one `AppointmentOccurrence` row, and since #1780 the host may cancel just one of them. `POST /api/appointments/[id]/occurrences/[occurrenceId]/cancel` moves a future `SCHEDULED` session to `CANCELLED` through `transitionOccurrenceCompletion` (`fromIn: [SCHEDULED]`, reason `HOST_CANCELLED_SESSION`) and stamps `hostCancelledAt`, but never `deletedAt`, so the session stays countable. The host then has 14 days: a make-up is a new occurrence with the same ordinal that must be held by the fourteenth day, and the partial unique on live ordinals makes a second make-up impossible. If no make-up exists when the 14 days are up, the `settle-cancelled-sessions` sweep refunds every seat that held the session one unit under the key `occ:<occurrence>:pay:<payment>` and stamps `seatsSettledAt`; a learner who cannot attend a make-up may take the same unit back earlier under the same key, so the two paths never both refund it.

Every host-cancelled session counts as a miss, made up or not, and since #1569 so does every voided session (see "Session outcomes" below). The exit right (`exitRightFor` in `lib/booking/class-series.ts`) opens at 3 host misses (a host cancellation, or a `CUT_SHORT` or `HOST_ABSENT` void, dated by its `hostCancelledAt` or `voidedAt`) inside any rolling 30 days, or once total misses reach max(3, ceil(15 % of N)): 3 for a 12-session class, 15 for a 100-session one. The window is any 30 days in the class's history, not the last 30 days. Misses only accumulate, so the right does not lapse with time; the one exception is an ops correction (an un-void, or a relabel of a miss that was not the host's fault), which can withdraw a right the learner has not used yet. Once the learner has left with the refund, it is final. A learner holding a seat may then leave with every undelivered session refunded at 100 %, through `DELETE /api/participants/class/[classId]?mode=exit`, which recomputes the ledger inside its transaction and refuses with `EXIT_NOT_AVAILABLE` without the right. Delivered sessions are never clawed back.

The reliability flag is not a once-ever write. Since #1569 only a host-attributed miss can raise it: a host cancellation, or a void whose outcome is `CUT_SHORT` or `HOST_ABSENT`. The flag uses the exit-right rule over host misses alone (`reliabilityThresholdMet`). A `PLATFORM_OUTAGE` void still counts toward the learner's exit-right total but never toward the 30-day window or the flag. `reliabilityFlagDue` (`lib/booking/class-sessions.ts`) reads the latest `class-reliability:<classId>` `SystemEvent` and asks whether it is due: never flagged, due; an active flag (the latest event is not a cleared one), not due; a flag an operator has cleared through the ops door, due again only once a further host-attributed miss lands after that clear. Every host-attributed miss past the threshold re-runs this check, whether a host cancellation or a `CUT_SHORT` or `HOST_ABSENT` void (including an ops relabel to one), so a class can flag, get cleared from the money console, and flag again on new misses. The learners' exit-right notification bell, by contrast, still goes out exactly once — on the miss (a host cancellation, a void, or an ops relabel that blames an existing void on the host) that first trips the rule — regardless of how many times the flag itself is later written. `seriesLedgerAfterMiss` takes the class wrapper's row lock (`SELECT … FOR NO KEY UPDATE` on its `Appointment`: it conflicts with itself but not with the key-share lock each miss's history row takes through its foreign key, so concurrent misses queue instead of deadlocking) and reads the ledger with and without that one miss, so the first trip is exact whichever half of the rule trips, and a host cancel and an outcome sweep landing together cannot both send the bell and the email.

## Session outcomes (#1569)

Every past session that the outcome pass decides receives exactly one automatic verdict, written by one job, and ops may later override it through `session.set-outcome`. A consultation deferred as `HOST_ABSENT` before the no-show handoff is the exception: at the handoff `detect-consultant-no-shows` can still claim it, cancel it and refund it before the pass persists `UNVERIFIED`, so that booking ends through the no-show path instead of a stored verdict. The `auto-complete-appointments` slot pass (every 30 minutes) reads each `SCHEDULED` session whose booked end is more than an hour old, passes its `MeetingPresence` intervals, its host side (the plan's consultant plus every accepted collaborator), the Stream call report and any maintenance window or declared incident (`readOutageWindows()`, each window tagged `source`) to `classifySessionOutcome` (`lib/booking/session-outcome.ts`), and writes the result through `transitionOccurrenceCompletion` with `fromIn: [SCHEDULED]` and `voidedAt: null` in the WHERE. The Stream end webhooks and the orphan reconciler only stamp `Meeting.endedAt` and `endedReason`; neither completes a session any more. An end stamp's close of an open presence interval is marked `closedByEnd` as an assumption, so before classifying, the pass replaces each assumed or open interval with the leave in Stream's participant sessions, and adds any device stay Stream saw that we never recorded (ADR-06 in `docs/stream/18-architecture-decision-records.md`).

The verdict decides the completion status. The table below lists every outcome and the status it writes.

| Outcome           | Status       | Meaning                                                                                                                                                                                                                                                         |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HELD`            | `COMPLETED`  | Both sides were present and the void rule did not fire.                                                                                                                                                                                                         |
| `LEARNER_ABSENT`  | `COMPLETED`  | The host was present and no learner joined; the session is forfeit and no money moves.                                                                                                                                                                          |
| `CUT_SHORT`       | `VOIDED`     | The host side dropped while learners stayed, for at least min(15, booked / 2) minutes.                                                                                                                                                                          |
| `PLATFORM_OUTAGE` | `VOIDED`     | The session overlaps an ops-declared incident window, or everyone dropped within two minutes of each other, or the minutes lost overlap maintenance and outweigh the host's own loss.                                                                           |
| `HOST_ABSENT`     | `VOIDED`     | A learner waited and no host-side person ever joined.                                                                                                                                                                                                           |
| `NOBODY_JOINED`   | `UNVERIFIED` | A call exists, nobody has a presence interval, and Stream's participant sessions show nobody either.                                                                                                                                                            |
| `INCONCLUSIVE`    | `UNVERIFIED` | A guard failed (a leave neither a webhook nor Stream confirmed, a Stream report that saw more people, a maintenance hold), or only one side appears in our webhook rows and Stream gave no evidence within 24 hours of the booked end (see below); ops decides. |
| `OFFLINE`         | `UNVERIFIED` | There is no call at all, which is what an in-person session looks like.                                                                                                                                                                                         |

Four kinds of row are deliberately left `SCHEDULED`. A session with an open presence interval on a room that has not ended is a live overrun and waits for the next run. A session that needs a Stream read after the run's budget of 100 reads is spent waits for the next run with nothing written. A session on a real call whose webhook rows show only one side (a `LEARNER_ABSENT` or `HOST_ABSENT` verdict) is deferred as `stream-evidence` when Stream gave neither a call report nor a participant-sessions answer for the call: webhook rows alone never decide that one side was absent, because a lost join webhook looks the same. The wait ends 24 hours after the booked end (`STREAM_EVIDENCE_WAIT_MS` in `lib/booking/session-outcome-sweep.ts`). From then on the sweep writes the session `UNVERIFIED` with outcome `INCONCLUSIVE` and no host attribution, so there is no forfeit, no void and no strike, and ops decides. If Stream does answer, whether with a call report or with a participant-sessions read (even an empty one), that is evidence and the verdict stands as classified. Example: Hannah's 1 h consultation with Priya ends at 11:00 IST on Mon 9 Nov 2026 and only Priya has a presence row. If Stream gives nothing, the sweep leaves the session `SCHEDULED` at each run until Tue 10 Nov 2026 at 11:00 IST and then parks it `UNVERIFIED` as `INCONCLUSIVE`; the outcome sweep never voids it as `HOST_ABSENT` on the rows alone. (`detect-consultant-no-shows` is a separate path with its own evidence rules, described in [cron jobs](13-cron-jobs-and-background-tasks.md); this rule changes only the outcome sweep.) The pure classifier `classifySessionOutcome` is unchanged; the wait is `decideSlotOutcome`'s rule. A consultation whose verdict is `HOST_ABSENT` belongs to `detect-consultant-no-shows` until the no-show handoff, which cancels and refunds it in full; the handoff clock pauses for every DEGRADED or OFFLINE maintenance minute (#1746 B), and a host no-show the detector declined is parked `UNVERIFIED` with its outcome for ops.

`VOIDED` has three edges. The sweep reaches it from `SCHEDULED`, ops may reach it from `UNVERIFIED` or `COMPLETED`, and ops may overturn it to `COMPLETED` through `session.set-outcome` until the void is made up, settled or refunded. No cancel edge leaves `VOIDED`, so a void stays a miss until the make-up machine settles it, unless ops relabels its outcome first. The live-ordinal partial unique ignores `VOIDED` rows, so a make-up can take the voided session's ordinal.

A void is remedied by shape. A class, webinar or consultation void rides the host-cancel make-up machine: a make-up within 14 days of `voidedAt`, or `settle-cancelled-sessions` refunds each seat (one class unit, or a webinar or consultation seat's full refundable balance) under `occ:<occurrence>:pay:<payment>`. A subscription void returns to the plan's allowance, and a void still unused when the plan ends is paid back by plan-end settlement as part of the undelivered share, under the plan's own `plan-end:<subscriptionId>:pay:<paymentId>` marker (`settleVoidsOfEndedPlans` and `settleVoidsOfCompletedPlans` in `scripts/appointments/settle-cancelled-sessions.ts`); there is no per-void refund key. A free trial's void is a record only, and a paid trial's void waits on the ops queue. A booking with an unsettled miss neither completes nor releases its earnings. A void that a declared incident caused takes the incident remedy below instead, and a session whose incident refunds are all done is stamped `seatsSettledAt`, which takes it out of the day-14 sweep.

### Platform incident voiding

An operator declares a platform incident (a window that has already ended, ended within the last 7 days and is at most 24 hours long) and every booked session that overlaps it is the platform's miss. Three rules hold, and each has a named enforcer:

1. **An incident window classifies before any absence verdict.** `classifySessionOutcome()` returns `PLATFORM_OUTAGE` first when the booked interval overlaps a declared incident at all (`overlapsDeclaredIncident()` in `lib/booking/session-outcome.ts`). A maintenance window is weaker: its minutes count as platform loss rather than host loss, so a void is `PLATFORM_OUTAGE` only when platform loss exceeds host loss, and when no host-side person ever joined the overlap turns a possible `HOST_ABSENT` into `INCONCLUSIVE`.
2. **No strike inside a declared window.** The no-show detector claims only `HOST_ABSENT` verdicts, and `isPastNoShowHandoff()` pauses for incident windows as it does for maintenance. `countExpertStrikes()` and `readExpertStrikeReview()` (`lib/booking/expert-reliability.ts`) drop any strike on an appointment that has a session overlapping a declared incident, so a no-show the detector claimed before the declaration stops counting too.
3. **A retroactive pass voids what already ran.** The `settle-platform-incidents` sweep (`scripts/appointments/settle-platform-incidents.ts`) walks each unsettled incident's overlapping sessions by id and moves `COMPLETED`, `UNVERIFIED` and past `SCHEDULED` sessions to `VOIDED` with outcome `PLATFORM_OUTAGE` through `transitionOccurrenceCompletion()`, with the status it read as `fromIn`. A `SCHEDULED` session is voided only once it is an hour past its end, with the same `fromIn: [SCHEDULED]` and `voidedAt: null` guard as the outcome sweep, so when both reach a still-`SCHEDULED` row, whichever runs first wins and the other moves zero rows. A `COMPLETED` session the outcome pass already decided is voided by the incident pass afterwards. A session already `VOIDED` for another reason is relabelled to `PLATFORM_OUTAGE` by compare-and-swap on its previous outcome. `CANCELLED` and `RESCHEDULED` sessions are skipped, and so is a void that already carries a refund or is settled. A class session also runs `onClassSessionVoided()`, so its learners get the existing make-up window.

The remedy rows are written in the same transaction as the void, one per live seat that held the session (a seat bought after the session started is not owed). The table of what each product owes is in [the booking HLD](../start-here/01-booking-system-hld.md#7-session-outcomes); the refund mechanics are in [the refunds architecture](../finance/30-refunds-disputes/01-refunds.md#refund-front-doors-and-durability). The database guards the window itself: `platform_incident_time_order` in `prisma/sql/check-constraints.sql` refuses an incident that does not start before it ends, and `@@unique([startsAt, endsAt])` makes an exact duplicate declaration return the first incident.

#### Who may take the free rebook

A one-to-one session voided by a declared platform incident may be rebooked free while its booking is confirmed or completed, judged per kind by `isRebookableParent` (`lib/booking/incident-keys.ts`): a consultation while `APPROVED` or `COMPLETED`, a trial while `SCHEDULED` or `COMPLETED`. The rebook leaves a consultation `APPROVED`: from `COMPLETED` it writes `APPROVED`, from `APPROVED` it writes nothing, so a rebooked session that is voided again can be rebooked again. A trial reopens from `COMPLETED` to `SCHEDULED`. The open remedy row still gates who may rebook (`assertOpenFor`, and the refund-marker check that answers 409 `INCIDENT_REMEDY_CLOSED`), and the same rule decides whether the incident notice offers the rebook (`platform-incident-notices.ts`).

## Backup interest in a held window (#1778)

`WindowBackupInterest.status` has four states. A row starts `WAITING` when a learner asks to hear about a held window. It moves to `NOTIFIED` when a release path frees an overlapping window (the CAS carries `status: WAITING`), to `BOOKED` when the same learner's capture confirms an overlapping booking (from `WAITING` or `NOTIFIED`), and to `EXPIRED` when the learner withdraws it or the stale-request sweep finds its window has passed. `BOOKED` and `EXPIRED` are terminal; re-registering the same window revives the row to `WAITING`.

## Participants (#1846)

`ParticipantStatus` on `AppointmentParticipant`, guarded by `PARTICIPANT_ALLOWED_FROM` through `transitionParticipant` in `lib/booking/participants.ts`, which replaced `setParticipantStatus`. The map is keyed by target, like every map in `lib/booking/transitions.ts`, and it reads as follows in the code.

```typescript
export const PARTICIPANT_ALLOWED_FROM: Record<
  ParticipantStatus,
  ParticipantStatus[]
> = {
  HELD: [],
  CONFIRMED: ["HELD"],
  ATTENDED: ["CONFIRMED"],
  CANCELLED: LIVE_PARTICIPANT_STATUSES,
  REFUNDED: [...LIVE_PARTICIPANT_STATUSES, "CANCELLED"],
};
```

`LIVE_PARTICIPANT_STATUSES` is `HELD`, `CONFIRMED` and `ATTENDED`. The from-set is ANDed with the caller's WHERE and never merged into it, so a caller that already narrows keeps its narrower set, and a caller that forgot to narrow still cannot make an illegal move. `REFUNDED` is terminal, and because a refund may land after a cancel released the seat, `CANCELLED → REFUNDED` is legal while the reverse is not. `HELD` is entry-only: a released seat bought again is revived by `recordParticipants`, which widens the from-set explicitly to the released statuses and stamps the new purchase's payer org on the seat (#1852). A zero-row match is a normal answer, so the helper returns the count and never throws. Participant moves write no `BookingStatusHistory` row, because that enum has no participant entity. `ATTENDED` is read but not yet written anywhere, because writing it needs the attendance pipeline.

## Reschedule requests

`RescheduleRequestStatus` via `transitionRescheduleRequest`:

- Open state: `PENDING_REVIEW`, and it is the only one. `COUNTERED` (the
  round-2 counter-offer) was removed from the enum, from
  `RESCHEDULE_ALLOWED_FROM`, from the operator badge and from the seed. It was
  specified and never built — `lib/booking/reschedule-proposals.ts` documents
  the removal — and the only writer in the whole repo was
  `prisma/seedFiles/6c-create-reschedule-proposals.ts`, so the seed was keeping
  a dev database full of rows the respond route had no code for. The six read
  surfaces that filtered on `["PENDING_REVIEW", "COUNTERED"]` now use
  `RESCHEDULE_OPEN_STATUSES`, so a future open state is added in one place.
- `AUTO_ACCEPTED` is a second terminal-acceptance state alongside `ACCEPTED`.
  `tryAutoConfirmProposal` (`lib/booking/reschedule-auto-confirm.ts`) writes
  it right after the reschedule route opens a consultee's proposal, when the
  proposed times sit inside the consultant's published availability and both
  calendars are free; nothing waits for a reply, and a consultant's proposal
  never auto-confirms. Nor does a proposal about a session, or naming a time,
  less than 24 hours away: it answers `NEEDS_ACCEPTANCE` and waits for the
  other side (`needsOtherSideAcceptance`). Its map entry is empty
  (`AUTO_ACCEPTED: []`) because the confirming hook (`closeConfirmedProposal`)
  is its one writer.
- `ACCEPTED ← [PENDING_REVIEW]`; `DECLINED ←` open state; `WITHDRAWN ←` open
  state (initiator only); `EXPIRED ← [PENDING_REVIEW]` (reschedule-proposals sweep, every 15 minutes).
  `openForAppointmentId @unique` enforces at most one live reschedule per
  appointment. `expiresAt` is stored at creation (`computeProposalExpiry`):
  the earlier of 72 hours and 24 hours before the earliest released session,
  or 15 minutes before that session's start (when its join window opens) for a request opened inside those 24 hours.
  An accept after `expiresAt` is refused (`PROPOSAL_EXPIRED`).
- An expert's request with no proposed times on a paid booking is never
  answered by a placement: the allocator refuses it with 409
  `PROPOSE_TIMES_REQUIRED`, and the request ends by withdrawal or expiry.
- Decline, withdrawal, and expiry all restore the released slots (each as
  the release found it: firm, or an unpaid hold left tentative, read from
  `releasedSessions[i].tentative`) and the
  parent's origin status through the shared `restoreRescheduledBooking` in
  `lib/booking/reschedule-restore.ts` inside the same `Serializable`
  transaction under the appointment lock. If the original time was booked while
  the proposal was open, the restore meets the overlap constraint and rolls
  back; the terminal transition (`DECLINED` or `EXPIRED`) then commits alongside
  `parkParentForUnrestoredEnding` in a single `Serializable` transaction so a
  whole-booking parent that entered `PENDING` for the reschedule is atomically
  parked in `APPROVED` (never left in `PENDING` where the 48-hour unpaid-request
  sweeper could expire a paid booking) and surfaces in the consultant's
  **Requests** inbox under `answer-today` until new occurrences are placed. A
  paid consultation parked this way is cancelled with a full refund if nobody
  places a time within 7 days, or by 48 hours after the released session's
  original start (`cancelAgedParkedConsultations` in
  `lib/booking/parked-consultation-sweep.ts`).
- A confirmation is one transaction. The allocator commits the new times and, through its `inTx(tx)` hook, which runs after the allocator's status compare-and-swap, flips the proposal to `ACCEPTED` or `AUTO_ACCEPTED` in the same commit (`closeConfirmedProposal` in `lib/booking/reschedule-confirm.ts`). If the proposal is no longer `PENDING_REVIEW`, the hook throws 409 `RESCHEDULE_NO_LONGER_OPEN` and the whole move rolls back, so a booking can never move while its proposal says otherwise. Because the allocator's supersede sweep closes every other open proposal on the same released slots as `DECLINED`, a confirming caller passes `excludeRescheduleRequestId` to keep its own row out of that set.

## Raw status writers: none remain

Every booking status write goes through a `transition*` helper or `transitionParticipant`, and adding a raw writer needs doctrine review. The cancel route moves every parent to `CANCELLED` through its helper with `CANCELLABLE_FROM` pinned to the status it read; the reschedule route moves a consultation or a whole subscription to `PENDING` through its helper with `fromIn: [parentStatus]`, and a per-session subscription release only touches `updatedAt` by CAS to hold the parent row; `expire-stale-requests` expires every cohort through `transitionConsultationRequest` or `transitionSubscriptionRequest` with its subset of `REQUEST_ALLOWED_FROM.EXPIRED`; auto-complete, moderation, the no-show detector, the capture webhook and the maintenance freeze go through their helpers too.

### Withdraw and expiry restore the ORIGIN status, not always APPROVED

`lib/booking/reschedule-withdraw.ts` runs the whole withdraw inside `withAppointmentLock`, and the expiry sweep runs each expiry the same way. Both call `restoreRescheduledBooking` in `lib/booking/reschedule-restore.ts`. The origin is `RescheduleRequest.originStatus`, which the release writes in its own transaction (`readRescheduleOrigin`); only a legacy row with no `originStatus` falls back to the `BookingStatusHistory` row the release wrote, the one whose `toStatus` is `"PENDING"` within five seconds of the request's `createdAt`. The restore then follows the origin, not a hard-coded target:

- Origin `PENDING` — the parent never left PENDING, so withdraw writes nothing.
- Origin `APPROVED_PENDING_PAYMENT` — restores to `APPROVED_PENDING_PAYMENT`, so the pay-link expiry cohort keeps the row rather than seeing an unpaid booking that looks paid-for.
- Origin `APPROVED` — restores to `APPROVED`.
- Origin missing (no `originStatus` and no history entry, or `readRescheduleOrigin`'s own `"UNKNOWN"` fallback) — the restore refuses to guess. A consultation writes nothing, exactly like the subscription arm, and reports once through `reportSentryMessage` with `expected: true`. The booking stays where it is until an operator or a new allocation settles it; it is never restored to `APPROVED` on a guess, because that could confirm an unpaid booking.

All restores keep `fromIn: ["PENDING"]`, so a parent that moved out of PENDING under the withdraw (a concurrent answer) throws `IllegalTransitionError` rather than being re-stamped.

Deliberately NOT migrated: payout/dispute/ledger state machines live under
`lib/payments/**` and have their own transition helpers where applicable.

## Deprecated & Superseded Approaches

1. **A consultee-callable allocate route.** Removed: allocation is host-side only.
2. **An event `PUT` that could write `status`.** Replaced by `USE_CANCEL_ROUTE` and the transition helpers.
3. **Closing a reschedule proposal in a second transaction after the move.** Replaced by the in-transaction hook above.
4. **Restoring an unknown origin to `APPROVED`.** Replaced by refusing to write.
5. **`COUNTERED`** as a reschedule state was removed from the enum because nothing ever built the round-two counter-offer.
6. **Removed stored values.** `IN_PROGRESS` on webinars and classes (nothing set it; the create body could), the trial's `PENDING` "awaiting the expert" state with its accept, decline (`REJECTED`) and 48-hour `TRIAL_UNANSWERED` sweep arm, and the plan's edges into and out of `APPROVED_PENDING_PAYMENT`. `AppointmentStatus.SCHEDULED`, which only the incident rebook wrote; a rebooked consultation now stays `APPROVED`.
7. **Classifying an outage with no presence evidence as a learner absence.** The classifier used to run its absence verdicts before any outage rule, so a platform-wide outage could forfeit a learner's session. A declared incident window now wins first.
8. **A raw-status-writer inventory.** The cancel route, the reschedule route and `expire-stale-requests` were once listed as CAS-guarded raw writers; all of them go through the transition helpers now.
9. **A per-void `void-unused:` refund at the scheduling period's end.** A subscription void is settled inside the plan-end refund.
10. **Deciding an absence from webhook rows alone.** A one-sided set of presence rows used to settle at once as `LEARNER_ABSENT` (forfeit) or `HOST_ABSENT` (void) even when Stream had not been asked or could not answer. The outcome sweep now waits up to 24 hours past the booked end for Stream, then parks the session `UNVERIFIED` as `INCONCLUSIVE`.
