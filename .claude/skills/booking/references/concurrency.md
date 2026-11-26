---
name: booking-concurrency
description: How this repo serializes concurrent booking writes — the Redis lock atoms and their exact key shapes, the global lock order, fail-closed acquisition, retry budgets against the function ceiling, TTL versus transaction timeout, CAS-in-WHERE as the optimistic lock, the SQL sidecar constraints, and Serializable retries. Load when touching utils/appointmentlock.ts, lib/db/serializable-retry.ts, lib/db/pg-errors.ts, prisma/sql/, or any booking write that races another writer — checkout, allocation, approval, reschedule, cancel, or a capture webhook.
---

# Booking Concurrency

Correctness under concurrency here is a hybrid: **Redis serializes, Postgres
decides.** The lock removes contention cheaply and gives the loser a fast,
structured answer; Postgres then refuses the illegal write when a lock is
missed, expired or never taken. Which Postgres mechanism does the refusing
depends on the invariant: the `occurrence_no_confirmed_overlap` exclusion constraint
(§7) blocks a consultant double-book, the CAS WHERE clause (§6) blocks an
illegal status change, and the `Serializable` transaction with its retries (§8)
is what holds webinar and class seat capacity, counting `AppointmentParticipant`
rows tentative-inclusive. That last one is not interchangeable with the other
two — an attendee slot carries a null `consultantProfileId` and so falls
outside the constraint's predicate, and CAS knows nothing about a seat count.
Neither half is optional. The payment webhook adds a fourth, narrower check on
top of the exclusion constraint: the confirm-time recheck inside its own
Serializable transaction re-scans for a conflict before stamping a captured
payment's occurrence CONFIRMED, so two concurrent capture webhooks for
overlapping intervals resolve to one confirmation and one
`doubleBookingBlocked` result rather than both landing (`lib/payments/webhooks/handlers.ts`).
The recheck counts only rows that still hold their time
(`OCCUPYING_OCCURRENCE_WHERE`), so a cancelled, returned or tombstoned row never
blocks a capture on the time it freed.

## 1. One key shape per atom, minted in one file

Every distributed lock key in this subsystem is minted in
`utils/appointmentlock.ts` and nowhere else, because two names for one atom is
no lock at all.

| Atom                                     | Key shape                                            | Minted by                                 |
| ---------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| 30 minutes of one consultant's calendar  | `slot-booking:<consultantProfileId>:<atomStartISO>`  | `tryLockSlotBatch` / `lockSlotBatch`      |
| One consultee's booking activity         | `consultee-booking:<consulteeUserId>`                | `lockConsulteeBooking`                    |
| One sellable event or plan               | `event-checkout:<appointmentType>:<eventOrPlanId>`   | `lockEventCheckout`                       |
| One consultant's allocation pool         | `auto-allocate:<consultantProfileId>`                | `lockAutoAllocate`                        |
| One consultant's requests and plan sales | `request-cap:<consultantProfileId>`                  | `lockRequestCap`, `lockExpertPlanSales`   |
| One consultation approval                | `consultation-approval:<consultationId>`             | `lockConsultationApproval`                |
| One subscription approval                | `subscription-approval:<subscriptionId>`             | `lockSubscriptionApproval`                |
| One pay-link mint                        | `approval-payment-mint:<kind>:<id>`, kind lowercased | `lockApprovalPaymentMint`                 |
| One appointment's lifecycle              | `appointment-lock:<appointmentId>`                   | `lockAppointment` / `withAppointmentLock` |

Every path acquires in one global order, coarse to fine, so the families form
a total order that cannot cycle. The locks are Redis try-locks with bounded
retries, so a path that breaks the order times out; it never hangs.

1. The cron lease (sweeps only).
2. `event-checkout:` — seat checkout's commit, offering delete, whole-event
   cancel, webinar re-time and class make-up.
3. `appointment-lock:` — every lifecycle door, seat leave, and the allocator on
   an appointment that already exists.
4. `consultation-approval:` / `subscription-approval:`, then
   `approval-payment-mint:` as a leaf under the approval key.
