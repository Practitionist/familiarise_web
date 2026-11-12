# ADR: The bug hunt in support and Stream: the reopened case clock, attendance evidence, and what was considered and not built

- **Status**: Accepted (owner decisions, 2026-11-12). Decisions 1 and 2 are built; the two "considered and not built" items are not built, and each says why.
- **Date**: 2026-11-12
- **Author**: Platform engineering
- **Related**: [Case lifecycle](../support/02-case-lifecycle.md), [Intake and flows (the clocks)](../support/01-intake-and-flows.md#references-and-clocks), [The SLA sweep](../support/07-sla-sweep.md), [Session outcomes](2026-09-25-session-outcomes.md), [Stream ADR-06, the attendance witness](../stream/18-architecture-decision-records.md#adr-06-stream-participant-sessions-are-the-attendance-witness), [Recordings lifecycle and access](../stream/19-recordings-lifecycle-and-access.md), [The recording and webhook doc](../stream/13-recording-webhooks.md)

## Context

A bug hunt over support and Stream found defects in four places: a reopened support case kept the clock of its first life, the SLA sweep could be held up by cases that fired nothing, the session outcome sweep could settle an absence from webhook rows alone, and two recording routes checked a condition and then wrote without it. The owner took the decisions below on 2026-11-12. The code is on the same branch; this record keeps the options that were not chosen, so the reasoning is not left in a chat.

## Decisions

1. **A reopened support case gets a new resolution deadline; the statutory deadline keeps its date** (decided, built).
   - A reopen sets a new resolution deadline from the reopen time at the case's current priority. A statutory deadline keeps its original date. Earlier notices must not suppress the new ones.
   - **The statutory date and the new target** (decided the same day, in two steps, after preview QA showed the new target could fall later than the statutory date). Every human case gets a statutory date at intake (7 days for general and grievance cases, 36 hours for content removal, 3 hours for a legal takedown, 2 hours for intimate content), and every reader of the clock takes the earlier of the working target and that date (`effectiveResolutionDueAt()`). Two rules follow.
     - While the statutory date is still ahead, the new target is the earlier of "reopen time plus the priority's target" and the statutory date. Example: a MEDIUM case received on day 0 has both dates at day 7; reopened on day 6, its new target is day 7, not day 13.
     - The statutory date never moves, and the case records when it was reopened (`SupportCase.reopenedAt`, stamped by `reopenedClockPatch()`). A case reopened after its statutory date works to its new target: `effectiveResolutionDueAt()` stops capping at the statutory date for that case, so it does not read as breached on reopening and no breach notice is sent until the new target passes. Example: resolved on day 2 and reopened on day 9, the target is day 16. Compliance reporting still reads the original statutory date.
     - Every reader of the statutory date applies the same exception. `effectiveResolutionDueAt()` drives the badge, the breach count and the sweep's notices; the staff inbox's "SLA at risk" view (`inboxCaseWhere()` in `lib/support/inbox-query.ts`, given the column comparison by `inboxWhere()` in `lib/support/case-read.ts`) and its SLA order (`compareCasesBySla()`) skip the statutory date for such a case too, so the list, its header count and each row's badge agree. Preview QA found the list still showing a reopened case that read "On track"; that is fixed.
     - Without the stored reopen time this could not be told apart from a content-removal case whose statutory date is, by design, far earlier than its working target, so the read-side cap would have kept every case reopened after its statutory date breached at once.
     - Options not chosen: restarting the statutory date on reopen (a reopen as a new complaint cycle, which needs a legal view); keeping the statutory date with no stored reopen time, which fixes only urgent and high-priority cases reopened early; letting the new target run past a statutory date that is still ahead.
     - Schema: one nullable column, `SupportCase.reopenedAt`. The owner applies it by the ordered procedure in `docs/prisma/README.md`.
   - **Enforced by** `reopenedClockPatch()` in `lib/support/sla.ts`, applied by `advanceUserTurnState()` (the customer's explicit reopen) and `buildLifecycleUpdateData()` (staff changing a resolved case to an active status) in `lib/support/case-service.ts`. It also zeroes `pausedSeconds`, the customer-wait time banked against the old deadline, and leaves `ackDueAt` alone, because acknowledgement means the first public agent reply and a reopened case already has one.
   - Resolution notice keys now carry the deadline they were raised for (`slaNoticeKey()` in `lib/support/sla-sweep.ts`): `sla:<caseId>:res:<warn|breach>:<deadline in epoch milliseconds>`. Acknowledgement keys are unchanged. A reopen's new deadline, or a priority raise that tightens the deadline, therefore produces a new key and the notice is raised again.
   - **Example.** Priya's HIGH case `FAM-2026-000123` is resolved on Thu 12 Nov 2026 at 10:00 IST and she reopens it on Fri 20 Nov 2026 at 09:00 IST. The resolution deadline becomes Mon 23 Nov 2026 at 09:00 IST (HIGH is 3 days), the banked pause is zero, and the warn notice and the breach notice can each fire once more under keys that name the new deadline.
   - **Options considered.**
     - Resuming the original clock, treating the time the case spent resolved as a pause, was rejected.
     - Keeping the original deadline was rejected.
     - The owner recorded the choices without a reason for each. The statutory deadline is kept because it is a promise made at receipt, not an internal target.

2. **The SLA sweep reads candidates by id and states its two limits** (decided, built).
   - A case awaiting the customer is not a resolution candidate, because its resolution clock is paused; the statutory arm never pauses, so such a case can still fire on its statutory deadline (`slaNoticeCaseWhere()`).
   - The run pages candidates by id (`stageSlaNotices()`) until it has staged its `limit` notices, the candidates run out, the 16-second start budget is spent, or it has read 10 pages (`SLA_SCAN_PAGE_CAP`) of 200 rows (`SLA_SCAN_PAGE_SIZE`). Every run starts again from the lowest id. Rows already noticed are skipped in memory against the preloaded outbox keys of the last 35 days. The trimmed `id notIn` lists, which were capped at 500 cases per notice kind, are gone.
   - **The two limits, stated plainly.** One run reads at most 2,000 candidate rows. A noticed case stays a candidate until it is resolved or leaves the notice window, so if more than 2,000 open cases sit in the window at once, the cases whose ids sort after the first 2,000 are not read on any run until earlier ones leave. Lifting this needs a stored marker on the case for the notice it last received (a schema change), which was not built. Reading in id order no longer puts statutory deadlines first within a run, so a due statutory deadline can wait behind lower-id cases when the backlog is larger than one run's reach.
   - **Enforced by** `stageSlaNotices()` and `slaNoticeKey()` in `lib/support/sla-sweep.ts`, and `__tests__/support/sla-sweep-lifecycle-arms.test.ts`.

3. **One-sided attendance rows wait for Stream, then park unverified** (decided, built).
   - When Stream gives neither a call report nor a participant-sessions answer for the call, and our webhook rows show only one side (the classifier's `LEARNER_ABSENT` or `HOST_ABSENT`), `decideSlotOutcome` defers the session (`stream-evidence`) and writes nothing until 24 hours past its booked end (`STREAM_EVIDENCE_WAIT_MS` in `lib/booking/session-outcome-sweep.ts`). It then writes the session `UNVERIFIED` with outcome `INCONCLUSIVE` and no host attribution.
   - There is no forfeit, void or strike on webhook rows alone. When the participant-sessions read answers, even with an empty list, that is Stream evidence and the classified verdict stands. The pure classifier `classifySessionOutcome` is unchanged.
   - **Example.** Hannah's 1 h consultation with Priya ends at 11:00 IST on Mon 9 Nov 2026 and only Priya has a presence row. With no Stream answer the session stays `SCHEDULED` through each run until Tue 10 Nov 2026 at 11:00 IST, and is then parked `UNVERIFIED` as `INCONCLUSIVE` for ops. If Stream had answered, the classified verdict would have been written at the first run after the one-hour buffer.
   - **Options considered.** Parking at once was rejected. Deciding on the webhook rows was rejected. The owner recorded the choices without a reason for each.

4. **Smaller guards that follow from the same hunt** (decided, built).
   - **Recording start.** The claim in `app/api/stream/recordings/start/route.ts` requires an unended room whose occurrence is still `SCHEDULED`, has no outcome and is not deleted (`RECORDABLE_ROOM_WHERE`).
   - **Recording delete.** The `EXPIRED` claim in `app/api/stream/recordings/[recordingId]/route.ts` carries the "no `PENDING` or `SUCCEEDED` purchase" predicate, so a purchase that lands after the earlier check refuses the delete.
   - **Webhook dispatch.** `processStreamEvent` takes the claim directly and has no self-claim branch. The reclaim is two functions in `lib/stream/webhook-receipt.ts`: `reclaimStaleProcessingWebhookEvent` (the sweeper's fenced reclaim) and `reclaimAbandonedWebhookReceipt` (redeliveries). The token action `assertCanMintToken` refuses when the user row is missing.

## Considered and not built

1. **Ending an intervention chat grant whose channel is frozen** (not built).
   - No existing data says that a freeze is permanent: a direct-message freeze clears on a new booking, and maintenance and organisation reactivation unfreeze channels. Ending a grant on a freeze could therefore end one that would have worked again.
   - A fix would need an attempt column on the grant, and the schema is frozen for launch. Nothing is built until that is decided.

2. **Binding the Stream webhook receipt id to the body** (not built).
   - It is held until a production retry can be compared with the original delivery. The receipt row already stores the body signature (`WebhookEvent.signature`), so a second check can compare it without a new column, which is why nothing is added now.

## Consequences

- A reopened case is never born already breached, and its warn and breach notices fire again for the new deadline; the statutory date still shows when the original promise was missed.
- During a backlog, a due statutory deadline can wait a run or more behind lower-id cases (decision 2).
- A session with one-sided rows and a silent Stream waits up to a day past its booked end before ops sees it as `INCONCLUSIVE` (decision 3).

## Deprecated & Superseded Approaches

- **Reopen keeping the first resolution deadline.** Superseded by decision 1.
- **SLA notice dedupe by `id notIn` lists, and statutory-deadline-first ordering.** Superseded by id paging and in-memory skipping (decision 2).
- **Settling an absence from webhook rows alone.** Superseded by decision 3.
- **A dispatcher that claims for itself, and one reclaim function with two modes.** Superseded by decision 4.
