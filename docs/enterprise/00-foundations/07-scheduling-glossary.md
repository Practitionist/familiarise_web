---
title: The scheduling glossary
band: 00-foundations
audience: sde3
status: live
last-reviewed: 2026-09-14
---

# The scheduling glossary

Eight distinct concepts used to hide behind the words "slot" and "session" in
this codebase, and the June 2026 domain audit found that the blur had caused
real bugs and real review confusion. Issue #1554 finished the fix that audit
started: the two words are now retired as identifiers everywhere except
Better Auth's own `Session` model, and `scripts/ci/check-terminology.ts`
fails the build if either word comes back. The chain going forward is
**availability window → bookable interval → appointment occurrence →
appointment → engagement → meeting**, with trials and auth sessions as
separate things.

## The nine concepts

**Availability window.** The hours a consultant offers, never booked
directly. Implemented by `AvailabilityWindowWeekly` (recurring, with a frozen
`utcOffsetMinutes` — the #503 DST fragility lives here) and
`AvailabilityWindowCustom` (one-off). Consultants create and edit these; the
scheduling engine only reads them.

**Bookable interval** (transient). A computed, plan-duration-sized cut of
availability shown in the picker. It exists only between the availability
fetch and the checkout submit, implemented by the `AvailabilityInterval` shape
in `utils/scheduling-engine/intervals.ts` and the `TIntervalTiming` type the
picker receives it as. It carries the `availabilityId` binding that the #788
merge guard protects.

**Appointment occurrence.** One row per held call — the atomic scheduling
unit, and the unit an engagement or a review is ultimately about.
Implemented by `AppointmentOccurrence`: `ordinal` is its 1-based position
within the appointment and a rescheduled call keeps its number rather than
being renumbered; `isTentative` flips false at webhook confirmation;
`completionStatus` (`OccurrenceCompletionStatus`) walks SCHEDULED →
COMPLETED/UNVERIFIED/CANCELLED/RESCHEDULED. There are no 30-minute atom rows
underneath it — the reset deleted that layer. `AppointmentParticipant` is the
only participant list; the old implicit slot↔user join table is gone.

**Appointment.** The polymorphic wrapper grouping one or more appointment
occurrences under exactly one of consultation, subscription, webinar, cohort
(the model behind the "class" a customer buys), or trial, and — since the 2026-09-12 decision — exactly one purchase per
appointment (`Appointment.subscriptionId` and `Appointment.cohortId` are
`@unique`; the old multi-purchase "siblings" payload is gone). Tentative-
created at checkout, confirmed by the payment webhook, auto-completed by
cron.

**Cohort.** The live, multi-session, capacity-bound group offering a
customer buys as a "class": one run that starts together, moves through one
fixed schedule and finishes together. Implemented by `CohortPlan` (the terms
sold — `totalSessions`, `sessionsPerWeek`, `maxParticipants`) and `Cohort`
(one run of that plan, with `CohortStatus` and its own scheduling window);
`Appointment.cohortId` is `@unique` and `AppointmentsType.COHORT` names the
type. The word was chosen at the reset (#1640) because the run is bounded and
shared, which "class" is not, and because `Class` collides with the mobile
codegen's own `Class`. Customer-facing copy keeps saying "class"; only the
identifiers say cohort.

**Engagement.** The enterprise consumption unit: one appointment booked under
an org program, metered by `engagementsUsed` on the program assignment. This
is the billing meter — when enterprise code says "engagement," it means
money. Consumption is currently hardcoded to one per booking regardless of
occurrence count (#710).

**Meeting.** The Stream.io video call record for one appointment occurrence
(`Meeting`, created lazily at "Start Call," not at confirmation, with the
Stream call id `occurrence-<id>` or `occurrence-<id>-r<suffix>` after a
rebuild). A confirmed occurrence without a meeting is a valid state.
`MeetingAttendance` is keyed to the occurrence itself
(`appointmentOccurrenceId`), so the "were you there" gate does not have to
join through `Meeting`.

**Trial.** A trial booking (`Trial`, `TrialStatus`), optionally
org-attributed via `organizationId` — pure attribution for conversion
analytics. The org attribution itself carries no referral or money logic; a
paid trial charges the consultee directly, never the org.

**Auth session.** Better Auth's `Session` model and the `useSession` hook.
Nothing to do with scheduling, untouched by #1554, and nothing else may ever
be renamed to "Session."

## The customer-facing word

Customer-facing copy is still allowed to say "session" for one occurrence of
a call — that word choice is a product decision, not a code identifier, and
`scripts/ci/check-terminology.ts` only scans identifiers and known routes,
never prose the customer reads. In code, "session" as a concept maps to
`AppointmentOccurrence`; none of the pre-#1554 "slot of appointment,"
"meeting session," "trial session," "session type," or "session view-model"
names remain anywhere in this repository, and a pull request that
reintroduces one of them is a bug report against itself — the guard fails
the build on the retired identifier list it carries.

The plan fields `sessionDurationInHours`, `totalSessions` and
`sessionsPerWeek` mean _occurrences per plan_ — they are appointment-adjacent
counts, not video calls and not auth sessions. The first two predate this
glossary and are kept under the schema freeze; `sessionsPerWeek` joined them
via ADR 24, which unified `SubscriptionPlan.callsPerWeek` and
`CohortPlan.meetingsPerWeek` under one name (#1011). This document is their
disambiguation, and they are not renamed by #1554 because they are plan-shape
fields, not the retired scheduling identifiers.

"Enterprise referrals" is not a feature. The phrase has been used loosely for
three unrelated real things: trial attribution (`Trial.organizationId`), the
deliberate rule that personal referral credits are force-disabled on
org-funded bookings (`fundingSource !== "PERSONAL"`), and B2C consultant
qualification events. The June 2026 decision: retire the phrase; org-level
acquisition incentives, if ever wanted, are a new post-launch-schema
subsystem.

## Retired identifiers and their replacements (#1554, PR #1638; #1640)

This table is the one place that maps the names the code used before the reset to the names it uses now. Older issues, pull requests and engineering-log entries keep the old names because they describe the code as it was; when one of them is picked up, read it through this table rather than editing it. The retired names are refused in code by `scripts/ci/check-terminology.ts`, so a change that reintroduces one fails CI with a pointer back here.

| Retired name                                                                   | Current name                                                                                                | Note                                                                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SlotOfAvailabilityWeekly`, `SlotOfAvailabilityCustom`                         | `AvailabilityWindowWeekly`, `AvailabilityWindowCustom`                                                      | Offered hours; two models because the shapes share no columns.                                          |
| `SlotOfAppointment` (one row per 30-minute atom)                               | `AppointmentOccurrence` (one row per held call, with `ordinal`)                                             | The thirty-minute rows are gone; a rescheduled call keeps its `ordinal`.                                |
| implicit `_SlotOfAppointmentToUser` join                                       | `AppointmentParticipant`                                                                                    | The only roster; written on every creation path.                                                        |
| `SlotCompletionStatus`                                                         | `OccurrenceCompletionStatus`                                                                                | Values unchanged.                                                                                       |
| `MeetingSession`, `meetingSessionId`                                           | `Meeting`, `meetingId`                                                                                      | The Stream call record, keyed by `appointmentOccurrenceId`.                                             |
| `MeetingRecordingConsent`                                                      | `RecordingConsent`                                                                                          | Keyed by `meetingId`.                                                                                   |
| `TrialSession`, `TrialSessionStatus`, `trialSessionPaid`                       | `Trial`, `TrialStatus`, `trialPaid`                                                                         |                                                                                                         |
| `AppointmentFeedback.slotOfAppointmentId`                                      | `AppointmentFeedback.appointmentOccurrenceId` (nullable)                                                    | NULL means the rating is about the whole booking.                                                       |
| `RescheduleProposedSlot`, `releasedSlotIds`                                    | `RescheduleProposedTime`, `releasedOccurrenceIds`                                                           |                                                                                                         |
| `ConsultantReview.ratedSessionAt`                                              | `ratedOccurrenceAt`                                                                                         |                                                                                                         |
| `SessionType`, `ConsultantProfile.sessionTypes`                                | `OfferingFormat`, `offeringFormats`                                                                         |                                                                                                         |
| `Feedback`, `FeedbackStatus`                                                   | `PlatformFeedback`, `PlatformFeedbackStatus`                                                                | Product feedback about the platform.                                                                    |
| `Collaborator.canApprovePayment/canViewAnalytics/canEditEvent/canSeeAttendees` | `Collaborator.tier` (`PRESENTER`, `CREW`)                                                                   | Only `canSeeAttendees` was ever enforced.                                                               |
| `ErasureRequest.pendingStreamRevocations` (never shipped)                      | `StreamRevocationRetry`                                                                                     | A typed outbox row per failed revocation.                                                               |
| `utils/slotAllocation/*`, `SlotAllocationService`                              | `utils/scheduling-engine/*`, `SchedulingService`                                                            | `ScheduleValidationService`, `ScheduleCalculationService`, `intervals.ts` likewise.                     |
| `lib/appointments/{slots,contiguous-slot-run,sessions-of}.ts`, `SessionVM`     | `lib/appointments/occurrences.ts`, `OccurrenceVM`                                                           | The run-grouping layer was deleted.                                                                     |
| `/api/slots/*`                                                                 | `/api/scheduling/*`                                                                                         |                                                                                                         |
| Stream call id `slot-<id>`                                                     | `occurrence-<id>` (`-r<suffix>` after a rebuild)                                                            |                                                                                                         |
| `Class`, `ClassPlan`, `ClassContent`, `ClassStatus`, `classId`, `CLASS`        | `Cohort`, `CohortPlan`, `CohortContent`, `CohortStatus`, `cohortId`, `COHORT` — renamed in #1640 (PR #1644) | Customer copy keeps saying "class"; `/api/plans/classes` and `/api/bookings/classes` became `/cohorts`. |