5. One consultant tier, never two at once: `auto-allocate:` (allocation) or
   `request-cap:` (request-for-approval, trial requests, and every plan
   checkout, which holds it across the sold-plan counts and the new hold's
   commit).
6. `consultee-booking:`, exactly one.
7. **One atomic slot batch**: every `slot-booking:` atom of every profile the
   write makes busy — the host, each ACCEPTED co-host, and the buyer's own
   profile when the buyer is an expert too.
8. Leaves that never nest a booking key: `recording-purchase:`, payout and
   support families.

The whole-event cancel takes `event-checkout:` before `appointment-lock:`, and
the re-time door documents the same order at its head (`lib/booking/event-retime.ts`).
A webinar or class allocation (`lib/booking/allocation/allocate.ts`) takes the
same `event-checkout:` key first, so a re-plan waits for seat checkouts; a held
key answers 409 `EVENT_CHECKOUT_BUSY`. The class series move (`retimeClassSeries`)
takes event checkout, then the appointment, then the host and co-host slot batch.
Every allocation mode takes the consultee key only after its search or its
reads and validation, just before the slot batch (auto in `modes/auto.ts`,
manual in `modes/manual.ts`, requested in `modes/use-requested.ts`), so a
buyer's own checkout never reads "another booking in progress on your account"
because an expert is picking times for them. The in-transaction
`revalidateConflicts` reads the consultee's calendar under the key, so holding
it from the batch to the commit is enough to stop a cross-consultant double
booking.

Every writer that moves one booking's lifecycle takes the `appointment-lock:`
atom before it opens its transaction. That includes the reschedule withdraw
(#1583) and, as of #1846, the abandon door, the reschedule expiry sweep (which
expires and restores in one transaction under it), trial DELETE (which moves
the status and tombstones the session in one transaction on its own client),
and moderation's bulk cancel, which takes the lock per engagement. Auto-complete takes it around each booking's completing transaction, waiting at most about 0.9 s (`SWEEP_LOCK_RETRY_CONFIG`) and leaving a busy booking for the next run, so a park through the ops outcome door is seen by its CAS (`docs/decisions/2026-11-24-parked-sessions-hold-the-booking-status.md`). A request or trial with no appointment yet has no atom, so its CAS
alone decides. Offering DELETE takes the `event-checkout:` key checkout takes
for the same webinar, class or subscription plan, with an explicit 75-second
TTL and one retry so the lock outlives every attempt; a consultation plan has
no checkout key, so the Serializable transaction and the in-WHERE guard carry
that race alone.

## 2. Slot locks are one atomic batch per write

`slotAtomStarts` floors the start to the half-hour grid (`SLOT_ATOM_MS` is
`30 * 60 * 1000`) and returns one atom per 30 minutes of `[startsAt, endsAt)`,
so an unaligned booking still collides with every aligned booking it overlaps.
`slotBatchKeys` turns every interval of every profile a write makes busy into
one de-duplicated key list, sorted by code unit so the order never depends on
the runtime's locale.

`tryLockSlotBatch` (`utils/appointmentlock.ts`) sets every key in one Lua call
with NX semantics, or sets none and returns the keys that were held. It never
waits. All keys share one value, so `extendSlotInterval` re-arms the whole batch
and `unlockSlotInterval` releases it in one compare-value call each; a failed
re-arm means ownership was lost, so the caller aborts before writing. Every
Redis call a lock makes (health probe, `SET`, release, renewal, batch script)
is cut at `REDIS_CALL_TIMEOUT_MS`, 1.5 seconds: a slow Redis is an unavailable
Redis, an acquire fails closed with `BookingLockUnavailableError` (503), and a
renewal that got no answer reads as a lost grant. An acquire that timed out
gives back whatever it may still have set under its value.

Who waits and who does not:

- **Buyer doors wait.** Checkout, request-for-approval and trials call
  `lockSlotBatch`, which retries the atomic batch inside the request-path budget
  and then throws `SlotLockError` naming the first held time.
