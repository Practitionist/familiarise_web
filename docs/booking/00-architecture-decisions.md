# Booking Architecture Decisions

This document is the architecture-decision register for the booking subsystem. It records the load-bearing choices that shape slot allocation, validation, and the background jobs that keep bookings consistent, so that a reader can understand *why* the system is built the way it is without reverse-engineering it from the code. Each entry summarises a decision, the alternative it rejected, and where the decision lives; the linked chapter carries the full detail.

The decisions below are stable. When one of them changes, update both the entry here and the chapter it points at, and note the change with its issue or PR reference.

## Register

The following table is the index. Read it top-to-bottom for a quick orientation, then follow the link in any row whose rationale you need in full.

| ADR | Decision                                                              | Status | Detail                                                                       |
| --- | --------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| B1  | All scheduling is built on 30-minute atomic slots                     | Live   | [03-slot-math-and-calculations.md](./03-slot-math-and-calculations.md)       |
| B2  | Weeks run Sunday to Saturday via a single `countWeeks` source         | Live   | [03-slot-math-and-calculations.md](./03-slot-math-and-calculations.md)       |
| B3  | Validation is a three-layer pipeline (Zod, service, database)         | Live   | [01-architecture.md](./01-architecture.md)                                   |
| B4  | Weekly availability is stored as UTC integers; same-day is local      | Live   | [02-event-types-and-validation.md](./02-event-types-and-validation.md)       |
| B5  | Tentative slots are released by a 24-hour, idempotent cleanup job      | Live   | [13-cron-jobs-and-background-tasks.md](./13-cron-jobs-and-background-tasks.md) |
| B6  | An expired pending-payment hold frees its slot for both code paths    | Live   | [01-architecture.md](./01-architecture.md)                                   |
| B7  | Concurrency is guarded by Redis distributed locks plus DB constraints | Live   | [12-concurrency-and-locking.md](./12-concurrency-and-locking.md)             |
| B8  | Background jobs run on GitHub Actions cron                            | Live   | [13-cron-jobs-and-background-tasks.md](./13-cron-jobs-and-background-tasks.md) |

## ADR B1 — Thirty-minute atomic slots

Every event in the system is expressed as one or more contiguous 30-minute slots, giving 48 slots in a day. A consultation, subscription session, webinar, or class session is simply a run of these atoms (`Math.ceil(durationInHours / 0.5)` of them), and the same slot model serves all five event types.

The rejected alternative was variable-length slots sized to each event. Uniform atoms were chosen because they make availability, conflict detection, and weekly-limit math a single calculation rather than a per-event special case, and because they let the calendar render every event on one grid. The cost is that a half-hour is the finest bookable granularity, which is acceptable for this product. The duration is a module constant (`SLOT_DURATION_MS = 30 * 60 * 1000`) rather than a parameter, so a caller cannot silently pass a different window that would disagree with the rest of the booking math.

## ADR B2 — Sunday-to-Saturday weeks from one source

Weekly limits (`callsPerWeek` for subscriptions, `meetingsPerWeek` for classes) are evaluated against weeks that begin on Sunday and end on Saturday, and the number of weeks in a scheduling period is always computed by `SlotCalculationService.countWeeks()`.

The rejected shortcut was approximating weeks as `durationInMonths * 4`. That approximation undercounts: a six-month subscription spans roughly 26 weeks, not 24, and the missing weeks would let the weekly-limit check pass schedules the period cannot actually hold. Routing every week calculation through `countWeeks` keeps the validator, the allocator, and the UI agreeing on the same week boundaries.

## ADR B3 — Three-layer validation pipeline

A booking request passes through three independent layers before it is persisted: Zod schemas check the input format, `SlotValidationService` enforces the business rules (slots in the future, no conflicts, schedule match, event-specific limits), and Prisma plus database constraints provide the final guarantee.

The decision is to keep these layers separate rather than collapsing validation into a single place. Each layer answers a different question and fails for a different reason, which keeps error messages precise and ensures that a bug in one layer cannot bypass the guarantee of another. The service layer is the single source of truth for business rules so that every API route validates identically.

## ADR B4 — UTC-stored availability, local-day grouping

Weekly availability is stored as `startDay`/`endDay` (a `DayOfWeek` enum) plus `startTimeUtc`/`endTimeUtc` integers measured in minutes since midnight UTC (0–1439), which supports overnight and cross-midnight slots without timezone ambiguity in the database.

User-facing "same day" rules are deliberately *not* UTC. The consultation same-day check and the subscription "one call per day" rule group slots by the browser's local calendar day via `Date.toDateString()` (see `useSlotAllocation.ts`), so a session that straddles midnight UTC still reads as one day for the person booking it. Storing the source of truth in UTC while grouping the user-facing rule by local day is the compromise that keeps the data unambiguous and the experience intuitive; see [02-event-types-and-validation.md](./02-event-types-and-validation.md) for the exact rules.

## ADR B5 — Idempotent 24-hour tentative cleanup

Slots created for pending payment or for rescheduling carry an `isTentative` flag. A cleanup cron releases tentative slots that are older than 24 hours with no successful payment (`TENTATIVE_EXPIRATION_HOURS = 24`, reduced from seven days by #833), and users can release their own pending slot early via `DELETE /api/checkout/pending/[paymentId]` (#849).

The job is keyed on the slot's age and the payment state rather than on the wall-clock hour, which makes it idempotent: a run that is skipped, delayed, or fired twice neither double-processes nor misses work, and the next successful run catches up everything that aged out in the meantime. This is the same idempotent-by-deadline posture the waitlist expiry sweep uses (see [11-waitlist-system.md](./11-waitlist-system.md)).

## ADR B6 — Expired pending-payment holds free their slot, consistently

When a request is `APPROVED_PENDING_PAYMENT` but its payment window has lapsed, the orphaned hold no longer occupies its slot — the slot is available again. The rule that decides this lives in one place (`isOccupiedByLiveAppointment`) and is applied by both the validator's conflict scan and the allocator's available-slot search.

The decision to share one helper rather than re-implement the expiry check on each side is what stops `/validate` and the allocator from disagreeing: before the rule was shared, the validator would accept a slot that the allocator still treated as booked, so auto-allocation could fail on a slot the user had just been told was free. Any state other than an expired pending-payment hold continues to block.

## ADR B7 — Redis locks plus database constraints

Operations that could race — concurrent allocations for the same consultant, a checkout completing while a reschedule runs — are serialised by a consultant-level Redis distributed lock acquired before the transaction, and the database carries the constraints that make a double-book impossible even if a lock is ever missed.

The decision is defence in depth rather than relying on either mechanism alone. The lock removes the common-case contention cheaply, and the constraints are the correctness backstop. See [12-concurrency-and-locking.md](./12-concurrency-and-locking.md) for the lock keys and the reconciliation job that detects any overlap the locks did not prevent.

## ADR B8 — GitHub Actions cron for background jobs

The booking lifecycle depends on several recurring jobs (tentative cleanup, slot-availability reconciliation, waitlist expiry and reminders). These run on GitHub Actions cron, following a three-layer pattern in which a dependency-free core script holds the logic, an API route wraps it with authentication, and a workflow file supplies the schedule and failure notifications.

The rejected alternatives were a managed queue or a dedicated scheduler service. GitHub Actions was chosen because it co-locates the schedule with the code, needs no extra infrastructure, and routes failures to Slack for the on-call engineer. The known limitation is scheduling jitter, which the jobs absorb by being idempotent (see ADR B5). The cron-architecture follow-up tracked in #866 may move the highest-frequency jobs to a queue later; the business-cadence jobs stay on GitHub Actions.
