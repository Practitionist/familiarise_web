# Booking System

The booking system handles slot allocation and validation for all five event types: consultations, subscriptions, webinars, classes, and trials. It supports three allocation modes (auto, manual, requested) with a three-layer validation pipeline.

```mermaid
graph TD
    subgraph Frontend
        A[useSlotAllocation Hook] --> B[allocationService API Client]
        C[useCalendarData Hook] --> D[UnifiedCalendar]
    end

    subgraph "API Layer"
        B --> E["POST /api/bookings/{type}/{id}/validate"]
        B --> F["PATCH /api/bookings/{type}/{id}/allocate"]
    end

    subgraph "Validation Pipeline"
        E --> G[Zod Schema Validation]
        F --> G
        G --> H[SlotValidationService]
        H --> I[SlotAllocationService]
    end

    subgraph "Database"
        I --> J[(Prisma / PostgreSQL)]
        H --> J
    end
```

## Core Concepts

- **30-minute atomic slots** -- all scheduling is built on 30-min intervals (48 per day)
- **5 event types** -- consultation (one-time, 1:1), subscription (recurring, 1:1), webinar (one-time, 1:many), class (recurring, 1:many), trial (one-time, 1:1, free)
- **3 allocation modes** -- auto (system finds slots), manual (user selects), requested (consultee pre-selects, consultant approves)
- **3 validation layers** -- Zod schemas (input format) -> SlotValidationService (business rules) -> Prisma (DB constraints)
- **Sunday-to-Saturday weeks** -- `SlotCalculationService.countWeeks()` is the single source of truth
- **`isTentative` flag** -- marks slots pending payment or reschedule; cleaned up by cron after 24 hours (`TENTATIVE_EXPIRATION_HOURS = 24`, reduced from 7 days by #833); users can self-release via `DELETE /api/checkout/pending/[paymentId]` (#849)
- **`startDay`/`endDay` DayOfWeek enum + `startTimeUtc`/`endTimeUtc` Int** -- source of truth for weekly availability (minutes since midnight UTC, 0-1439; supports overnight/cross-midnight slots)

## Source Code Map

### Backend Services (`utils/slotAllocation/`)

| File                        | Purpose                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `SlotCalculationService.ts` | Pure math: countWeeks, calculateRequiredSlots, getSlotsPerCall, groupSlotsByDay/Week, progress |
| `SlotValidationService.ts`  | Unified validation: future check, conflict detection, schedule matching, event-specific rules  |
| `SlotAllocationService.ts`  | Allocation engine: auto/manual/requested modes, rescheduling, appointment creation             |
| `types.ts`                  | Shared types: EventType, AllocationMode, AllocationRequest, ValidationResult, etc.             |

### Zod Schemas (`schemas/slotAllocation/`)

| File                   | Purpose                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `validationSchemas.ts` | allocationRequestSchema, validationRequestSchema, eventIdSchema, formatZodError helper |

### Frontend Hooks (`app/dashboard/consultant/[consultantId]/(features)/shared/hooks/`)

| File                           | Purpose                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `useSlotAllocation.ts`         | Central hook: toggleSlot, event-specific blocking, auto-expansion, weekly distribution |
| `useCalendarData.ts`           | Calendar data sync: server-calculated bookingStatus, getSlotStatusForInterval          |
| `useSubscriptionValidation.ts` | Subscription-specific frontend validation                                              |

### Frontend Utilities (`app/dashboard/consultant/[consultantId]/(features)/shared/utils/`)

| File                      | Purpose                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- |
| `allocationService.ts`    | API client wrapper for all allocation/validation endpoints                        |
| `allocationAlgorithms.ts` | Preference-based auto allocation with time/day scoring                            |
| `calendarUtils.ts`        | Calendar display: mapWeeklySlots, mapCustomSlots, getConsultantAvailabilityForDay |

### API Routes (`app/api/bookings/`)

| Pattern                                   | Method | Purpose                     |
| ----------------------------------------- | ------ | --------------------------- |
| `/api/bookings/consultations/{id}/allocate` | PATCH  | Allocate consultation slots |
| `/api/bookings/consultations/{id}/validate` | POST   | Validate consultation slots |
| `/api/bookings/subscriptions/{id}/allocate` | PATCH  | Allocate subscription slots |
| `/api/bookings/subscriptions/{id}/validate` | POST   | Validate subscription slots |
| `/api/bookings/webinars/{id}/allocate`      | PATCH  | Allocate webinar slots      |
| `/api/bookings/webinars/{id}/validate`      | POST   | Validate webinar slots      |
| `/api/bookings/classes/{id}/allocate`       | PATCH  | Allocate class slots        |
| `/api/bookings/classes/{id}/validate`       | POST   | Validate class slots        |

## Quick Navigation

| I want to...                           | Go to                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| **Get the big-picture lifecycle**      | [06-booking-lifecycle.md](./06-booking-lifecycle.md)                           |
| See why the system is built this way   | [00-architecture-decisions.md](./00-architecture-decisions.md)                 |
| Understand the system architecture     | [01-architecture.md](./01-architecture.md)                                     |
| Learn event type rules and validation  | [02-event-types-and-validation.md](./02-event-types-and-validation.md)         |
| Understand slot math and calculations  | [03-slot-math-and-calculations.md](./03-slot-math-and-calculations.md)         |
| Look up API endpoints                  | [04-api-reference.md](./04-api-reference.md)                                   |
| Debug an error or see recent fixes     | [05-troubleshooting-and-changelog.md](./05-troubleshooting-and-changelog.md)   |
| Understand rescheduling                | [07-rescheduling-flow.md](./07-rescheduling-flow.md)                           |
| Understand cancellation                | [08-cancellation-flow.md](./08-cancellation-flow.md)                           |
| Learn about trial sessions             | [09-trial-sessions.md](./09-trial-sessions.md)                                 |
| See how checkout connects to booking   | [10-checkout-payment-integration.md](./10-checkout-payment-integration.md)     |
| Learn about concurrency and locking    | [12-concurrency-and-locking.md](./12-concurrency-and-locking.md)               |
| See all cron jobs and background tasks | [13-cron-jobs-and-background-tasks.md](./13-cron-jobs-and-background-tasks.md) |
| Set up local dev and run tests         | [14-local-development-and-testing.md](./14-local-development-and-testing.md)   |
| Run the release checklist              | [15-checklist.md](./15-checklist.md)                                           |
| Follow a recurring event end to end    | [16-recurring-events-journey.md](./16-recurring-events-journey.md)             |
| Understand org-sponsored bookings      | [17-org-funded-checkout.md](./17-org-funded-checkout.md)                       |
| **Check legal status transitions**     | [18-state-machines.md](./18-state-machines.md)                                 |
| **Understand the DST stub**            | [19-dst-and-timezone-posture.md](./19-dst-and-timezone-posture.md)             |
| Understand the payment system          | [../payments/01-architecture.md](../payments/01-architecture.md)               |
| Check the database schema              | [../../prisma/schema.prisma](../../prisma/schema.prisma)                       |

## Recommended Reading Order

For new developers, read in this order:

1. **[06-booking-lifecycle.md](./06-booking-lifecycle.md)** -- End-to-end overview of how bookings flow from browse to completion
2. **[02-event-types-and-validation.md](./02-event-types-and-validation.md)** -- The 5 event types and their rules
3. **[01-architecture.md](./01-architecture.md)** -- Service layer, data model, data flows
4. **[03-slot-math-and-calculations.md](./03-slot-math-and-calculations.md)** -- How 30-minute slot math works
5. **[04-api-reference.md](./04-api-reference.md)** -- API endpoints and schemas
6. **[10-checkout-payment-integration.md](./10-checkout-payment-integration.md)** -- How bookings connect to payments
7. **[12-concurrency-and-locking.md](./12-concurrency-and-locking.md)** -- Race condition prevention
8. **[13-cron-jobs-and-background-tasks.md](./13-cron-jobs-and-background-tasks.md)** -- Background lifecycle management
9. **[14-local-development-and-testing.md](./14-local-development-and-testing.md)** -- Set up your dev environment and run tests

Then reference these as needed:

- [07-rescheduling-flow.md](./07-rescheduling-flow.md), [08-cancellation-flow.md](./08-cancellation-flow.md) -- Modify existing bookings
- [09-trial-sessions.md](./09-trial-sessions.md) -- Trial session specifics
- [05-troubleshooting-and-changelog.md](./05-troubleshooting-and-changelog.md) -- Debug errors

## Related Documentation

- **Payments**: [../payments/README.md](../payments/README.md) -- Payment architecture, checkout flows, refunds, payouts
- **Notifications**: [../notifications/README.md](../notifications/README.md) -- Novu workflows triggered by booking events
- **Distributed Locking**: [../upstash/redis/locking/00_README.md](../upstash/redis/locking/00_README.md) -- Redis locking deep dive
- **Cron Setup**: [../guides/cron-setup.md](../guides/cron-setup.md) -- Deployment-specific cron configuration