- **The allocator never waits** (`lib/booking/allocation/slot-batch.ts`). Manual
  and requested modes call `lockPickedSlots`: a held atom is 409 `TIMES_TAKEN`
  carrying the taken times (never who holds them), and the other picks are kept.
  Auto mode adds each held time to its exclusions and re-searches, at most
  `MAX_ALLOCATION_RESEARCHES` (2) times inside one shared search budget, then
  answers 409 `ALLOCATION_RACE` (retryable after 5 seconds). The batch is taken
  after the search and before the write, and renewed with the consultee key
  ahead of every write attempt in `bookingTransaction`'s `beforeAttempt`, never
  inside the transaction.
- **Host-time writers never wait.** Webinar and class create, publish and
  re-time, class make-up, co-host accept and meeting extension run inside
  `withHostSlotBatch` (`lib/booking/host-slot-batch.ts`) over the host and every
  ACCEPTED co-host; a held atom is `HostTimeHeldError`, a schedule conflict. A
  meeting extension holds its extra minutes before it is saved and refuses when
  it cannot.

**Postgres arbitrates the same atoms.** Redis is the fast refusal; the database
decides. Every writer above calls `lockHostTimeInTx`
(`lib/booking/allocation/host-time-locks.ts`), or its door's wrapper
(`lockAllocationTimesInTx`, `lockHostBatchInTx`, `lockTrialPickInTx`), as the
**first statement of its write transaction**, before the event's advisory lock
and every row lock, then runs its conflict re-check. It takes one
`pg_try_advisory_xact_lock` per slot key (`hashtextextended(key, 42)`), walks
the sorted keys and stops at the first held one, never waits, and throws the
door's existing slot-taken 409. The locks end with the transaction. A new
writer that makes an expert's time busy must take the Redis batch and this call
with the same entries; `__tests__/booking/host-time-writers.test.ts` lists every
writer and fails on one that takes the batch without the call. Order inside a
transaction: host-time try-locks, then waiting advisory locks (the per-event
allocation lock, the per-plan tranche lock), then row locks, then
compare-and-set writes. Writer table, atom rules and limits:
`docs/booking/12-concurrency-and-locking.md`, "Postgres arbitrates host time".

## 3. Acquisition fails closed

`acquireGuarded` is the single acquisition path. It calls `checkRedisHealth()`
first and wraps the attempt in `withCircuitBreaker`; an unreachable Redis or an
open circuit throws `BookingLockUnavailableError` (503,
`BOOKING_LOCK_UNAVAILABLE`), never a benign "try again", because without a lock
two concurrent buyers can both clear the same finite capacity. Genuine
contention is a `LockContentionError`, mapped by each caller to a typed
retryable answer: `EventCheckoutBusyError` (409, `EVENT_CHECKOUT_BUSY`),
`ConsulteeBookingBusyError` (409, `CONSULTEE_BOOKING_BUSY`),
`AppointmentBusyError` (423, `APPOINTMENT_BUSY`), or `SlotLockError` on the
interval path. Sold-out is separate and terminal: `EventFullError` (409,
`EVENT_SOLD_OUT`) offers no retry, because no waiting creates a seat.

## 4. Retry budgets are sized against the function ceiling

`DEFAULT_RETRY_CONFIG` is eleven exponential attempts and waits up to about 204
seconds, roughly eight times the serverless function ceiling, so a request path
using it dies as a 504 before it can return the 409 it computed. As of wave 5
(#1319), `REQUEST_PATH_RETRY_CONFIG` (`retryCount: 5`, so six attempts and about
seven seconds) is the **default parameter of `acquireGuarded`**, so every
request-path acquisition is bounded unless a caller opts out.
`CHECKOUT_WAIT_RETRY_CONFIG` and the private `INTERVAL_RETRY_CONFIG` share that
budget; `DEFAULT` remains only for callers
that run outside a request.

