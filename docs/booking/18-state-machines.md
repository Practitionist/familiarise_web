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

The table below is `REQUEST_ALLOWED_FROM` as of 2026-09-18 (#1703), row by target state and column by the state the row must currently be in.

| To ↓ From →                  | PENDING                                         | APPROVED                                                     | APPROVED_PENDING_PAYMENT                                                                                                                                                                             | SCHEDULED | COMPLETED | REJECTED | CANCELLED | EXPIRED |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | -------- | --------- | ------- |
| **PENDING**                  |                                                 |                                                              | ✓                                                                                                                                                                                                    |           |           |          |           |         |
| **APPROVED**                 | ✓                                               | ✓ self-edge only via `fromIn` (`ALLOCATION_APPROVABLE_FROM`) | ✓                                                                                                                                                                                                    |           |           |          |           |         |
| **APPROVED_PENDING_PAYMENT** | ✓                                               | ✓                                                            |                                                                                                                                                                                                      |           |           |          |           |         |
| **SCHEDULED**                |                                                 | ✓                                                            | ✓                                                                                                                                                                                                    |           |           |          |           |         |
| **COMPLETED**                |                                                 | ✓                                                            |                                                                                                                                                                                                      | ✓         |           |          |           |         |
| **REJECTED**                 | ✓                                               |                                                              | ✓                                                                                                                                                                                                    |           |           |          |           |         |
| **CANCELLED**                | ✓                                               | ✓                                                            | ✓                                                                                                                                                                                                    | ✓         |           |          |           |         |
| **EXPIRED**                  | ✓ (48 h consultation / 30 d subscription sweep) | ✓ (PR 2c: APPROVED-unallocated cohort)                       | ✓ (the 24 h pay-link sweep with a consultee notice; the 7 d `updatedAt` fallback in `expirePaymentPendingRequests`; and since #1775 the consultant's own Withdraw, reason `WITHDRAWN_BY_CONSULTANT`) |           |           |          |           |         |

The `APPROVED_PENDING_PAYMENT → EXPIRED` edge has three writers that share one body since #1775: the 24 h pay-link sweep, the 7-day fallback and the consultant-initiated Withdraw all go through `lapseApprovedRequest` in `lib/booking/lapse-approved-request.ts`, which writes the history row with reason `PAYMENT_LAPSED` or `WITHDRAWN_BY_CONSULTANT`, keeps the money predicate in the CAS WHERE, tombstones the open PENDING order and releases the tentative holds by status. Two rows deserve a note. `PENDING` is reachable only from `APPROVED_PENDING_PAYMENT` in the map; the reschedule route's consultation restore to `PENDING` passes its own `fromIn` and is listed in the raw-writer inventory below. `SCHEDULED` is declared for consultations and subscriptions and its edges are legal, but no writer ever transitions either request type to it: allocation re-stamps `APPROVED`, completion goes `APPROVED → COMPLETED`, and the only `SCHEDULED` writes in the codebase are on `AppointmentOccurrence.completionStatus`, `Webinar`/`Class` and `Trial`. Treat it as an unreachable state on these two entities until a writer appears.

Since #1775 a subscription never enters `APPROVED_PENDING_PAYMENT` through a live writer: a plan is paid at purchase, so both the detail PATCH and the allocate path refuse an unpaid plan with `409 SUBSCRIPTION_UNPAID`, and the edge survives only for rows already in flight. A paid plan has one extra `PENDING → EXPIRED` writer, `expireUnallocatedPaidSubscriptions`, which fires 48 hours after the capture when no session has been allocated and records the history reason `UNALLOCATED_48H`; the 30-day `PENDING` arm skips paid rows so the two arms never share one.

### Subscription entitlement and fill-order cycles (#1766)

A subscription's request status does not move between cycles. The row stays `APPROVED` from its first allocation until the last delivered session, and what advances is a derived counter, not a column. `Subscription.sessionsTotal` is snapshotted from the plan at purchase, exactly as `Payment.amount` is, so a consultant editing the plan afterwards never changes what a buyer paid for; a pre-#1766 row with a null snapshot resolves through `plan.totalSessions`. Everything else is computed by one pure helper, `subscriptionEntitlement` in `lib/booking/entitlement.ts`, from the wrapper's live occurrence rows: `completed` is the count of COMPLETED and UNVERIFIED rows, `scheduled` the count of non-tentative SCHEDULED rows, `held` their sum and `remaining` the entitlement minus `held`. There is no consumed counter and no per-surface arithmetic.

Cycles are fill-order tranches rather than calendar buckets. The capacity of a cycle is the plan's `sessionsPerWeek` (the month arm only exists for a hand-zeroed plan), the plan holds `ceil(total / capacity)` cycles with a possibly short last one, and the cycle being filled is `floor(completed / capacity)`. The allocator accepts exactly `nextBatch = min(capacity of this cycle − sessions already filled into it, remaining)` sessions, so a fresh 12-session plan at four a week asks for 4, asks for 0 once those 4 are placed, asks for 4 again once they are delivered, tops up 2 when only 2 were placed, and asks for 1 when one delivered session is later corrected to CANCELLED. Because ranking is by delivered count, a reschedule across a calendar boundary changes nothing, and a future cycle can never be pre-scheduled because the allocator only ever accepts `nextBatch`. The window a batch may be placed in starts at the latest of the stored start, the last held session's end and now, and runs one cycle in the subscription's `schedulingTimezone`; checkout persists the first cycle only, through the same `firstCycleWindow` arithmetic.

Two consequences follow for the maps above. The `APPROVED` self-edge is what every subsequent cycle's allocation takes, and `COMPLETED` is reached only when `remaining` is zero: the auto-complete sweep reads the entitlement and leaves a plan with sessions left `APPROVED`, the two expiry sweeps skip any plan holding one delivered session, and the consultee is told a cycle closed through the `subscription-renewed` outbox row staged in the completing transaction and deduped on `sub:<id>:cycle:<n>`.

Special sets:

- `ALLOCATION_APPROVABLE_FROM = [PENDING, APPROVED_PENDING_PAYMENT, APPROVED]`
  — allocation re-stamps APPROVED with the self-edge legal there only.
- `RESCHEDULABLE_FROM = [PENDING, APPROVED, APPROVED_PENDING_PAYMENT,
SCHEDULED]` — which bookings may open a reschedule.
- `CANCELLABLE_FROM = REQUEST_ALLOWED_FROM.CANCELLED`.

## Event lifecycle (Webinar, Class)

`EVENT_ALLOWED_FROM` / `CLASS_EVENT_ALLOWED_FROM` (identical maps), via
`transitionWebinarEvent` / `transitionClassEvent`:

| To ↓ From →   | DRAFT                                                              | SCHEDULED                       | IN_PROGRESS | COMPLETED | CANCELLED |
| ------------- | ------------------------------------------------------------------ | ------------------------------- | ----------- | --------- | --------- |
| **SCHEDULED** | — (publishing is its own edge: `EVENT_PUBLISHABLE_FROM = [DRAFT]`) | ✓ self (re-allocation re-stamp) | ✓           |           |           |
| **COMPLETED** |                                                                    | ✓                               | ✓           |           |           |
| **CANCELLED** |                                                                    | ✓                               | ✓           |           |           |

DRAFT keeps its status through allocation (B2/#1060): "add a session, then
publish" is the editor flow.

## Class batch enrolment (#1819)

A class batch's enrolment state is derived, not stored, by `classEnrolmentFrom` in `lib/booking/class-enrolment.ts`. The derivation counts the sessions that have started (a live row whose start has passed, excluding rows released for rescheduling and cancelled rows whose make-up is still ahead), and `remaining` is the plan's `totalSessions` minus that count. The batch is open while `remaining` is above zero and the next session's ordinal (`totalSessions − remaining + 1`) is at most the host's cutoff, `lateJoinUntilSession`, which defaults to 1. Otherwise the batch is closed, and a batch with no live sessions at all is unscheduled. Checkout evaluates this twice, once when it prices the order and again inside the booking transaction, and a change in `remaining` between the two refuses with the typed 409 `CLASS_PRICE_CHANGED` so the buyer re-checks out at the new price.

## Trials

`TrialStatus`, guarded by `TRIAL_ALLOWED_FROM` through `transitionTrial`. Since #1775 a paid trial is paid while it is still `PENDING`: the request mints the order, capture sets `paymentId` without moving the status, and acceptance moves `PENDING → SCHEDULED` with `paymentId` not null repeated in the CAS WHERE. `AWAITING_PAYMENT` remains for trials accepted before payment under the old flow. A paid trial the consultant never answers moves `PENDING → CANCELLED` after 48 hours with the history reason `TRIAL_UNANSWERED` and is refunded in full; an unpaid trial past its pay window moves from `PENDING` or `AWAITING_PAYMENT` to `CANCELLED` with `paymentId` null repeated in the CAS WHERE, and no money moves.

## Class sessions the host cancels (#1780 row 4)

A class session is one `AppointmentOccurrence` row, and since #1780 the host may cancel just one of them. `POST /api/appointments/[id]/occurrences/[occurrenceId]/cancel` moves a future `SCHEDULED` session to `CANCELLED` through `transitionOccurrenceCompletion` (`fromIn: [SCHEDULED]`, reason `HOST_CANCELLED_SESSION`) and stamps `hostCancelledAt`, but never `deletedAt`, so the session stays countable. The host then has 14 days: a make-up is a new occurrence with the same ordinal that must be held by the fourteenth day, and the partial unique on live ordinals makes a second make-up impossible. If no make-up exists when the 14 days are up, the `settle-cancelled-sessions` sweep refunds every seat that held the session one unit under the key `occ:<occurrence>:pay:<payment>` and stamps `seatsSettledAt`; a learner who cannot attend a make-up may take the same unit back earlier under the same key, so the two paths never both refund it.

Every host-cancelled session counts as a miss, made up or not, and since #1569 so does every voided session (see "Session outcomes" below). At three misses, or a quarter of the series, a learner holding a seat may leave with every undelivered session refunded at 100 %, through `DELETE /api/participants/class/[classId]?mode=exit`, which recomputes the ledger inside its transaction and refuses with `EXIT_NOT_AVAILABLE` without the right. Delivered sessions are never clawed back.

The reliability flag is not a once-ever write. Since #1569 only a host-attributed miss can raise it: a host cancellation, or a void whose outcome is `CUT_SHORT` or `HOST_ABSENT`. A `PLATFORM_OUTAGE` void still counts toward the learner's exit right but never toward the flag. `reliabilityFlagDue` (`lib/booking/class-sessions.ts`) reads the latest `class-reliability:<classId>` `SystemEvent` and asks whether it is due: never flagged, due; an active flag (the latest event is not a cleared one), not due; a flag an operator has cleared through the ops door, due again only once a further host-attributed miss lands after that clear. Every host-attributed miss past the threshold re-runs this check, whether a host cancellation or a `CUT_SHORT` or `HOST_ABSENT` void (including an ops relabel to one), so a class can flag, get cleared from the money console, and flag again on new misses. The learners' exit-right notification bell, by contrast, still goes out exactly once — on the miss (a host cancellation or a void) that first trips the threshold — regardless of how many times the flag itself is later written.

## Session outcomes (#1569)

Every past session now receives exactly one automatic verdict, written by one job, and ops may later override it through `session.set-outcome`. The hourly `auto-complete-appointments` slot pass reads each `SCHEDULED` session whose booked end is more than an hour old, passes its `MeetingPresence` intervals, its host side (the plan's consultant plus every accepted collaborator), the Stream call report and any maintenance window to `classifySessionOutcome` (`lib/booking/session-outcome.ts`), and writes the result through `transitionOccurrenceCompletion` with `fromIn: [SCHEDULED]` and `voidedAt: null` in the WHERE. The Stream end webhooks and the orphan reconciler only stamp `Meeting.endedAt` and `endedReason`; neither completes a session any more.

The verdict decides the completion status. The table below lists every outcome and the status it writes.

| Outcome           | Status       | Meaning                                                                                                   |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| `HELD`            | `COMPLETED`  | Both sides were present and the void rule did not fire.                                                   |
| `LEARNER_ABSENT`  | `COMPLETED`  | The host was present and no learner joined; the session is forfeit and no money moves.                    |
| `CUT_SHORT`       | `VOIDED`     | The host side dropped while learners stayed, for at least min(15, booked / 2) minutes.                    |
| `PLATFORM_OUTAGE` | `VOIDED`     | Everyone dropped within two minutes of each other, or the loss overlaps maintenance.                      |
| `HOST_ABSENT`     | `VOIDED`     | A learner waited and no host-side person ever joined.                                                     |
| `NOBODY_JOINED`   | `UNVERIFIED` | A call exists but nobody has a presence interval.                                                         |
| `INCONCLUSIVE`    | `UNVERIFIED` | A guard failed (an open interval, a Stream report that saw more people, a maintenance hold); ops decides. |
| `OFFLINE`         | `UNVERIFIED` | There is no call at all, which is what an in-person session looks like.                                   |

Two rows are deliberately left `SCHEDULED`. A session with an open presence interval on a room that has not ended is a live overrun and waits for the next run. A consultation whose verdict is `HOST_ABSENT` belongs to `detect-consultant-no-shows` until the no-show handoff, which cancels and refunds it in full; the handoff clock pauses for every DEGRADED or OFFLINE maintenance minute (#1746 B), and a host no-show the detector declined is parked `UNVERIFIED` with its outcome for ops.

`VOIDED` has three edges. The sweep reaches it from `SCHEDULED`, ops may reach it from `UNVERIFIED` or `COMPLETED`, and ops may overturn it to `COMPLETED` through `session.set-outcome` until the void is made up, settled or refunded. No cancel edge leaves `VOIDED`, so a void stays a miss until the make-up machine settles it, unless ops relabels its outcome first. The live-ordinal partial unique ignores `VOIDED` rows, so a make-up can take the voided session's ordinal.

A void is remedied by shape. A class, webinar or consultation void rides the host-cancel make-up machine: a make-up within 14 days of `voidedAt`, or `settle-cancelled-sessions` refunds each seat (one class unit, or a webinar or consultation seat's full refundable balance) under `occ:<occurrence>:pay:<payment>`. A subscription void returns to the plan's allowance, and a void still unused when `schedulingPeriodEndsAt` passes is refunded at `amount / sessions` under `void-unused:<occurrence>:pay:<payment>`. A free trial's void is a record only, and a paid trial's void waits on the ops queue. A booking with an unsettled miss neither completes nor releases its earnings.

## Backup interest in a held window (#1778)

`WindowBackupInterest.status` has four states. A row starts `WAITING` when a learner asks to hear about a held window. It moves to `NOTIFIED` when a release path frees an overlapping window (the CAS carries `status: WAITING`), to `BOOKED` when the same learner's capture confirms an overlapping booking (from `WAITING` or `NOTIFIED`), and to `EXPIRED` when the learner withdraws it or the stale-request sweep finds its window has passed. `BOOKED` and `EXPIRED` are terminal; re-registering the same window revives the row to `WAITING`.

## Reschedule requests

`RescheduleRequestStatus` via `transitionRescheduleRequest`:

- Open state: `PENDING_REVIEW`. `COUNTERED` is still declared in the enum and
  in `RESCHEDULE_ALLOWED_FROM`, but no writer ever transitions a row to it —
  the counter-round was specified and never built, and `lib/booking/reschedule-proposals.ts`
  documents the removal — so treat it as an unreachable edge, not a live state.
- `AUTO_ACCEPTED` is a second terminal-acceptance state alongside `ACCEPTED`,
  written by `lib/booking/reschedule-auto-confirm.ts` when the responding
  party lets the reschedule window lapse without a reply; it deliberately
  carries no allowed-from entry in the map because that helper is the one
  caller.
- `ACCEPTED ← [PENDING_REVIEW]`; `DECLINED ←` open state; `WITHDRAWN ←` open
  state (initiator only); `EXPIRED ← [PENDING_REVIEW]` (hourly sweep).
  `openForAppointmentId @unique` enforces at most one live reschedule per
  appointment.
- Decline/withdraw deliberately LEAVE slots released (the booking belongs in
  the consultant's allocate queue); only withdrawal restores them.
- A confirmation is two ordered steps: the allocator commits the new times,
  and only then does the caller compare-and-swap the proposal to
  `AUTO_ACCEPTED` or `ACCEPTED`. Because the allocator's supersede sweep
  closes every OTHER open proposal on the same released slots as `DECLINED`,
  a confirming caller passes `excludeRescheduleRequestId` to keep its own row
  out of that set; without it the sweep declined the very row the caller was
  about to accept, the compare-and-swap matched nothing, and the booking moved
  with a refusal in its audit trail (#1340).

## Known raw-status writers (CAS-bypass inventory)

These write status WITHOUT a `transition*` helper. Each was audited on PR 2a;
they are CAS-guarded inline (allowed-from rides their WHERE) and accepted as
documented exceptions. Adding one requires an entry here + doctrine review.

| Writer                                                           | Entity                                                | Guard shape                                               | Note                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/payments/webhooks/handlers.ts` `confirmExistingAppointment` | Webinar/Class → SCHEDULED                             | CAS via `EVENT_ALLOWED_FROM.SCHEDULED` updateMany (B2)    | terminal capture returns `capturedAfterTerminal` → Phase-2 refund                                                                                                                       |
| `handlers.ts` legacy subscription creator                        | Subscription slot birth                               | n/a (tentative birth, HOIf)                               | writes `appendCreationHistory` since 2026-09-19 (#1583 A-P1-06); its confirm flip (`confirmApprovalStatus`) now goes through `transitionSubscriptionRequest`, not a raw writer any more |
| `app/api/appointments/[appointmentId]/cancel/route.ts`           | Consultation/Subscription/Webinar/Class → CANCELLED   | `updateMany` with `CANCELLABLE_FROM` / event allowed-from | hoisted maps (#838)                                                                                                                                                                     |
| `.../reschedule/route.ts`                                        | Consultation PENDING restore; Webinar/Class SCHEDULED | explicit fromIn arrays                                    | policy-gated edges                                                                                                                                                                      |
| `scripts/appointments/cleanup-invalid-appointments.ts`           | → CANCELLED                                           | from-set per entity                                       | ops repair script                                                                                                                                                                       |
| `scripts/appointments/expire-stale-requests.ts`                  | Consultation/Subscription → EXPIRED                   | per-cohort subsets of `REQUEST_ALLOWED_FROM.EXPIRED`      | refunds ride along (PR 2c)                                                                                                                                                              |

Converted on 2026-09-19 (#1583 A-P0-05, A-P1-03, B-P1-16): `scripts/appointments/auto-complete-appointments.ts` now completes every parent through its `transition*` helper with `reason: "auto-complete"`, and its cohort predicate counts only live confirmed occurrences, so a stale tentative hold no longer vetoes completion; `lib/moderation/cancel-user-engagements.ts` cancels every parent through its helper and tombstones the released occurrences through `transitionOccurrenceCompletion` (the raw release left CANCELLED rows armed under the #1694 constraint predicate); `scripts/appointments/detect-consultant-no-shows.ts` releases its occurrences the same way. None of the three is a raw writer any more.

Also converted on 2026-09-19, in the money PR (#1583 A-P0-01, A-P1-04): `lib/payments/webhooks/handlers.ts`'s `confirmApprovalStatus` subscription arm replaced its raw `updateMany` (APPROVED_PENDING_PAYMENT → APPROVED) with `transitionSubscriptionRequest`, catching `IllegalTransitionError` to decide benign-race from capture-after-terminal by re-reading the fresh status; `cleanupFailedPaymentAppointment`'s raw `updateMany` (→ EXPIRED) on both the consultation and subscription arms now goes through `transitionConsultationRequest` / `transitionSubscriptionRequest` with the same from-set the old WHERE carried, catching the zero-row case rather than swallowing it. Neither is a raw writer any more; see the "legacy subscription creator" row above for the note on the confirm flip.

### Withdraw restores the ORIGIN status, not always APPROVED

`lib/booking/reschedule-withdraw.ts` (#1583 A-P0-03/A-P0-04, #1589 R-P1-01/R-P1-04) runs the whole withdraw inside `withAppointmentLock`. Before restoring the parent, it reads the `BookingStatusHistory` row the reschedule route wrote when it flipped the request to `PENDING` — the row whose `toStatus` is `"PENDING"` and whose `createdAt` sits within five seconds of the reschedule request's own `createdAt` — and takes that row's `fromStatus` as the origin. The restore then follows the origin, not a hard-coded target:

- Origin `PENDING` — the parent never left PENDING, so withdraw writes nothing.
- Origin `APPROVED_PENDING_PAYMENT` — restores to `APPROVED_PENDING_PAYMENT`, so the pay-link expiry cohort keeps the row rather than seeing an unpaid booking that looks paid-for.
- Origin `APPROVED` (or the unreachable `SCHEDULED`, per the note above) — restores to `APPROVED`.
- Origin missing (a pre-#1333 row, or `readRescheduleOrigin`'s own `"UNKNOWN"` fallback) — keeps the historical `APPROVED` restore and reports once via `reportSentryMessage`, `expected: true`.

All restores keep `fromIn: ["PENDING"]`, so a parent that moved out of PENDING under the withdraw (a concurrent answer) throws `IllegalTransitionError` rather than being re-stamped.

Deliberately NOT migrated: payout/dispute/ledger state machines live under
`lib/payments/**` and have their own transition helpers where applicable.
