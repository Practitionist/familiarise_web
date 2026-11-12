# API Reference

## Endpoints Overview

| Event Type   | Validate (POST)                             | Allocate (PATCH)                            |
| ------------ | ------------------------------------------- | ------------------------------------------- |
| Consultation | `/api/bookings/consultations/{id}/validate` | `/api/bookings/consultations/{id}/allocate` |
| Subscription | `/api/bookings/subscriptions/{id}/validate` | `/api/bookings/subscriptions/{id}/allocate` |
| Webinar      | `/api/bookings/webinars/{id}/validate`      | `/api/bookings/webinars/{id}/allocate`      |
| Class        | `/api/bookings/classes/{id}/validate`       | `/api/bookings/classes/{id}/allocate`       |

All endpoints require session-based authentication. The `{id}` parameter accepts UUID or CUID format.

---

## Slot Endpoint Authentication

All `/api/scheduling/` endpoints are covered by `AUTHENTICATED_API_PREFIXES` in middleware, meaning they require a valid session cookie. Two sub-paths are exempted as public:

| Path                                            | Auth Required | Notes                                                                   |
| ----------------------------------------------- | ------------- | ----------------------------------------------------------------------- |
| `/api/scheduling/availability/`                 | No            | Public -- consultees can view consultant availability without auth      |
| `/api/scheduling/availability-with-allocation/` | No            | Public -- includes allocation data for calendar display                 |
| `/api/scheduling/appointments` (GET)            | Yes           | Non-privileged users are filtered to their own profile only             |
| `/api/scheduling/appointments` (POST)           | Yes           | Admin/staff only                                                        |
| `/api/scheduling/appointments/[id]` (GET)       | Yes           | Requires participant check (consultant or consultee on the appointment) |