A door that takes several tiers does not get that budget per tier. Checkout,
the request door, the trial door and the incident rebook mint one
`requestLockBudget()` (`REQUEST_LOCK_BUDGET_MS`, 8 seconds) and pass it to every
tier (`lockRequestCap`, `lockExpertPlanSales`, `lockConsulteeBooking`,
`lockSlotBatch`, `lockEventCheckout`, `withAppointmentLock`). Past the deadline a
tier makes no Redis call and starts no wait, and answers its own busy 409. A new
multi-tier door must do the same.

Treat the ceiling as an observed figure, not a configured one: there is no
`26000` constant and no `[functions]` timeout block in `netlify.toml`, only
comments, and `lib/prisma.ts` explicitly disowns the old arithmetic around it.

## 5. TTL must outlive the transaction, and be renewed per attempt

A lock TTL is sized above the transaction it protects, then reduced by the drift
factor (`effectiveTTL = floor(ttl * (1 - driftFactor))`). `APPROVAL_LOCK_TTL_MS`
is 45 s against a 30 s Serializable transaction; `APPOINTMENT_LOCK_TTL_MS` is
75 s against a 60 s reschedule transaction plus its maxWait; `lockAutoAllocate`
defaults to 150 s. The consultee key lives one attempt plus slack
(`CONSULTEE_LOCK_TTL_MS`, 60 s) and is re-armed ahead of each write attempt
with `renewConsulteeBooking`, so a crashed request blocks its user for at most
a minute. Per checkout type,
`CHECKOUT_LOCK_TTL_MS` is `CONSULTATION` 60 s and `SUBSCRIPTION`, `WEBINAR` and
`CLASS` 45 s each: one checkout attempt plus slack, renewed per attempt, because
seat checkout holds the event key only around its commit (§11). Lifecycle doors
under the event key (`withEventCheckoutLock`) use `EVENT_LIFECYCLE_LOCK_TTL_MS`,
75 s. The allocator's slot batch lives `ALLOCATION_TX_MAX_WAIT_MS` plus
`ALLOCATION_TX_TIMEOUT_MS` plus 15 s (`ALLOCATION_SLOT_BATCH_TTL_MS`), a
host-time batch 60 s (`HOST_SLOT_BATCH_TTL_MS`), and `request-cap:` 60 s.

