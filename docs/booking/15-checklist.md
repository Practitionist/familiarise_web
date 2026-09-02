# Booking Algorithm Change Checklist

> Run through this checklist after any change to the booking system. Each section lists an invariant that must hold before merging.
>
> Last updated: 2026-09-02 (wave 5, PR 11, `docs/booking-wave-5`).

---

## 1. Status writes go through the CAS helpers

Every write to `Appointment`/`Consultation`/`Subscription`/`Webinar`/`Class`/`TrialSession`/`RescheduleRequest` status goes through the guarded transition helpers in `lib/booking/transitions.ts` (`transitionConsultationRequest`, `transitionSubscriptionRequest`, `transitionWebinarEvent`, `transitionClassEvent`, `transitionSlotCompletion`, `transitionTrialSession`, `transitionRescheduleRequest`). Each helper bakes the allowed-from set into the `updateMany`'s WHERE clause, so a write against a row that already left that set matches zero rows and throws `IllegalTransitionError` instead of silently corrupting state. A raw `update`/`updateMany` on any of these status columns is a defect, not a shortcut. `SlotOfAppointment.completionStatus` has the same guard, via `transitionSlotCompletion`.

## 2. Nothing is deleted

Cancellation is a status write, never a row deletion. The appointment stays in place with its terminal status; its slots move to `completionStatus: CANCELLED` via `transitionSlotCompletion`, and are never `delete`d — a `SlotOfAppointment` row can carry Stream `MeetingSession`/`Recording` foreign keys, and a `Payment` row can point at the appointment itself. Reschedule follows the same rule: replaced slots move to `RESCHEDULED` in place rather than being removed. A slot is freed for rebooking by its status leaving the occupied set (`utils/slotAllocation/occupancyPolicy.ts`), never by the row disappearing.

## 3. Locking: one namespace per atom, bounded retry budgets

Every lock key is minted in `utils/appointmentlock.ts`. A slot atom is 30 minutes of one consultant's calendar; `lockSlotInterval` keys each atom the booking window covers as `slot-booking:<consultantProfileId>:<atomISO>`, with the start floored to the half-hour grid (`slotAtomStarts`) so an unaligned booking still collides with the aligned atoms it overlaps. `lockSlotBooking` is `lockSlotInterval` under another name and is the lock every direct slot writer takes, trials included — trials hold no lock namespace of their own. The other namespaces are `consultee-booking:<userId>`, `event-checkout:<type>:<eventOrPlanId>`, `auto-allocate:<consultantProfileId>[:scope]`, and `appointment-lock:<appointmentId>` for cancel/reschedule lifecycle mutations. Lock order is a total order — event/consultant → consultee → slot — so it cannot deadlock.

Retry budgets are bounded on every request path: `REQUEST_PATH_RETRY_CONFIG`, `INTERVAL_RETRY_CONFIG`, and `CHECKOUT_WAIT_RETRY_CONFIG` each cap at 5 retries, roughly 7 seconds worst case, well inside the platform's function ceiling. `DEFAULT_RETRY_CONFIG` (10 retries, up to ~205 seconds) exists only for callers that genuinely run outside a request; a request-path caller that reaches for it will time out as a 504 instead of returning a 409. TTLs are sized per lock kind, not a single constant — `APPOINTMENT_LOCK_TTL_MS` is 75s, `CHECKOUT_LOCK_TTL_MS` ranges from 60s (consultation) to 600s (class, sized for the serverless-freeze worst case), and interval locks re-arm to a fresh shared deadline once every atom in the run is held so an early atom's TTL cannot erode across a multi-atom acquisition.

## 4. Hold expiry is a predicate, not a cron-only fact

A slot held by an `APPROVED_PENDING_PAYMENT` request, or a `PENDING` `DIRECT_CHECKOUT` request, only counts as occupied while at least one of its payments is still alive. `isOccupiedByLiveAppointment` (`utils/slotAllocation/SlotValidationService.ts`) is the JS predicate used wherever an appointment object is already in hand; `buildDeadHoldFilter` (`utils/slotAllocation/occupancyPolicy.ts`) is its SQL twin for callers that select slots directly, such as checkout's first pass and the trial route. A payment is dead when it is `EXPIRED`, `FAILED`, or still `PENDING` past its `expiresAt` — never by the clock alone against a `SUCCEEDED` row. Both predicates must agree; `hold-expiry-predicate.test.ts` asserts it.