**Removed (booking-journey audit B3 / #1193)**: the `[id]` route's `PATCH` (blind delete-all + slot recreate with no conflict validation and no `consultantProfileId`, so recreated confirmed slots sat OUTSIDE the `occurrence_no_confirmed_overlap` guard), `PUT`, and `DELETE` (hard-delete bypassing the soft-cancel doctrine) handlers. No in-repo caller used them; slot mutations go through the allocator (`lib/booking/allocation`; allocate/reschedule/manage-timings), which carries locks, revalidation, and the GiST backstop.

### Status Filters

The `/api/scheduling/appointments` GET endpoint supports status filtering. The accepted status values depend on the event type:

| Event Type                  | Status Enum         | Valid Values                                      |
| --------------------------- | ------------------- | ------------------------------------------------- |
| Consultation / Subscription | `AppointmentStatus` | PENDING, APPROVED, APPROVED_PENDING_PAYMENT, etc. |
| Webinar / Class             | Event status        | SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED      |

---

## Validate Endpoints

**Method**: `POST /api/bookings/{type}/{id}/validate`

Pre-flight check before allocation. Returns which slots have conflicts, which are outside availability, and which are valid.

```mermaid
sequenceDiagram
    participant Client
    participant API as POST /validate
    participant Zod
    participant VS as ScheduleValidationService
    participant DB

    Client->>API: {slots: ["2025-01-15T10:00:00Z", "2025-01-15T10:30:00Z"]}
    API->>Zod: validationRequestSchema.parse(body)
    Zod-->>API: Validated slots
    API->>DB: Fetch event + consultant
    API->>VS: Check conflicts, availability, schedule
    VS->>DB: Query existing appointments
    VS-->>API: Conflict results
    API-->>Client: {data: {conflicts, outsideAvailability, validSlots}}
```

### Request

```json
{
  "slots": ["2025-01-15T10:00:00Z", "2025-01-15T10:30:00Z"]
}
```

Slots must be ISO 8601 datetime strings. Array must have at least 1 element.

### Response (200)

```json
{
  "data": {
    "conflicts": [
      {
        "slot": "2025-01-15T10:00:00Z",
        "existingAppointment": {
          "type": "CONSULTATION",
          "with": "John Doe",
          "time": "10:00 AM - 10:30 AM"
        }
      }
    ],
    "outsideAvailability": [{ "slot": "2025-01-15T14:00:00Z" }],
    "validSlots": ["2025-01-15T10:30:00Z"]
  }
}
```

### Subscription/Class Extensions

Subscription and class validate endpoints return additional fields:

```json
{
  "data": {
    "conflicts": [],
    "outsideAvailability": [],
    "validSlots": ["..."],
    "weeklyDistribution": {
      "2025-01-12": 2,
      "2025-01-19": 1
    },
    "totalScheduled": 3,
    "totalRequired": 10
  }
}
```

---

## Allocate Endpoints

**Method**: `PATCH /api/bookings/{type}/{id}/allocate`

Creates or replaces appointments for an event. Three allocation modes:

```mermaid
sequenceDiagram
    participant Client
    participant API as PATCH /allocate
    participant Zod
    participant SA as allocate (lib/booking/allocation)

    alt Auto mode
        Client->>API: {isAuto: true}
        API->>Zod: allocationRequestSchema.parse(body)
        API->>SA: allocate({mode: "auto", eventType, eventId})
        SA-->>API: {success: true, appointments: [...]}
    else Manual mode
        Client->>API: {isAuto: false, slots: ["..."]}
        API->>Zod: allocationRequestSchema.parse(body)
        API->>SA: allocate({mode: "manual", eventType, eventId, slots})
        SA-->>API: {success: true, appointments: [...]}
    else Requested mode
        Client->>API: {isAuto: false, useRequestedSlots: true}
        API->>Zod: allocationRequestSchema.parse(body)
        API->>SA: allocate({mode: "requested", eventType, eventId})
        SA-->>API: {success: true, appointments: [...]}
    end

    API-->>Client: {data: appointments, warnings?}
```

### Auto Mode Request

```json
{ "isAuto": true }
```

System finds the first available slots automatically. For consultations/webinars: first consecutive block. For subscriptions/classes: distributed across weeks.

### Manual Mode Request

```json
{
  "isAuto": false,
  "slots": ["2025-01-15T10:00:00Z", "2025-01-15T10:30:00Z"]
}
```

Slot count must be an exact multiple of `slotsPerSession`. Duplicates are rejected.

### Requested Mode Request

```json
{
  "isAuto": false,
  "useRequestedSlots": true
}
```

Approves pre-created appointments from a consultee's request. Verifies appointments exist and clears `isTentative` flags.

### Response (200)

```json
{
  "data": [
    {
      "id": "appointment-id",
      "appointmentType": "CONSULTATION",
      "appointmentOccurrences": [
        {
          "id": "slot-id",
          "startsAt": "2025-01-15T10:00:00.000Z",
          "endsAt": "2025-01-15T10:30:00.000Z",
          "isTentative": false
        }
      ]
    }
  ],
  "warnings": []
}
```

---

## Lifecycle Endpoints (#1846)

The endpoints in this section end, restore or remove a booking or an offering, and they were added or changed by #1846. The writers among them take the booking's appointment lock or the offering's checkout lock before their transaction, and they answer a held lock with the structured 423 `APPOINTMENT_BUSY` or 409 `EVENT_CHECKOUT_BUSY` and an unreachable Redis with a 503, never with a 500.

### Abandon an unpaid booking

**Method**: `POST /api/bookings/[bookingId]/abandon`

This is the one door a buyer uses to walk away from a booking they have not paid for (#1527 decision 11). The `bookingId` is the Appointment id. A consultation, subscription or trial ends `CANCELLED`, and a webinar or class seat hold releases only the caller's own `HELD` seat. The caller's `PENDING` payment expires by compare-and-swap, its referral credits and organisation engagement are given back, and the gateway order is cancelled after the transaction commits. The dispatch lives in `lib/booking/abandon.ts`, and [06-booking-lifecycle.md](./06-booking-lifecycle.md) describes each arm.

A successful call answers 200 with the body below.

```json
{
  "abandoned": true,
  "kind": "consultation",
  "paymentsExpired": 1,
  "slotsReleased": 2
}
```

The refusals carry a `code` next to the `error` text, as the following table shows.

| Status | Code              | Meaning                                                                                                                                                     |
| ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 404    | `NOT_FOUND`       | No booking with this id exists, or it is not the caller's; the two answers are the same so the door reveals nothing about other people's bookings.          |
| 409    | `NOT_ABANDONABLE` | The booking has already moved on (confirmed, cancelled or expired).                                                                                         |
| 409    | `ALREADY_PAID`    | A payment on the booking has been captured, including one that committed while the door was running, so the buyer must use Cancel, which quotes the refund. |

### Withdraw a reschedule proposal

**Method**: `POST /api/appointments/[appointmentId]/reschedule/withdraw`

The initiator of an open proposal may take it back, and the withdrawal restores the released slots and the request's origin status through `lib/booking/reschedule-restore.ts`. If the original time was booked while the proposal was open, the restore meets the overlap constraint (SQLSTATE 23P01), the transaction rolls back, and the route answers 409 with the code `ORIGINAL_TIME_TAKEN`. The proposal then stays open, and agreeing a new time is the way forward. A proposal the other party answered first answers 409 `PROPOSAL_NOT_OPEN`, and a caller with no open proposal of their own on the booking gets 404.

### Delete an offering

**Methods**: `DELETE /api/plans/consultations/[consultationPlanId]`, `DELETE /api/plans/subscriptions/[subscriptionPlanId]`, `DELETE /api/bookings/webinars/[webinarId]` and `DELETE /api/bookings/classes/[classId]`

Each route deletes an offering only while nothing has ever touched it (#1527 decision 6). The route checks ownership before it takes any lock, so a stranger cannot hold buyers' checkout busy; a plan route answers 403 for someone else's plan, and a webinar or class route answers 404 for someone else's instance. It then runs one Serializable transaction under the offering's `event-checkout:` lock through `deleteUntouchedOffering` in `lib/booking/offering-delete.ts`, with the no-history guard from `lib/offerings/delete-guard.ts` inside the `deleteMany` WHERE. That lock is the key checkout takes for a subscription plan, webinar or class; consultation checkout locks its slot atoms instead, so for a consultation plan the Serializable transaction and the in-WHERE guard carry the race on their own. The guard counts a payment of any status and any consultee seat ever held, and a subscription plan also counts its trials. A delete that matches zero rows answers 409 with the code `OFFERING_IN_USE`, and the offering should be archived instead.

The Offerings card and the server share this one rule. The guard fragments live in `lib/offerings/delete-guard.ts`, the DELETE routes put them inside their `deleteMany` WHERE, and the card's `canDelete` (`lib/data/offering-stats.ts`) runs the same fragments as a query. Any history therefore means Archive instead of Delete, whether it is a booking, a payment of any status (a `PENDING` or `FAILED` payment cascades with its appointment as surely as a captured one), a consultee seat ever held (a released seat still records that someone held it), or, for a subscription plan, a trial. A webinar or class plan is deletable from the card only while none of its instances has history, and an unsold upcoming instance is deletable. A consultation plan has no checkout lock key, because checkout locks its slot atoms instead, so for that kind the Serializable transaction and the in-WHERE guard carry the race on their own.

The two `DELETE /api/bookings/{webinars,classes}/crud-with-plan/[id]` routes were removed in #1846, because they had no callers and no guard. The `crud-with-plan` collection routes keep their `POST` and `PATCH` handlers.

### Preview a trial cancellation

**Method**: `GET /api/trials/[trialId]/cancel/preview`

This route returns what cancelling the trial right now would pay back, and it never writes. It uses the same ownership scope as trial DELETE, so it answers 404 wherever the cancel would. The response is `{ "paid": false }` when there is nothing to refund, and otherwise it is `{ "paid": true, ... }` with the quote in the appointment cancel preview's shape (`paymentId`, `refundPct`, `estimatedRefundPaise`, `refundablePaise`, `currency`, `fundingRail`, `hoursUntilNextSession` and `prorated`) plus `grossPaise`, the amount paid, for the dialog's breakdown line. The response is sent with `Cache-Control: no-store`.

### Cancel a trial

**Method**: `DELETE /api/trials/[trialId]`

The optional JSON body carries `confirmedRefundPaise`, which is the `estimatedRefundPaise` the caller saw in the preview. The route re-quotes the refund under the appointment lock, cancels the trial and tombstones its session in one transaction, and then refunds exactly the confirmed quote. A free or unpaid trial needs no body. The refusals specific to a paid trial are listed in the following table, and both carry the current `quote` so the dialog can show it and ask again.

| Status | Code                    | Meaning                                                                  |
| ------ | ----------------------- | ------------------------------------------------------------------------ |
| 409    | `REFUND_QUOTE_REQUIRED` | The trial is paid and the body carried no valid `confirmedRefundPaise`.  |
| 409    | `REFUND_QUOTE_CHANGED`  | The confirmed amount no longer matches the refund quoted under the lock. |

The compare-and-swap narrows to the status the caller read, so a trial accepted or paid since that read answers 409 `ILLEGAL_TRANSITION` instead of being cancelled on a stale view.

`PATCH /api/trials/[trialId]` with `status: "CANCELLED"` no longer cancels a paid trial. It answers 409 `REFUND_QUOTE_REQUIRED` with the quote and points the caller at the cancel dialog, and its compare-and-swap carries `paymentId: null`, so a capture that commits first also turns the cancel into a 409.

---

## Calendar Endpoint

`GET /api/calendar/[appointmentId]?u=<userId>&t=<token>` serves one attendee's `.ics` for a booking, and it is the only booking endpoint that takes no session. The link comes from `calendarLinks` (`lib/appointments/calendar-links.ts`), which the booked email and the checkout success page render beside a Google Calendar template URL. The token is an HMAC over the appointment id and the user id with the purpose label `calendar-ics`, signed with the shared link secret (`signToken` in `lib/newsletter/tokens.ts`).

| Case                                                                                               | Answer                                                |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| The token verifies and the user holds a paid seat with a session ahead                             | 200 `text/calendar`, every upcoming confirmed session |
| A bad token, a missing or deleted booking, a seat that is no longer paid, or a fully refunded seat | 404 `Not found`, the same body for every case         |
| More than 30 requests a minute from one IP (`calendarLimiter`)                                     | 429 with `Retry-After`                                |

Every answer carries `Cache-Control: private, no-store`. A paid seat is a `CONSULTEE` participant row that `paidParticipant(userId)` admits (`calendarSeatWhere`, which the checkout success page also checks before it offers the links), the same predicate the group-event room uses. A full refund leaves the payment `SUCCEEDED`, so the route also loads the seat's own payment and refuses it when `isFullyRefundedPurchase` (`lib/payments/utils/refund-balance.ts`) counts pending and completed refunds covering it; a partial refund and a free seat keep the file. Both checks live in `holdsCalendarSeat` (`lib/appointments/calendar-links.ts`), which the checkout success page calls too, so a refunded or cancelled seat stops serving the file at once and the two can never disagree. The file carries the title, each session's start and end in UTC, and the dashboard link (`/dashboard/go/auto/appointments/<id>`), never the video link and never another person's details. The route reads the client IP that middleware stamps, which the `/api/(.*)` matcher covers.

---

## Offering Editor Reads

`GET /api/plans/webinars/{id}/editor` and `GET /api/plans/classes/{id}/editor` return the same plan detail as the public plan GET, for the offering editor only. The caller must be signed in and be the plan's owner or an ACCEPTED co-host; anyone else, like a missing plan, gets 404. Every answer carries `Cache-Control: private, no-store`, while the public GET keeps its shared cache (`s-maxage=60, stale-while-revalidate=300`), so the editor never starts a save from a copy up to six minutes old.

---

## Notify-me Endpoint

`POST /api/scheduling/event-waitlist` joins and `DELETE /api/scheduling/event-waitlist` leaves the notify-me list of a sold-out webinar or class (`app/api/scheduling/event-waitlist/route.ts`). Both take the body `{ "kind": "WEBINAR" | "CLASS", "eventId": "<id>" }`. `GET /api/scheduling/event-waitlist` lists the caller's own open rows for the learner's alerts list; the plan pages still read the viewer's state on the server. The middleware already requires a session for everything under `/api/scheduling/`, `POST` and `DELETE` are limited per user by `eventMutationLimiter`, `GET` carries no limiter, because it is a small read: the event-waitlist list holds at most five open rows per learner (`EVENT_WAITLIST_USER_CAP`), and the backup-interest list it mirrors holds at most three (`BACKUP_INTEREST_CAP`), and every answer carries `Cache-Control: no-store`.

`GET` answers 200 with `{ data: Alert[] }`, oldest row first, validated by `EventWaitlistListResponseSchema` (`schemas/interest.ts`). Each alert carries `kind`, `eventId`, `planId`, `planTitle`, `nextSessionAt` (ISO, or null when no live session is left), `status` (`WAITING` or `NOTIFIED`), `notifiedAt` (ISO or null), `checkoutHref` (the same link the notice carries) and `seatAvailable` (whether checkout would sell a seat right now: the event is on sale and at least one seat is free, so it turns false again if another buyer takes the reopened seat; a row stays open, showing `seatAvailable: false`, while its event is not on sale but has not ended, for example an archived plan or a running class past its late-join cut-off; the stale-request sweep expires it only once the event is completed or cancelled, its appointment is deleted, or no live session is left). For example, Priya waiting on Hannah's webinar after a notice gets `{ "kind": "WEBINAR", "eventId": "web-1", "planId": "plan-1", "planTitle": "Deep work", "nextSessionAt": "2026-11-12T04:30:00.000Z", "status": "NOTIFIED", "notifiedAt": "2026-11-10T06:00:00.000Z", "checkoutHref": "/checkout/plans/webinar/plan-1?eventId=web-1", "seatAvailable": true }`.

| Case                                                                       | Answer                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Join succeeds, or the caller is already on the list                        | 200 `{ data: { status } }`                                                     |
| Leave                                                                      | 200 `{ left: true }`, or `{ left: false }` when no open row                    |
| Missing event or a plan the caller may not view                            | 404 `EVENT_NOT_FOUND`, the same answer for both                                |
| Event cancelled, past or archived                                          | 409 `EVENT_CLOSED`; a class past its enrolment cut-off, 409 `ENROLMENT_CLOSED` |
| The caller is the host or an accepted co-host                              | Refused like checkout (`assertNotSelfBooking`)                                 |
| The host turned the waitlist off                                           | 409 `WAITLIST_DISABLED`                                                        |
| Seats are still available                                                  | 409 `EVENT_NOT_FULL`                                                           |
| The caller already holds a seat, or may not buy one again                  | The existing seat refusals (`alreadyHeldSeatError`, `assertSeatRemintable`)    |
| The list holds `min(waitlistMax ?? 200, 200)` open rows                    | 409 `WAITLIST_FULL`                                                            |
| The caller is already waiting on five sessions (`EVENT_WAITLIST_USER_CAP`) | 409 `EVENT_WAITLIST_CAP`                                                       |

The checks run in that order, and nothing here reserves a seat. See [the event seat waitlist decision](../decisions/2026-11-07-event-seat-waitlist.md).

---

## Scheduling-Surface Endpoints

These routes carry the refusals of the scheduling surfaces: the plan publish gate, class creation, the class series move, and the trial and reschedule holds. Each refusal carries a `code` next to its `error` text and is a state the caller can act on, not a fault.

| Route                                                                                        | Status and code                              | When                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/plans/subscriptions/[subscriptionPlanId]`                                          | 422 `PLAN_NOT_FEASIBLE`                      | The feasibility gate runs only when the cadence (sessions a week or session length) changes, or the plan is being published for the first time, and no week of the expert's published hours can hold the cadence. A published plan saved unchanged runs neither this gate nor the pack price floor (`assertSubscriptionPlanFloor` runs only when the price or terms change). A draft saves, and the same reasons come back as `feasibilityWarnings`. |
| `GET /api/plans/subscriptions/[subscriptionPlanId]/feasibility`                              | 404                                          | The plan does not exist, or it is a draft the caller cannot see (`isHiddenDraft`).                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/bookings/classes/crud-with-plan`                                                  | 400 `EVENT_TIME_INVALID`                     | A start that is off the UTC half-hour grid, less than an hour ahead, or unable to place every session. Nothing is written.                                                                                                                                                                                                                                                                                                                           |
| `POST /api/appointments/[appointmentId]/retime-series`                                       | 409 `RETIME_NOT_ALLOWED`                     | The class is no longer published, or its movable sessions (live, confirmed, at least 24 hours away) differ from the ones the move planned against, or the count of new starts does not match.                                                                                                                                                                                                                                                        |
| the same route                                                                               | 400 `EVENT_TIME_INVALID`                     | A new start is off the grid or less than 24 hours ahead, two new times overlap, or a zone day would hold more than two sessions of the class.                                                                                                                                                                                                                                                                                                        |
| the same route                                                                               | 409 `SCHEDULE_CONFLICT`; the lock's own code | The host's or a co-host's calendar is taken at a new time; or another writer holds the event checkout, the appointment or the host slot batch (`EVENT_CHECKOUT_BUSY` 409, `APPOINTMENT_BUSY` 423, or a 503 lock-unavailable code).                                                                                                                                                                                                                   |
| `POST /api/appointments/[appointmentId]/reschedule`                                          | 409 `PAY_LINK_LIVE`                          | The booking holds a `PENDING` payment that has not passed its `expiresAt`.                                                                                                                                                                                                                                                                                                                                                                           |
| the same route                                                                               | 403 `TRIAL_PARTY_ONLY`                       | The caller is neither the trial's expert nor its learner.                                                                                                                                                                                                                                                                                                                                                                                            |
| `PATCH /api/bookings/webinars/{id}/allocate` and `PATCH /api/bookings/classes/{id}/allocate` | 409 `EVENT_CHECKOUT_BUSY`                    | A seat checkout holds the webinar or class while the allocator takes the event checkout lock; retry in a moment. The allocate body names the code `errorCode`.                                                                                                                                                                                                                                                                                       |
| `POST /api/scheduling/request-for-approval`                                                  | 400 `OUTSIDE_AVAILABILITY`                   | A requested time is outside the expert's published hours. The check runs inside the request transaction and uses the trial door's code and copy. It runs only here: a held request keeps its time if the hours shrink later.                                                                                                                                                                                                                         |
| `PATCH /api/bookings/consultations/[consultationId]` and the subscription twin               | 503 with the lock's own code                 | The approval lock service is unavailable (`BookingLockUnavailableError`). Contention with another approval still answers 409.                                                                                                                                                                                                                                                                                                                        |
| `POST /api/trials`                                                                           | 429 `RATE_LIMITED`                           | The caller already created three trials in 24 hours. The body carries `retryAfterSeconds` and `retryAt` (ISO 8601), and the response carries `Retry-After`.                                                                                                                                                                                                                                                                                          |

The series move is idempotent: it runs inside `withIdempotency` (`lib/api/idempotency.ts`), so a repeated `Idempotency-Key` replays the first answer instead of moving the sessions twice. The `retimeBy` it returns is the leave-by date stored on the event, for classes and webinars alike (`extendRetimeLeave` in `lib/booking/retime-leave.ts`).

---

## Error Codes

| Status | Cause                   | Example                                                                   |
| ------ | ----------------------- | ------------------------------------------------------------------------- |
| 400    | Zod validation failure  | `"slots: Each slot must be a valid ISO 8601 datetime string"`             |
| 400    | Business rule violation | `"Consultation requires exactly 2 slots (1 hour) but 3 provided"`         |
| 400    | Duplicate slots         | `"Duplicate slots detected: 3 slots provided but only 2 are unique"`      |
| 404    | Event not found         | `"consultation not found"`                                                |
| 409    | Slot conflict           | `"Slot already booked: 1/15/2025 (conflicts with consultation for John)"` |
| 500    | Transaction failure     | `"Allocation failed"`                                                     |

### Zod Error Format

Zod errors are formatted as semicolon-separated field:message pairs:

```
"slots: Each slot must be a valid ISO 8601 datetime; isAuto: Required field"
```

---

## Zod Schema Reference

**File**: `schemas/slotAllocation/validationSchemas.ts`

### allocationRequestSchema

| Field               | Type     | Required    | Description                                                                         |
| ------------------- | -------- | ----------- | ----------------------------------------------------------------------------------- |
| `isAuto`            | boolean  | Yes         | `true` for auto allocation, `false` for manual/requested                            |
| `useRequestedSlots` | boolean  | No          | `true` to approve pre-created consultee appointments                                |
| `slots`             | string[] | Conditional | ISO 8601 datetimes. Required if `isAuto: false` and `useRequestedSlots` is not true |

### validationRequestSchema

| Field   | Type     | Required    | Description                           |
| ------- | -------- | ----------- | ------------------------------------- |
| `slots` | string[] | Yes (min 1) | ISO 8601 datetime strings to validate |

### eventIdSchema

Validates URL path parameter `{id}`. Accepts UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) or CUID (`cxxxxxxxxxxxxxxxxxxxxxxxxx`).

---

## Type Definitions

**File**: `utils/scheduling-engine/types.ts`

| Type                       | Description                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `EventType`                | `"consultation" \| "subscription" \| "webinar" \| "class"`                                            |
| `AllocationMode`           | `"auto" \| "manual" \| "requested"`                                                                   |
| `AllocationRequest`        | `{eventType, eventId, mode, slots?}`                                                                  |
| `AllocationConstraints`    | `{schedulingPeriod, slotsRequired, sessionDuration, sessionsPerWeek, ...}`                            |
| `ValidationResult`         | `{isValid, errors: string[], warnings: string[]}`                                                     |
| `SlotConflictResult`       | `{conflicts[], outsideAvailability[], validSlots[]}`                                                  |
| `AllocationResult`         | `{success, appointments?, error?, warnings?}`                                                         |
| `TimeSlot`                 | `{startTime, endTime, isAvailable, isBooked}`                                                         |
| `ProgressInfo`             | `{scheduled, required, remaining, sessionDuration, displayText}`                                      |
| `ConsultantAllocationData` | `{userId, scheduleType, slotsOfAvailabilityWeekly[], slotsOfAvailabilityCustom[]}`                    |
| `EventConfig`              | `{durationInMonths?, durationInHours?, sessionDurationInHours?, sessionsPerWeek?, schedulingPeriod?}` |
