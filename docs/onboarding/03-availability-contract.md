---
title: Availability contract
band: onboarding
audience: sde1
status: live
last-reviewed: 2026-09-18
---

# Availability contract

A consultant publishes the hours they offer either as a weekly pattern (`ScheduleType.WEEKLY`, rows in `AvailabilityWindowWeekly`) or as concrete dates (`ScheduleType.CUSTOM`, rows in `AvailabilityWindowCustom`). The two are exclusive: the booking engine reads only the arm the profile's `scheduleType` names, so the dormant arm must hold nothing. Until 2026-09-18 three independent copies of "validate and replace" existed — the onboarding sync, the per-row routes and the settings PUT — and they had drifted: only onboarding enforced the window-length bound, nothing on the server refused an empty set, and the settings PUT flipped the schedule type in a separate write from the rows it replaced. This document is the single rule set they now share, and where each rule is enforced.

## The rules

Every write path validates through `lib/scheduling/availability-contract.ts` before it touches the database. The table below lists each rule with the refusal code a route answers with; all of them are the caller's fault and answer 400.

| Code       | Rule                                                                                                                                                                                   | Applies to                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `EMPTY`    | The chosen schedule type must carry at least one window. A consultant with a type and no rows is unbookable and no guard would notice.                                                 | Whole-set writes (onboarding, settings PUT). Per-row routes validate one row, so they pass `allowEmpty`. |
| `RANGE`    | Weekly minutes are whole numbers from 0 to 1439; custom instants must parse.                                                                                                           | Both                                                                                                     |
| `ORDER`    | A same-day weekly window starts before it ends; an overnight one ends on the next weekday and crosses midnight (`validateWeeklySlotTimeOrder`). A custom window starts before it ends. | Both                                                                                                     |
| `DURATION` | A window lasts between 30 minutes and 12 hours, measured across midnight for overnight rows.                                                                                           | Both                                                                                                     |
| `OVERLAP`  | No two windows in the submitted set overlap; back-to-back is allowed and folded into one row on save (#1320).                                                                          | Whole-set writes. Per-row routes check overlap against the stored rows inside their transaction instead. |
| `PAST`     | A custom window that has already ended is refused; one still in progress is kept so a mid-window edit does not erase today.                                                            | Custom only                                                                                              |

The wizard enforces the same bounds on the client (`utils/scheduling-engine/interval-validation.ts`) plus 15-minute increments for the pickers; the increments are a UI nicety, not a contract rule, so a per-row API caller may submit any whole minute.

## Where each write path enforces it

The table below names every path that writes availability and what it does after validating.

| Path                                                                                                                                                   | Validation                                                                                                         | Write                                                                                                                                      | Settlement                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Onboarding sync (`utils/onboarding-server.ts::syncAvailabilitySlots`) and its wire schema (`utils/onboarding.ts::ConsultantProfileCreateObjectSchema`) | `assertWeeklyWindows` / `assertCustomWindows`; the Zod schema refuses the empty set before the transaction starts. | Deletes both tables, creates the chosen arm inside the onboarding transaction.                                                             | `recomputeProfileCompletion` inside the same transaction.                           |
| Settings PUT (`app/api/user/consultants/[id]/route.ts`)                                                                                                | `validateWeeklyWindows` / `validateCustomWindows` on the submitted set, answered as `{ error, code, index }`.      | One Serializable transaction: schedule-type guard re-read through `tx`, CAS flip of `scheduleType`, profile scalars, both tables replaced. | `settleAvailabilityWrite(tx, id)` — the shrink notice and the completion recompute. |
| Per-row routes (`app/api/scheduling/availability/{weekly,custom}` and `[id]`)                                                                          | `validateWeeklyWindow` / `validateCustomWindow` on the one row, after the route's own field checks.                | The existing Serializable transaction with the overlap read and the coalesce (#1320).                                                      | `settleAvailabilityWrite` inside the transaction (delete runs it after the delete). |

## Switching schedule type

Switching WEEKLY↔CUSTOM deletes every row of the old arm, so it is a hard block while anything is booked against the old hours. `checkActiveAppointments` (`app/api/user/consultants/utils/consultant-appointments.ts`) counts consultations and subscriptions in PENDING/APPROVED/APPROVED_PENDING_PAYMENT/SCHEDULED, webinars and classes in SCHEDULED/IN_PROGRESS with a future occurrence, trials in SCHEDULED/AWAITING_PAYMENT (the occupancy policy treats both as a live hold; they were missing until 2026-09-18) and open reschedule requests. The settings PUT runs it once as a pre-flight, then again inside the Serializable transaction and flips the type with `updateMany where scheduleType = previous` — a booking that lands between the two reads is caught (400 `SCHEDULE_SWITCH_BLOCKED`), and a second tab that already switched is told to reload (409 `SCHEDULE_SWITCH_CONFLICT`). `GET /api/user/consultants/[id]/can-switch-schedule` is the owner-only pre-flight the settings UI uses to disable the radio.

## Shrinking availability within a type

Narrowing or deleting a window that a future SCHEDULED occurrence sits inside is allowed. A booking is a contract — the occurrence is a materialized row with its own start and end — while the published hours are an offer for new bookings; Calendly and Cal.com behave the same way. The write therefore succeeds, and the response carries `uncoveredUpcoming: { count, appointmentIds }` computed by `lib/scheduling/uncovered-upcoming.ts` (the first 500 upcoming occurrences, tested atom by atom against the stored rows with the allocator's own `findUncoveredAtom`). The settings page turns a non-zero count into the save toast; rescheduling or cancelling stays the consultant's explicit act from the appointments page. Reallocation on shrink remains open in #1495.

## Profile completion

`ConsultantProfile.profileCompletionPercentage` is computed by `lib/profiles/profile-completion.ts` (#698 OB-1) from the description, headline, experience, domain detail, availability, plans, work experience, image and verification, with weights pinned in `__tests__/profiles/profile-completion.test.ts`. It is recomputed at the end of onboarding, by every availability write through `settleAvailabilityWrite`, and by a verification decision. Plan CRUD does not yet recompute it; the next availability or profile save catches up.

## Tests

`__tests__/scheduling/availability-contract.test.ts` pins every refusal code and both boundaries; `__tests__/scheduling/active-appointments-guard.test.ts` pins the trial and reschedule buckets of the switch guard; `__tests__/profiles/profile-completion.test.ts` pins the weights.
