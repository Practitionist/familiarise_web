# ADR B13 — The lock families, their order, and what a lock is not

> Status: **adopted**. The mechanisms in this subsystem were written down
> descriptively in [`12-concurrency-and-locking.md`](./12-concurrency-and-locking.md)
> — what the functions are, what they key on, how they retry — but never as a
> *decision*. A reader could see seven lock families and a `SET NX PX` and infer
> either "distributed locking is the correctness mechanism" or "the locks are a
> performance optimisation and Postgres is the answer". Both inferences are wrong
> for different rows, and the three gaps at the bottom of this record are the
> price of the looseness. This ADR fixes the order, fixes the failure posture,
> and states the three known gaps rather than leaving a reader to infer that
> there are none. Decided by the booking owner as part of the wave-1
> production-readiness work; the code it describes is `utils/appointmentlock.ts`,
> `lib/booking/transitions.ts` and `lib/db/serializable-retry.ts`.

## The decision

**Concurrency in this subsystem is Postgres-first. Redis removes contention; it
never provides the guarantee. And the locks are acquired in one global order, so
the set is a total order and cannot cycle.**

Three clauses, and each of them is a decision rather than a description.

### 1 · The database is the authority; the lock is an optimisation

Every lifecycle status write is a compare-and-set: the allowed-from set is baked
into the `UPDATE`'s `WHERE` (`lib/booking/transitions.ts`), and Postgres
re-evaluates the predicate under the row lock, so two racing transitions
serialize and exactly one matches a row. A zero-row match is a *normal answer* —
it is what "somebody else moved it" looks like — and callers turn it into either
a typed refusal or a skip.

For 1:1 capacity there is a structural layer above that: the
`occurrence_no_confirmed_overlap` `EXCLUDE` constraint, which refuses the overlap
at commit with `23P01` however the row got there.

So a Redis outage costs latency and a 503, never correctness. That is the whole
reason the failure posture below is safe.

### 2 · One global acquisition order: consultant → consultee → slot

Coarsest key first, and the order never varies by route:

```
event/consultant  →  consultee  →  30-minute slot atoms
```

- `auto-allocate:{consultantProfileId}` and `event-checkout:{type}:{id}` are
  coarsest. The allocator discovers its slots dynamically under the consultant
  lock, so it cannot know which atoms to take beforehand.
- `consultee-booking:{consulteeUserId}` sits in the middle. It closes the
  cross-consultant double-book that the consultant-keyed `EXCLUDE` constraint
  structurally cannot see.
- `slot-booking:{consultantProfileId}:{atomStartISO}` is finest, one key per
  30-minute atom of the requested interval, acquired **in ascending order** so
  two overlapping intervals cannot take the same atoms in opposite directions.

Because the order is fixed and each family's keys are disjoint from the others',
the family relation is a total order on keys, and a total order has no cycles.
The approval and lifecycle families (`consultation-approval:`,
`subscription-approval:`, `appointment-lock:`, `approval-payment-mint:`,
`recording-purchase:`) are single keys taken alone.

**The one documented inversion.** Checkout is not uniform, because the two
request shapes have different coarsest keys:

```ts
// lib/payments/operations/checkout.ts
const isSlotBasedCheckout = !!validatedData.startsAt;
if (isSlotBasedCheckout) {
  consulteeLock = await lockConsulteeBooking(...);   // consultee BEFORE slot
}
lock = await acquireCheckoutLock(validatedData, planData);
if (!isSlotBasedCheckout) {
  consulteeLock = await lockConsulteeBooking(...);   // consultee AFTER event
}
```

For a slot-based (consultation) checkout the consultee lock is taken **before**
the slot atoms; for an event-based (webinar / class / subscription) checkout it is
taken **after** the event lock. This is not an accident — it is what
"consultant → consultee → slot" means when the coarse key is an event rather than
a consultant — but it is the one place a reader has to check, because the two
branches look like a mistake. **The property that makes it safe is that no
checkout shape ever takes a slot atom while another shape holds the event lock
for the same consultant**, which is why the re-ordering cannot form a cycle. If a
future shape takes both, the order has to be reconciled here first.

### 3 · Booking locks fail CLOSED; contention fails OPEN

Every booking family acquires through one guarded front door, `acquireGuarded`:

