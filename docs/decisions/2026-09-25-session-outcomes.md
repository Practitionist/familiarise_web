# ADR: session outcomes — presence, voids and misses

**Status:** accepted, 2026-09-25 · **Issue:** #1569 (with #1543, #1607, #1493 and #1746 item B)

## Context

Before this decision the platform recorded almost nothing about how a session actually went. The Stream end webhooks marked a session `COMPLETED` as soon as the call closed, the hourly sweep completed or parked whatever the webhooks missed, and `MeetingAttendance` kept only a first join, a last leave and a join count per person. A host who dropped for half an hour, a platform outage that emptied the room, and a learner who never arrived all produced the same `COMPLETED` row, and only the consultation no-show detector could move money for any of them. The support copy promised refunds and reschedules that no code path delivered.

## Decision

### 1. Presence is recorded per device

A new `MeetingPresence` table holds one interval per Stream `user_session_id`, written by the participant join and leave webhooks. A leave whose join was lost rebuilds the interval from the leave's own `duration_seconds`, a replayed event is a no-op on the `(meetingId, userSessionId)` unique, and `MeetingAttendance.joinCount` now counts distinct device sessions rather than deliveries.

### 2. One job decides, and one pure function reads the evidence

The hourly `auto-complete-appointments` slot pass, one hour after a session's booked end, is the only writer of the outcome. It calls `classifySessionOutcome`, which the consultation no-show detector also reads, so the two jobs cannot hold different opinions about one session. The Stream webhooks and the orphan reconciler only record that the room closed.

### 3. The void rule measures loss attributable to the host side

The loss counts minutes inside the booked window, after the first learner arrived, in which no host-side person was present. The host side is the plan's consultant and every accepted collaborator. A user's devices are merged, reconnect gaps under two minutes are ignored, and up to 30 minutes that both sides spend together after the booked end are credited back. The session is voided when the loss reaches min(15 minutes, half the booked length). A late learner never voids a session, and minutes after the learner left first are the learner's own.

### 4. A doubtful verdict never moves money

An open interval, a Stream call report that saw more people than our rows, or maintenance overlapping a host-absent verdict gives `INCONCLUSIVE`. That parks the session `UNVERIFIED`, lists it for ops, and moves no money.

### 5. A void is a miss with a remedy per shape

A voided class, webinar or consultation session is owed a make-up within 14 days, after which the settle sweep refunds each seat automatically. A voided subscription session returns to the plan's allowance, and one still unused when the plan ends is refunded automatically at the plan's per-session unit. A consultation whose host never joined keeps the detector's path: cancel and a full refund. A paid trial's void goes to the ops queue. Refunds are cash only, through `refundBookingPayment` with a dedupe key.

### 6. Misses are counted for the learner, and attributed for the host

Every void counts toward the learner's right to leave a class series. Only a host cancellation or a `CUT_SHORT` or `HOST_ABSENT` void counts toward the reliability flag and the consultant's completion rate, because a platform outage is not the host's fault.

### 7. A learner who never joins forfeits the session

The outcome is `LEARNER_ABSENT` and the session counts as held, so no money moves. The learner of a 1:1 session gets one notification with a support link and, when the plan records sessions and a recording exists, a link to the recordings page. Ops can overturn the outcome from the Money hub with a reason.

### 8. There is no "recording instead of a refund"

A voided session's recording is empty or partial, so the idea of accepting it in place of a refund was dropped.

## Consequences

A session now shows `COMPLETED` up to an hour later than before, which the dashboards do not reveal because they read when the room closed. An earning is held while its booking owes a make-up or a refund, which turns what would have been a clawback into a hold. The attendance watchdog reports any session Stream saw people in while our rows recorded nobody, so a webhook outage like #1134 is no longer silent. The presence writer and the watchdog can only be proven on production after release, because Stream's single event hook delivers to production only.

## Deferred

- A make-up door for a voided webinar or consultation is not built; until it is, those voids are refunded automatically on day 14, and ops can still grant a make-up through the class-series door for classes only.
- Crediting a voided session to a consumer wallet instead of refunding cash is post-launch, tracked in #1828.