Retries multiply the exposure: four Serializable attempts of up to 40 s each
outlive a fixed 45 s grant. As of wave 5 (#1319) the approval path therefore
calls `renewApprovalLock` at the top of every attempt, throwing
`ApprovalLockLostError` (409, `APPROVAL_LOCK_LOST`) if the grant is gone, and
checkout renews its slot grant the same way, aborting when `extendSlotInterval`
returns false.

## 6. The CAS WHERE clause is the optimistic lock

Redis serializes the common case; the status transition is what rejects the
illegal write. The allowed-from set is baked into the UPDATE's WHERE clause, so
a losing writer matches zero rows and throws `IllegalTransitionError` (409,
`ILLEGAL_TRANSITION`). Never swallow a zero-row result. See the booking doctrine in `../SKILL.md`
rule 1 for the helpers and the maps.

## 7. Constraints Prisma cannot express live in SQL sidecars

The final backstops are not in `schema.prisma`. They live in `prisma/sql/`
(`check-constraints.sql`, `ledger-triggers.sql`, `payment-legs-triggers.sql`),
applied after a schema push. The one that matters most here is
`occurrence_no_confirmed_overlap` on `AppointmentOccurrence`: `EXCLUDE USING gist
("consultantProfileId" WITH =, tstzrange("startsAt", "endsAt") WITH &&) WHERE
("consultantProfileId" IS NOT NULL AND NOT "isTentative" AND "deletedAt" IS NULL
AND "completionStatus" NOT IN ('CANCELLED', 'RESCHEDULED'))`.
That predicate has four consequences — tentative rows and rows with a null
`consultantProfileId` (webinar and class attendee slots) are deliberately
outside its reach, a tombstoned row (a cancel or a hold release keeps the row
as CANCELLED with `deletedAt` set) no longer blocks the time it used to hold
(#1694), a CANCELLED or RESCHEDULED row never blocks even when `deletedAt` is
null, and half-open `tstzrange` means back-to-back slots do not conflict.
It guards one host's own calendar and nothing else: **tentative holds, co-host
seats, a consultant booking as a client, and attendee seats are not covered** and
stay app-enforced (slot locks, `assertCollaboratorsFree`, the Serializable seat
count) until the busy-time ledger lands **(planned)**. The app-level occupancy
predicate is deliberately not the same as the constraint's: a RESCHEDULED row
still occupies for readers (`OCCUPYING_OCCURRENCE_WHERE`), because a pending
reschedule holds the original time until it resolves.
The predicate lives only in `prisma/sql/check-constraints.sql` (a DROP then an
ADD, applied by `scripts/db/apply-sidecars.ts`), so re-applying it on the shared
database briefly removes the constraint: change it only in an owner-approved
window, and never add a standalone swap script.
Never assume the sidecars are present on a database you did not push to with
the full chain.
The neighbouring sidecar `appointment_occurrence_live_ordinal_key` is a
partial unique index, not an exclusion constraint — it guards
`("appointmentId", "ordinal")` only over live rows
(`completionStatus NOT IN ('RESCHEDULED', 'CANCELLED', 'VOIDED') AND deletedAt IS NULL`),
because a reschedule's replacement occurrence inherits its predecessor's
`ordinal` and the superseded row must be free to keep it for history, and a
VOIDED session is a miss whose make-up reuses the ordinal.

## 8. Serializable retries, and what may not run inside one

`withSerializableRetry` (`lib/db/serializable-retry.ts`) retries **only** the two
transient rollbacks Postgres reports — a serialization failure (SQLSTATE 40001)
and a deadlock victim (40P01, detected by `isDeadlock` in `lib/db/pg-errors.ts`
because the pinned adapter rethrows it unmapped) — up to
`SERIALIZABLE_MAX_RETRIES` (3), four attempts
total, with 50/100/200 ms backoff plus jitter. A serialization failure has
two shapes and both are retried through `isWriteConflict`: raised by a statement
it arrives as Prisma `P2034`, and raised at COMMIT it escapes as the raw
`DriverAdapterError` of kind `TransactionWriteConflict`, which Prisma does not
map. Classify these by class and SQLSTATE, never by message text. Each retry and each exhaustion
emits a `db.serializable_retry` metric tagged with the reason. Anything else (an `IllegalTransitionError`, a
validation error, a 409) propagates immediately, by design: a business rejection
must never be retried into accidental success. Because the callback runs up to
four times, nothing inside it may be non-idempotent; gateway calls,
notifications, emails and pay-link mints belong after the commit, and a lock
grant taken before the loop must be renewed inside it (see §5). A Read Committed
booking transaction runs through `bookingTransaction`
(`lib/db/booking-transaction.ts`), which replays a deadlock victim once: pass
the lock renewals as its `beforeAttempt` hook (it runs ahead of every attempt,
outside the transaction), as the cancel and reschedule routes do, so a replay
never writes under a lapsed grant.

Exhausted retries surface as a 409 — checkout answers `errorType:
"SERIALIZATION_CONFLICT"` with `yourCardWasNotCharged: true` — never a 500. A
database timeout before the booking commits (an expired transaction, P2028, or
the driver's `Query read timeout`; `isTransactionExpired` and
`isQueryReadTimeout`) answers a 503 `DATABASE_BUSY` with the same body. A read
timeout at the booking transaction stays a 500 without that claim, because the
COMMIT it cut off may have landed, and so does a failed idempotency-key replay
lookup, because the key may name a checkout that was already paid. An
exclusion-constraint violation is the backstop working, so it is a 409 too:
detect it with `isExclusionViolation` from `lib/db/pg-errors.ts` (SQLSTATE
`23P01` structurally, with a narrow text fallback only because Prisma does not
model such constraints — prisma/prisma#25562, #26366), and `isUniqueViolation`
there for `P2002`/`23505`. Never sniff error messages in business logic; that
heuristic is quarantined in `pg-errors.ts` deliberately.

## 9. Who may allocate, and what an update may not touch

Allocation is a host-side act. The one handler behind the four `PATCH
/api/bookings/{consultations|subscriptions|webinars|classes}/[id]/allocate`
routes (`lib/scheduling/allocate-route.ts`) resolves the caller with
`resolveEventHostActor` (`lib/auth-helpers.ts`) after `authorizeEventAccess`. Only
ADMIN or STAFF (`staff`), the plan's own consultant (`consultant`) or an operator of
the plan's host organisation (`host-org`) pass; the consultee, who is a
participant, gets 403 `ALLOCATE_FORBIDDEN` and answers a time through reschedule.
The check lives in the route, never in `allocate`, because reschedule
accept and auto-confirm call the service legitimately. A `host-org` operator
allocates only inside the expert's published availability: the route ANDs
`override`, `allowPartial` and `topUp` with `canOverride` (`hostActor !==
"host-org"`) before dispatch.

A sponsor organisation reaches the same service through `POST
/api/organizations/[orgId]/appointments/[appointmentId]/allocate`. It must hold
`appointments.allocate.calendarRead`, the booking must be funded by that org's own
rail (`isOrgFundedByOrg`, else 403 `NOT_ORG_FUNDED`), and the request must already
be APPROVED (else 409 `EXPERT_APPROVAL_REQUIRED`). The service call passes
`approvableFrom: [APPROVED]`, so even a stale read cannot approve a PENDING request
on the expert's behalf.

A webinar or class `PUT` never changes `status`. The Zod body probes the field
and the routes answer 409 `USE_CANCEL_ROUTE` when it is present; the editor's
status intent is limited to DRAFT and SCHEDULED (`EventEditorStatusSchema` in
`schemas/event-instance.ts`, `editorStatusOrRefusal` in
`lib/api/plans/event-status.ts`). The cancel route is the only door because it
owns refunds and history.

A sold webinar or class is never re-planned. Once any buyer seat is live (a
`CONSULTEE` participant that is HELD, CONFIRMED or ATTENDED; the host's own
participant row never counts), a manual or auto allocation that would replace its
sessions answers 409 `USE_RETIME`: `assertGroupEventUnsoldInTx`
(`lib/booking/allocation/guards.ts`) counts the live seats with `tx` right after
`guardAllocationInTx` takes the event's advisory lock, so a seat checkout that
commits first is always seen. A top-up that only appends sessions skips the check.
The move for a sold event is the webinar re-time (`retimeWebinar` in
`lib/booking/event-retime.ts`, the "Move to a new date" button) or, for a class,
the series move (`retimeClassSeries`, "Move upcoming sessions"), which carry the
24-hour notice and the `retimeBy` free leave. The series move reads a snapshot
before its locks and re-reads the class status and its movable sessions inside
the transaction, refusing with 409 `RETIME_NOT_ALLOWED` when they differ. The host's menu and the timings page apply the same rule
through `allowsManageTimings`, but they are conveniences; the transaction is the
control.

## 10. Sweeps are scoped to the lapsed buyer and bounded in time

The abandoned-payments sweep (`scripts/payments/cleanup-abandoned-payments.ts`)
builds its include from `lapsedPendingPayment`, so the gateway cancel, the
expiry, the credit restore and the seat release all see only the payment whose
own hold has lapsed, never a sibling buyer's live checkout on the same group
event. Credits and seats are gated on the per-row PENDING to EXPIRED win, the
seat release moves HELD to CANCELLED only, on that payment's own appointment, and
a skipped or failed unit rotates behind fresh ones by touching `updatedAt`.

`auto-complete-appointments` and `detect-consultant-no-shows` keep their
30-minute cadence and bite size but loop bites inside one cron lock until a bite
reads a short cohort or `startDeadline` (`lib/cron/run-deadline.ts`,
`SWEEP_START_DEADLINE_MS`) says the sweep must stop **starting** rows; a row in
flight still finishes. Rows a bite read but left in the cohort are excluded by id
from later bites. Trial expiry isolates each row, rotates a failed row by
`updatedAt` and runs its arms in separate `try` blocks so the refund arm always
runs. Per-row failures go through `createRunFailureReporter`
(`lib/observability/run-failures.ts`), one Sentry event per failing op per run,
and a standing condition goes through `reportStandingFinding`
(`lib/observability/standing-finding.ts`), one event per distinct id per day;
never capture inside a row loop.

## 11. Seat checkout holds the event key only around its commit

A webinar or class seat checkout writes the PENDING `Payment` (a `premint_`
intent) and the HELD seat under `event-checkout:` with the Serializable recount,
releases the key, mints the gateway order, then fills the order id into the row
by CAS (`lib/payments/checkout/seat-pre-mint.ts`). One buyer's gateway round
trip therefore never holds the next buyer behind the event mutex. A seat that
lapses before its order can be filled answers 409 `SEAT_HOLD_LAPSED`.

The seat holds for `SEAT_CHECKOUT_HOLD_MS`: the 12-minute gateway window
(`SEAT_GATEWAY_TIMEOUT_MS`, the order's capture window and the payment sheet's
timeout) plus a 3-minute capture grace (`SEAT_CAPTURE_GRACE_MS`) for a late UPI
or netbanking capture (`lib/payments/constants.ts`). `buildDeadSeatFilter`
(`utils/scheduling-engine/occupancyPolicy.ts`) is the seat twin of
`buildDeadHoldFilter`: a HELD seat whose own payment is EXPIRED, FAILED or
PENDING past its window stops counting for capacity and for the buyer's own
calendar at once, before any sweep releases it. A seat leave or removal stamps
its refund owed in the commit that releases the seat, so the
`retry-auto-refunds` sweep re-drives a crash.

A free seat rejoin is a seat checkout like any other: it takes the same key and
the same Serializable recount, so two rejoins, or a rejoin and a new buyer, for
the last seat seat exactly one and refuse the other `EVENT_FULL`. The handler
reads the buyer's prior payment before `recordParticipants` revives the row and
revives only `CANCELLED`; a removed seat never revives
(`removedByUserId: null` in the revive's WHERE), and the handler's
`stampRecordedSeat` refuses the commit when the seat write did not reach an
unmarked row in the checkout's status. Lifting a removal clears the mark by
compare-and-set (staff on `removedByUserId: { not: null }`, the organiser on
`removedByUserId` equal to themselves), so a second lift and an overturn that
lands after a lift change nothing. A leave's Stream removal is driven only by
its durable revoker, which re-reads the seats after its vendor calls and
re-syncs anyone a rejoin re-admitted meanwhile, inside its budget; deferred
work leaves the intent owed for the sweep's re-drive to re-grant. A removal the
drive could not confirm (it timed out or failed) may still land after that
re-grant, so its user's intent stays owed through it, and a removal that lands
after its budget (`withinBudget`'s `onLate`) re-reads the join gate and re-arms
the intent of anyone it admits (`rearmReadmittedSeats`), the seat twin of the
conduct block's `repairIfStale`. Every event
seat move writes its SEAT history row on the same `tx` as the move
(`lib/booking/seat-history.ts`); a caller whose CAS pins one from-status skips
the pre-read.

## Deprecated & Superseded Approaches

- **Per-atom sequential slot locks.** `lockSlotInterval` used to take atoms one
  by one and unwind on a held atom, which eroded the earliest atoms' TTL and let
  two writers each hold half a window. It is now a thin wrapper over the atomic
  batch; write new code against `tryLockSlotBatch` or `lockSlotBatch`.
- **An allocator with no slot atoms, and day-sharded `auto-allocate:` keys.**
  Allocation once relied on the consultant key and the exclusion constraint
  alone, so it could place over a live checkout hold. The day shards are
  collapsed into one key per consultant.
- **The event key held across the gateway call.** Seat checkout once held
  `event-checkout:` through the order mint with TTLs up to 600 s for classes, so
  a slow gateway queued every other buyer.
- **The `trial-slot-booking:` namespace.** Nothing else read it, so a trial and
  a checkout for the same consultant-minute never contended. Trials take the
  shared `slot-booking:` atoms; the namespace must not come back.