| Condition | Answer | Why |
| --- | --- | --- |
| Redis unreachable (health probe, or the circuit breaker tripped) | `BookingLockUnavailableError` → **503** | An unlocked booking must not proceed. Refusing is recoverable; double-booking is not. |
| Redis healthy, key genuinely held after retries | typed `409` (or `423`), retry-after where the caller has one | Benign and expected. A held lock is *not* a Redis fault, so it is deliberately kept out of the breaker's failure count. |

`lockEventCheckout` is the one family that does not go through `acquireGuarded` —
it is the flash-sale mutex — and it implements the same two answers itself.

Contention is now reported per family (`booking lock contended`, tagged by the
**atom family**, never the key: a key embeds a cuid or an ISO instant and would
be unbounded-cardinality as a Sentry tag). It is `logger.warn` on the slow path
only, because a held lock already cost seconds of backoff and is a modelled
outcome, not a fault.

---

## TTL versus the transaction it wraps

A lock TTL is a guess about how long the work under it can take, and the work
under a booking lock is a database transaction whose duration is bounded by
`maxWait` plus `timeout`, times the number of `withSerializableRetry` attempts.
The arithmetic has to be done, because a TTL that expires mid-transaction does
not corrupt state — every CAS carries its predicates in its `WHERE` — it only
loses the *serialisation*, which is the entire reason the key exists.

| Family | TTL | Worst case it must cover | Margin |
| --- | --- | --- | --- |
| `consultation-approval:` / `subscription-approval:` | `APPROVAL_LOCK_TTL_MS` = 45 s | one attempt (10 s `maxWait` + 15 s `timeout`) | ~2× |
| `appointment-lock:` | `APPOINTMENT_LOCK_TTL_MS` = 75 s | reschedule 60 s + `maxWait`; cancel 40 s | ~1.25× |
| `slot-booking:` / `event-checkout:` (default) | `DEFAULT_LOCK_TTL` = 60 s | one booking transaction | thin |
| `auto-allocate:`, `consultee-booking:` | 150 s | the whole allocation transaction | ~1× |
| checkout by type (`CHECKOUT_LOCK_TTL_MS`) | CONSULTATION 60 s / SUBSCRIPTION 120 s / WEBINAR 120 s / **CLASS 600 s** | see below | sized |
| `recording-purchase:` | 30 s | the mint | ~2× |

Two of these are sized rather than defaulted:

- **CLASS at 600 s** is the documented serverless-freeze worst case: a freeze
  suspends the instance *after* the single pre-gateway renewal, while Redis keeps
  counting the TTL down. At the previous 300 s a frozen checkout could lose
  ownership mid-payment and let a second instance in. 600 s consolidates the old
  end-to-end envelope (initial window plus one renewal, ~594 s effective after
  the 1 % drift factor) into a single grant, so a late freeze cannot outlive
  ownership. Hard-crash stalls stay bounded where it matters: contention losers
  hold only `CHECKOUT_WAIT_RETRY_CONFIG` (~7 s) and get a structured 409, and the
  `Serializable` recount plus `#440` remain the correctness backstops.
- **The 1 % drift factor** is applied to every TTL (`effectiveTTL = floor(ttl ×
  (1 − driftFactor))`), which is the clock-skew allowance between the app server
  and Redis, not a performance knob.

**Renewal exists for the two families whose retry loop outlives their fixed
grant.** `withSerializableRetry` is four attempts, so the approval path's worst
case is ~100 s against a 45 s grant and the lifecycle path's ~100–160 s against
75 s. Both now re-grant per attempt through `renewApprovalLock` /
`renewAppointmentLock`. Neither renewal throws: a lost grant means somebody else
holds the key, and the CAS is the authority on whether this attempt may write, so
throwing would replace a clean typed refusal with an error the callers have no
code for.

**Slot-atom renewal is a different mechanism and is not optional.** The atoms are
acquired sequentially, so the backoff spent on later atoms erodes the earlier
ones' TTLs. Once the final atom is held, every atom is re-armed to one shared
deadline; if any re-arm fails, ownership was already lost and the whole
acquisition rolls back rather than proceeding.

---

## The three known gaps

Stated because a lock system that claims no gaps is a lock system nobody has
read.

### Gap 1 · Deadlocks were not retried until this branch

