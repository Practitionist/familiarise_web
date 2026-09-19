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

| To ↓ From →                  | PENDING                                         | APPROVED                                                     | APPROVED_PENDING_PAYMENT                                                                                                                                                                  | SCHEDULED | COMPLETED | REJECTED | CANCELLED | EXPIRED |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | -------- | --------- | ------- |
| **PENDING**                  |                                                 |                                                              | ✓                                                                                                                                                                                         |           |           |          |           |         |
| **APPROVED**                 | ✓                                               | ✓ self-edge only via `fromIn` (`ALLOCATION_APPROVABLE_FROM`) | ✓                                                                                                                                                                                         |           |           |          |           |         |
| **APPROVED_PENDING_PAYMENT** | ✓                                               | ✓                                                            |                                                                                                                                                                                           |           |           |          |           |         |
| **SCHEDULED**                |                                                 | ✓                                                            | ✓                                                                                                                                                                                         |           |           |          |           |         |
| **COMPLETED**                |                                                 | ✓                                                            |                                                                                                                                                                                           | ✓         |           |          |           |         |
| **REJECTED**                 | ✓                                               |                                                              | ✓                                                                                                                                                                                         |           |           |          |           |         |
| **CANCELLED**                | ✓                                               | ✓                                                            | ✓                                                                                                                                                                                         | ✓         |           |          |           |         |
| **EXPIRED**                  | ✓ (48 h consultation / 30 d subscription sweep) | ✓ (PR 2c: APPROVED-unallocated cohort)                       | ✓ (consultation: the 24 h pay-link sweep since #1724, with a consultee notice; subscription: only the 7 d `updatedAt` fallback in `expirePaymentPendingRequests`, with no notice — #1732) |           |           |          |           |         |

Two rows deserve a note. `PENDING` is reachable only from `APPROVED_PENDING_PAYMENT` in the map; the reschedule route's consultation restore to `PENDING` passes its own `fromIn` and is listed in the raw-writer inventory below. `SCHEDULED` is declared for consultations and subscriptions and its edges are legal, but no writer ever transitions either request type to it: allocation re-stamps `APPROVED`, completion goes `APPROVED → COMPLETED`, and the only `SCHEDULED` writes in the codebase are on `AppointmentOccurrence.completionStatus`, `Webinar`/`Class` and `Trial`. Treat it as an unreachable state on these two entities until a writer appears.

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
