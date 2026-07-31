# Booking Algorithm Change Checklist

> Run through this checklist after ANY change to the booking system.
> Each section lists invariants that MUST hold. If you break one, fix it before merging.
>
> Last updated: 2026-03-06 (PR #462)

---

## 1. Auth & Authorization

- [ ] All write endpoints (POST/PUT/PATCH/DELETE) require `getSession()` authentication
- [ ] Ownership verified: `consultantProfile.userId === session.user.id` on mutations
- [ ] Bulk consultant settings route (`/api/user/consultants/[id]`) enforces ownership on PUT and DELETE
- [ ] Checkout validates availability slot belongs to plan's consultant (not cross-consultant)
- [ ] Consultant-only operations (webinar/class reschedule) reject consultee callers
- [ ] Admin/Staff override paths explicitly check privileged roles
- [ ] GET endpoints that return PII (email, phone) are scoped or redacted

## 2. Data Validation

- [ ] `validateWeeklySlotTimeOrder()` called on all weekly slot creation/update paths (including bulk save + onboarding)
- [ ] Bulk save route checks intra-set overlap via `slotsOverlap()` before writing
- [ ] Bulk save route rejects overlapping custom slot submissions, not only weekly
- [ ] Onboarding persistence (`onboarding-server.ts`) enforces same weekly/custom validation as availability CRUD routes
- [ ] Same-day: `startTimeUtc < endTimeUtc` enforced
- [ ] Overnight: `endDay` is next day after `startDay`, and `startTimeUtc > endTimeUtc`
- [ ] Minutes range validated: 0-1439 (inclusive), `Number.isInteger()` check
- [ ] `typeof` check before `Number.isInteger()` on PATCH paths (partial updates)
- [ ] Custom slot date ordering: `startsAt < endsAt`
- [ ] `Date.parse()` validation on ISO string inputs (reject malformed dates with 400)
- [ ] Duration validation: reject zero, negative, or unreasonably large values
- [ ] Scheduling period validation checks full slot interval (`slot + 30min <= endDate`), not just start

## 3. Overnight / Cross-Midnight Handling

- [ ] Weekly slot creation allows overnight (`startDay !== endDay`)
- [ ] `buildWeeklyOverlapWhere()` same-day branch covers 3 shapes:
  - Same-day time overlap
  - Previous-day overnight carry-over into our day
  - Overnight slots starting on our day
- [ ] `buildWeeklyOverlapWhere()` overnight branch covers 5 shapes:
  - Same-day slots on startDay after our start
  - Same-day slots on endDay before our end
  - Other overnight slots starting on same day
  - Other overnight slots ending on same endDay
  - **Existing overnight carry-over into our startDay** (C1 fix)
- [ ] `isMinuteWithinWeeklySlot()` handles: same-day, start-day with midnight overflow, next-day
- [ ] Checkout uses `isMinuteWithinWeeklySlot()` (not same-day-only guard)
- [ ] `SlotAllocationService.isWithinAvailability()` delegates to `isMinuteWithinWeeklySlot()`
- [ ] `SlotValidationService.validateMatchesSchedule()` handles overnight in both directions
- [ ] Unallocated weekly routes roll `slotEnd` to next UTC day for overnight slots

## 4. Overlap & Conflict Detection

- [ ] Weekly overlap query (`buildWeeklyOverlapWhere`) uses all clauses per section 3
- [ ] Custom overlap uses proper range predicate (`startsAt < end AND endsAt > start`)
- [ ] Conflict detection (`validateNoConflicts`) scoped to consultant via M2M `user.some.id`
- [ ] `removeBookedSlots()` scoped to consultant's `userId` (not global query)
- [ ] Checkout validates against correct consultant's booked slots
- [ ] Expired `APPROVED_PENDING_PAYMENT` treated as available (not blocking)
- [ ] Tentative slots excluded from conflict checks during reschedule

## 5. Slot Allocation

- [ ] Auto-allocate sorts weekly slots by calendar occurrence (not raw `startTimeUtc`)
- [ ] `getNextOccurrenceWeekly()` advances to next week if target time already passed today
- [ ] Consecutive block detection works for multi-slot sessions (30min x N)
- [ ] Week counting uses `SlotCalculationService.countWeeks()` (single source of truth)
- [ ] `slotsPerCall` computed correctly from `sessionDurationInHours`
- [ ] Subscription: max `sessionsPerWeek` per week, distributed across scheduling period
- [ ] Class: respects scheduling period boundaries, max sessions/day
- [ ] Webinar: finds single consecutive block within search window
- [ ] Consultation: same-day consecutive block

## 6. Locking & Concurrency

- [ ] All lock acquisitions wrapped in try-finally with unlock in finally
- [ ] Lock TTL (130s) > transaction timeout (120s)
- [ ] Error messages contain "Lock contention:" prefix or "in progress" for classifier
- [ ] `classifyError()` matches both `"lock"` and `"in progress"` patterns for 409 status
- [ ] Event semaphores (`lockEventCheckout`) decremented on failure/error
- [ ] Auto-allocate uses consultant-level lock (`lockAutoAllocate`)
- [ ] Slot-level lock (`lockSlotBooking`) keys on ISO timestamp string

## 7. Checkout & Payment

- [ ] Availability slot ownership verified (`consultantProfile.userId === consultantUserId`)
- [ ] Weekly guard uses `isMinuteWithinWeeklySlot()` (overnight-aware)
- [ ] Custom guard checks `slotStart >= startsAt && slotEnd <= endsAt`
- [ ] Slot timing validation: not in past, minimum lead time (`validateSlotTiming`)
- [ ] Plan existence verified inside transaction
- [ ] Webinar/Class capacity checked (`maxParticipants` vs current participants)
- [ ] Both consultant AND consultee connected to `SlotOfAppointment` via M2M
- [ ] Payment webhook handling is idempotent (check existing status before updating)

## 8. Frontend

- [ ] Unscheduled events filtered: both webinars AND classes use `.filter(e => !e.appointment)`
- [ ] `useSlotAllocation` hook: correct `requiredSlots` for SUBSCRIPTION and CLASS types
- [ ] Calendar renders overnight slots correctly (split across two days if needed)
- [ ] Main UI save paths (onboarding + settings) create single overnight weekly records (not split at midnight)
- [ ] Frontend validator (`isValidTimeRange`, `validateTimeSlot`) accepts overnight slots
- [ ] Timezone handling uses `minuteUtcToDate()` for weekly slot display
- [ ] Slot selection UI prevents selecting past slots
- [ ] Loading states shown during slot fetch operations

## 9. API Routes

- [ ] All mutation routes authenticated (session check before processing)
- [ ] Rate limiting on checkout (tentative booking count) and requests (per-user)
- [ ] Pagination on list endpoints (avoid unbounded queries)
- [ ] Error responses use correct HTTP status codes:
  - 400: validation errors, bad input
  - 401: unauthenticated
  - 403: unauthorized (wrong role)
  - 409: conflict (lock contention, slot already booked)
  - 500: unexpected server errors only
- [ ] Stream channel cleanup: paginated + restricted to managed namespace prefixes

## 10. Status Transitions

- [ ] PENDING -> APPROVED -> SCHEDULED path works end-to-end
- [ ] Cancellation releases slots (deletes `SlotOfAppointment` records)
- [ ] Reschedule marks existing slots as `isTentative` before re-allocation
- [ ] 24-hour reschedule restriction enforced
- [ ] Cron jobs transition: auto-complete past appointments, expire stale pending

## 11. Database Integrity

- [ ] M2M `_SlotOfAppointmentToUser` connects BOTH consultant AND consultee
- [ ] Cascading deletes: `ConsultantProfile` -> `SlotOfAvailabilityWeekly/Custom`
- [ ] No orphaned slots after cancellation (cleanup or cascade)
- [ ] Migration safety: no destructive migrations without data migration plan on prod
- [ ] Seed data includes `_SlotOfAppointmentToUser` rows for test appointments

## 12. Cron Jobs & Background Tasks

- [ ] Stale pending request cleanup runs on schedule
- [ ] Tentative slot cleanup removes expired tentative bookings
- [ ] Request expiry transitions old PENDING requests
- [ ] Auto-complete marks past appointments as COMPLETED
- [ ] Cron jobs are idempotent (safe to re-run without side effects)
- [ ] No cron job modifies data outside its documented scope

---

## Quick Smoke Test After Changes

1. **Overnight slot creation:** Create Mon 22:00->Tue 02:00 availability, book at Tue 01:00
2. **Cross-consultant rejection:** Use consultant A's plan with consultant B's avail ID -> expect error
3. **Auto-allocate ordering:** With Mon 09:00 and Tue 08:00 slots, auto-allocate picks Monday first
4. **Unscheduled classes:** Dashboard shows only unscheduled classes in "Set Schedule" section
5. **Overnight overlap:** Create Mon 22:00->Tue 02:00, then try Tue 01:00->Wed 03:00 -> overlap rejected
6. **Auth on writes:** Unauthenticated POST to `/api/slots/availability/weekly` -> 401
7. **Lock contention:** Two concurrent auto-allocations for same consultant -> one gets 409
8. **Unallocated overnight:** Mon 22:00->Tue 02:00 with Tue 01:00 booking is excluded from both `/api/slots/unallocated/weekly` and `/api/slots/unallocated/[consultantId]`
9. **Midnight boundary:** 22:00→00:00 weekly availability saves with `endTimeUtc=0` on next day (not `1439` on same day); 23:30→00:00 slot is bookable
10. **Scheduling period boundary:** A 1-hour session ending after `schedulingPeriodEndsAt` is rejected even if its last slot starts exactly at the end time

---

## Key File Paths

| Area                | Files                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| Availability CRUD   | `app/api/slots/availability/weekly/route.ts`, `weekly/[id]/route.ts`, `custom/route.ts`, `custom/[id]/route.ts` |
| Public availability | `app/api/slots/availability/[consultantId]/route.ts`, `availability-with-allocation/[consultantId]/route.ts`    |
| Checkout            | `lib/payments/operations/checkout.ts`, `schemas/checkout.ts`                                                    |
| Slot utils          | `utils/slotAllocation/slotTimeUtils.ts` (overlap, overnight matching, time conversion)                          |
| Allocation engine   | `utils/slotAllocation/SlotAllocationService.ts`                                                                 |
| Validation engine   | `utils/slotAllocation/SlotValidationService.ts`                                                                 |
| Calculation         | `utils/slotAllocation/SlotCalculationService.ts`                                                                |
| Occupancy policy    | `utils/slotAllocation/occupancyPolicy.ts`                                                                       |
| Locking             | `utils/appointmentlock.ts`                                                                                      |
| Cancel/Reschedule   | `app/api/appointments/[appointmentId]/cancel/route.ts`, `reschedule/route.ts`                                   |
| Request flow        | `app/api/slots/request-for-approval/route.ts`                                                                   |
| Frontend hook       | `app/dashboard/consultant/[consultantId]/(features)/shared/hooks/useSlotAllocation.ts`                          |
| Stream cleanup      | `actions/stream/chat/event-channel.action.ts`                                                                   |
| Appointments page   | `app/dashboard/consultant/[consultantId]/(features)/appointments/page.tsx`                                      |
| Onboarding          | `app/form/onboarding/components/ConsultantPreferredScheduleForm.tsx`                                            |

## Bugs Fixed in PR #462 (Reference)

| Fix                   | Description                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Auth on CRUD          | Added `getSession()` + ownership to all availability write endpoints                                              |
| Overnight validation  | `validateWeeklySlotTimeOrder()` allows cross-midnight with next-day check                                         |
| Overlap detection     | `buildWeeklyOverlapWhere()` with 3 same-day + 5 overnight clauses                                                 |
| Allocator overnight   | `isWithinAvailability()` refactored to shared `isMinuteWithinWeeklySlot()`                                        |
| removeBookedSlots     | Scoped to consultant via M2M `user.some.id` filter                                                                |
| Lock classification   | Prefixed errors with "Lock contention:", classifier matches "in progress"                                         |
| DELETE wrong table    | Removed broken `slotOfAppointment` check, replaced with ownership verify                                          |
| PUT authoritative ID  | Uses `currentSlot.consultantProfileId` not body param                                                             |
| Stream pagination     | Added pagination loop + `MANAGED_PREFIXES` filter                                                                 |
| Checkout ownership    | Verifies avail slot's `consultantProfile.userId === consultantUserId`                                             |
| Checkout overnight    | Uses `isMinuteWithinWeeklySlot()` instead of same-day-only guard                                                  |
| Sort by calendar      | Auto-allocate sorts by `getNextOccurrenceWeekly()` not clock time                                                 |
| Class filter          | Appointments page filters classes same as webinars (`!c.appointment`)                                             |
| Midnight overflow     | `isMinuteWithinWeeklySlot` checks overflow past 1440                                                              |
| Date validation       | `custom/[id]` PUT/PATCH validates `Date.parse()` before constructing                                              |
| PATCH integers        | Added `typeof` check before `Number.isInteger()` on PATCH                                                         |
| Docs update           | Field names updated to match new schema                                                                           |
| Unallocated overnight | Unallocated routes roll `slotEnd` to next day for overnight weekly slots                                          |
| Scheduling boundary   | `validateSchedulingPeriod` checks `slot + 30min <= endDate` (server + client)                                     |
| Bulk route auth       | `/api/user/consultants/[id]` PUT/DELETE enforce ownership (`userId === session.user.id`)                          |
| Bulk route validation | Bulk save runs `validateWeeklySlotTimeOrder()` + `slotsOverlap()` + custom `startsAt < endsAt`                    |
| Frontend overnight    | `isValidTimeRange` / `validateTimeSlot` accept overnight slots; formatting produces single overnight records      |
| Bulk custom overlap   | Bulk settings route rejects overlapping custom slot submissions (pairwise check)                                  |
| Onboarding validation | `onboarding-server.ts` runs `validateWeeklySlotTimeOrder()`, `slotsOverlap()`, and custom overlap/ordering checks |