`withSerializableRetry` keyed only on Prisma `P2034`. `@prisma/adapter-pg@7.7.0`
maps SQLSTATE `40001` (`serialization_failure`) to `P2034` and has **no `40P01`
case**, so a row-lock deadlock fell through unmapped and surfaced as an HTTP 500
on a money path. Upstream Prisma fixed the mapping in prisma/prisma#29717; this
repo is pinned below it, so the predicate is added in-repo (`isDeadlock` in
`lib/db/pg-errors.ts`, matching `meta.code`, `driverAdapterError.cause.originalCode`
and the bare token in the message) and the adapter upgrade is left as a separate
reviewed migration. PostgreSQL's own guidance says the same thing in advisory
form: it is advisable to retry deadlock failures.

The retry is `50 · 2^attempt + jitter(0–25 ms)` for up to 3 retries. **Nothing
else is retried**: an `IllegalTransitionError`, a `VERSION_CONFLICT` 409 and a
validation error all propagate on the first attempt, so a business rejection is
never retried into accidental success.

*Tested:* `__tests__/db/deadlock-retry.test.ts`.

### Gap 2 · Two locks could outlive their transaction's worst case

`APPROVAL_LOCK_TTL_MS` (45 s) and `APPOINTMENT_LOCK_TTL_MS` (75 s) were both
shorter than four Serializable attempts of the transactions they wrap, and
neither had a renewal. The consequence was not corruption — every CAS carried its
state and money predicates — but the two writers then ran concurrently, which is
exactly the serialisation the coarsest key exists to provide.

Closed by `renewApprovalLock` / `renewAppointmentLock` plus a per-attempt call in
the four lifecycle writers.

*Tested:* `__tests__/booking-algorithm/lifecycle-lock-renewal.test.ts`.

### Gap 3 · Checkout's lock order inverts for one request shape

Described in full above. It is not a deadlock today, because no checkout shape
takes a slot atom while another holds the event lock for the same consultant —
but that is a property of the *call sites*, not of the lock module, so nothing
enforces it. It is documented here rather than fixed because the fix (making the
order uniform) would mean taking the consultee lock before the event lock for
event checkouts too, which widens the critical section for the flash-sale path
for no correctness gain.

---

## What this ADR is not

- **Not a claim that Redis is unnecessary.** It removes real contention — the
  allocator's transaction is long and its cohort read is expensive — and the
  atom sharding is what lets two consultants allocate independently while the
  30-minute overlap is still serialised. Removing it would make the system
  correct and slower, and much harder to reason about in an incident.
- **Not a claim that every path takes the right locks.** The invariant registry
  ([`24-booking-invariant-registry.md`](./24-booking-invariant-registry.md)) is
  the place where "no structural backstop" is recorded per invariant, because the
  two worst gaps — the cross-consultant consultee double-book and webinar/class
  oversell — are not lock-order problems and this ADR cannot fix them.
- **Not a lock-design proposal.** Single-key-per-resource in Redis with a Lua
  compare-and-delete release is settled, and `docs/upstash/redis/locking/` owns
  the infrastructure detail. This ADR owns the *order*, the *failure posture* and
  the *TTL arithmetic*.

## Where the code is

| Concern | Location |
| --- | --- |
| The seven families, their keys and TTLs | `utils/appointmentlock.ts` |
| The guarded front door (fail closed, breaker, contention typing) | `acquireGuarded` in the same file |
| Per-attempt renewal of the two long-TTL families | `renewApprovalLock`, `renewAppointmentLock` |
| Slot-atom acquisition, ascending order, all-or-nothing rollback, shared re-arm | `slotAtomStarts`, `lockSlotInterval` |
| The checkout order and its one inversion | `lib/payments/operations/checkout.ts`, "STEP 2: ACQUIRE DISTRIBUTED LOCK" |
| The CAS-in-WHERE state machine | `lib/booking/transitions.ts` |
| Deadlock detection and the retry wrapper | `lib/db/pg-errors.ts`, `lib/db/serializable-retry.ts` |
| The structural backstops | `prisma/sql/check-constraints.sql` (see the invariant registry for the per-row list) |
| Where each invariant is enforced and tested | [`24-booking-invariant-registry.md`](./24-booking-invariant-registry.md) |
