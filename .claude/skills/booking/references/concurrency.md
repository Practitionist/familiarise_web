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
top of the exclusion constraint: the #827 confirm-time recheck inside its own
Serializable transaction re-scans for a conflict before stamping a captured
payment's occurrence CONFIRMED, so two concurrent capture webhooks for
overlapping intervals resolve to one confirmation and one
`doubleBookingBlocked` result rather than both landing (`lib/payments/webhooks/handlers.ts`).

## 1. One key shape per atom, minted in one file

Every distributed lock key in this subsystem is minted in
`utils/appointmentlock.ts` and nowhere else, because two names for one atom is
no lock at all.

| Atom                                    | Key shape                                            | Minted by                                 |
| --------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| 30 minutes of one consultant's calendar | `slot-booking:<consultantProfileId>:<atomStartISO>`  | `lockSlotInterval` / `lockSlotBooking`    |
| One consultee's booking activity        | `consultee-booking:<consulteeUserId>`                | `lockConsulteeBooking`                    |
| One sellable event or plan              | `event-checkout:<appointmentType>:<eventOrPlanId>`   | `lockEventCheckout`                       |
| One consultant's allocation pool        | `auto-allocate:<consultantProfileId>[:<scope>]`      | `lockAutoAllocate`                        |
| One consultation approval               | `consultation-approval:<consultationId>`             | `lockConsultationApproval`                |
| One subscription approval               | `subscription-approval:<subscriptionId>`             | `lockSubscriptionApproval`                |
| One pay-link mint                       | `approval-payment-mint:<kind>:<id>`, kind lowercased | `lockApprovalPaymentMint`                 |
| One appointment's lifecycle             | `appointment-lock:<appointmentId>`                   | `lockAppointment` / `withAppointmentLock` |

The `trial-slot-booking:` namespace is retired and must not come back. Nothing
else read it, so a trial and a checkout for the same consultant-minute never
contended; trials now take the shared `slot-booking:` atoms (#1093, #1170).

Every path acquires in one global order — **appointment / event / consultant →
consultee → slot** — so the families form a total order that cannot cycle. The
one deliberate nesting is approval → mint: the approval routes still hold their
approval key when they mint the pay link, so the mint is its own atom
underneath, never the reverse.

Every writer that moves one booking's lifecycle takes the `appointment-lock:`
atom before it opens its transaction. That includes the reschedule withdraw
(#1583) and, as of #1846, the abandon door, the reschedule expiry sweep (which
expires and restores in one transaction under it), trial DELETE (which moves
the status and tombstones the session in one transaction on its own client),
and moderation's bulk cancel, which takes the lock per engagement. A request or trial with no appointment yet has no atom, so its CAS
alone decides. Offering DELETE takes the `event-checkout:` key checkout takes
for the same webinar, class or subscription plan, with an explicit 75-second
TTL and one retry so the lock outlives every attempt; a consultation plan has
no checkout key, so the Serializable transaction and the in-WHERE guard carry
that race alone.

## 2. Slot locks are interval-granular and all-or-nothing

`slotAtomStarts` floors the start to the half-hour grid (`SLOT_ATOM_MS` is
`30 * 60 * 1000`) and returns one atom per 30 minutes of `[startsAt, endsAt)`,
so an unaligned booking still collides with every aligned booking it overlaps.
`lockSlotInterval` takes those keys in ascending order — a total order, hence
deadlock-free — and on a held atom or a Redis fault releases everything already
taken, in reverse, before throwing. With several atoms held it re-arms them all
to a fresh shared deadline, since sequential acquisition erodes the earliest
atoms' TTL; a failed re-arm means ownership was lost, so abort.

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

Treat the ceiling as an observed figure, not a configured one: there is no
`26000` constant and no `[functions]` timeout block in `netlify.toml`, only
comments, and `lib/prisma.ts` explicitly disowns the old arithmetic around it.

## 5. TTL must outlive the transaction, and be renewed per attempt

A lock TTL is sized above the transaction it protects, then reduced by the drift
factor (`effectiveTTL = floor(ttl * (1 - driftFactor))`). `APPROVAL_LOCK_TTL_MS`
is 45 s against a 30 s Serializable transaction; `APPOINTMENT_LOCK_TTL_MS` is
75 s against a 60 s reschedule transaction plus its maxWait; `lockAutoAllocate`
and `lockConsulteeBooking` default to 150 s against a 120 s transaction. Per
checkout type, `CHECKOUT_LOCK_TTL_MS` is `CONSULTATION` 60 s, `SUBSCRIPTION` and
`WEBINAR` 120 s, `CLASS` 600 s, because a class checkout writes many sessions
plus a gateway round trip.

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
transient rollbacks Postgres reports — `P2034` (SQLSTATE 40001, the driver
adapter's mapping of a serialization failure) and a deadlock victim (40P01,
detected by `isDeadlock` in `lib/db/pg-errors.ts` because the pinned adapter
rethrows it unmapped) — up to `SERIALIZABLE_MAX_RETRIES` (3), four attempts
total, with 50/100/200 ms backoff plus jitter. Each retry and each exhaustion
emits a `db.serializable_retry` metric tagged with the reason. Anything else (an `IllegalTransitionError`, a
validation error, a 409) propagates immediately, by design: a business rejection
must never be retried into accidental success. Because the callback runs up to
four times, nothing inside it may be non-idempotent; gateway calls,
notifications, emails and pay-link mints belong after the commit, and a lock
grant taken before the loop must be renewed inside it (see §5).

Exhausted retries surface as a 409 — checkout answers `errorType:
"SERIALIZATION_CONFLICT"` with `yourCardWasNotCharged: true` — never a 500. An
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