## 5. Availability coalescing and union validation

A consultant's published availability can span several stored rows for what is, to the consultant, one contiguous window. `mergeAdjacentWeeklyRows` (`utils/slotAllocation/mergeAdjacentWeeklyRows.ts`) merges exactly-adjacent same-day, same-offset rows on every weekly-availability write (and once, idempotently, for existing rows); overnight rows and rows with different UTC offsets are left as-is. Checkout and the trial route validate a booking window against the union of a consultant's rows, not any single row: `loadPublishedCoverage` loads the weekly or custom rows for the active `scheduleType`, `windowAtoms` splits the requested window into 30-minute atoms, and `findUncoveredAtom` (all in `utils/slotAllocation/availabilityCoverage.ts`) returns the first atom no row covers, or `null` when the union covers the whole window.

## 6. Overnight / cross-midnight handling

- Weekly slot creation allows `startDay !== endDay`, validated by `validateWeeklySlotTimeOrder` (`utils/slotAllocation/slotTimeUtils.ts`).
- `buildWeeklyOverlapWhere` covers the overnight and same-day overlap shapes for weekly rows; `slotsOverlap` covers custom rows.
- `isMinuteWithinWeeklySlot` is the one predicate every caller uses to test a minute against a weekly row, overnight included — `SlotValidationService` and checkout both delegate to it rather than re-implementing the boundary math.

## 7. Checkout and payment

- `lib/payments/operations/checkout.ts` re-validates availability inside the transaction, against the union coverage described in §5, after the lock in §3 is held.
- Every checkout path has a counterpart on the refund side in `lib/payments/operations/booking-refund.ts` (one booking) or `lib/payments/operations/event-refunds.ts` (a whole webinar/class) — see `docs/payments/checkout-flow/`.
- A `free_` intent (`Payment.amount === 0`) never enters the hold-expiry predicate as a payment that can go dead in a way that frees the slot early; it has no gateway leg to expire.

## What to check before merging a booking change

1. Every new status write is a call into `lib/booking/transitions.ts`, not a raw `update`/`updateMany`.
2. Every new slot-occupying write takes a lock from `utils/appointmentlock.ts` under its existing namespace — never a new key shape for an atom that already has one.
3. Any lock acquired on a request path uses a bounded retry config (§3), not `DEFAULT_RETRY_CONFIG`.
4. Cancellation and reschedule code paths never call `delete`/`deleteMany` on `Appointment` or `SlotOfAppointment`.
5. Anything that decides "is this slot occupied" reads from `utils/slotAllocation/occupancyPolicy.ts` or the hold-expiry predicates in §4, not a hand-rolled status list.
6. Anything that validates a booking window against a consultant's published availability goes through `loadPublishedCoverage` + `findUncoveredAtom`, not a single-row check.
7. `IllegalTransitionError` is mapped to a 4xx response and never swallowed.

---

## Key File Paths

| Area                                       | Files                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Status transitions                         | `lib/booking/transitions.ts`                                                                                       |
| Locking                                    | `utils/appointmentlock.ts`                                                                                         |
| Occupancy / hold expiry                    | `utils/slotAllocation/occupancyPolicy.ts`, `utils/slotAllocation/SlotValidationService.ts`                         |
| Availability coalescing + union validation | `utils/slotAllocation/mergeAdjacentWeeklyRows.ts`, `utils/slotAllocation/availabilityCoverage.ts`                  |
| Slot time math                             | `utils/slotAllocation/slotTimeUtils.ts`                                                                            |
| Allocation engine                          | `utils/slotAllocation/SlotAllocationService.ts`                                                                    |
| Checkout                                   | `lib/payments/operations/checkout.ts`                                                                              |
| Cancel / reschedule                        | `app/api/appointments/[appointmentId]/cancel/route.ts`, `app/api/appointments/[appointmentId]/reschedule/route.ts` |
| Tests                                      | `__tests__/booking-algorithm/`, `__tests__/payments/`                                                              |
