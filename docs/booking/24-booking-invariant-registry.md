# Booking Invariant Registry

Every rule this subsystem must always hold, with the layer that enforces it, the
key it contends on, and where it is tested.

This is a **registry, not a chapter.** [`12-concurrency-and-locking.md`](./12-concurrency-and-locking.md)
explains the mechanisms; this file answers a narrower question: *for this
specific rule, what stops it being broken, and what happens if that is not
enough?* The answer is rarely one layer, and the difference between one layer
and two has bitten this codebase before — so the "Enforcement" column names the
weakest layer first and the strongest last, and the strength column is honest
about rows with no structural backstop at all.

Scope: the booking aggregate (consultation, subscription, webinar, class, trial,
occurrence, reschedule), plus the money-identity invariants booking writes
against. Enterprise seat-metering and tax invariants are out of scope and belong
to [`docs/enterprise/70-design-decisions/13-postgres-native-concurrency.md`](../enterprise/70-design-decisions/13-postgres-native-concurrency.md).

## How to read the enforcement column

| Layer | What it means | What it does not mean |
| --- | --- | --- |
| **DB constraint** | A `CHECK`, `UNIQUE`, `EXCLUDE`, FK `RESTRICT`, or trigger in the schema or a `prisma/sql/` sidecar. Holds against any writer, including raw SQL. | — |
| **DB transaction** | A `Serializable` transaction plus `withSerializableRetry`. Holds against any writer, but the loser gets an error, not a refusal. | It does not make a race impossible — it makes the race a retry. |
| **CAS** | The allowed-from set is inside the `UPDATE`'s `WHERE`. Holds against any writer, atomically, and answers a lost race with "matched zero rows". | It holds only for the column it names. A second predicate that must also hold belongs in the same `WHERE` (ADR A11). |
| **Redis atom** | `SET NX PX` with a guarded front door. Holds only against processes that took the same key. | **Nothing.** A TTL can lapse, Redis can be partitioned, and a path that forgets the key gets no protection. |
| **Application** | A check in a route or service. | It holds against nothing concurrent. It is documentation and error text until a lower layer agrees. |

Sidecar objects ship in three files, applied by `npm run db:sidecars` after
`prisma db push`, and asserted against the live database by
`scripts/ci/check-db-sidecars.ts` using the parser in
`scripts/db/sidecar-objects.ts` — which discovers triggers as well as indexes and
constraints, so a new one needs no registry entry here to be enforced.
`prisma/sql/check-constraints.sql` also carries a banner of constraints **staged
for the pre-MVP reset**; those are listed below and marked STAGED, because until
the reset they are not enforced at all.

---

## 1 · Capacity and double-booking

### 1.1 A consultant is never double-booked on an exclusive (1:1) slot

> No two confirmed, non-tentative occurrences may overlap in time for the same
> consultant.

- **Enforcement:** DB `EXCLUDE USING gist` (`occurrence_no_confirmed_overlap`) →
  application conflict re-scan inside the write transaction → Redis
  `slot-booking:` atoms.
- **Contention key:** `slot-booking:{consultantProfileId}:{atomStartISO}` — one
  key per 30-minute atom of the requested interval, acquired in ascending order.
- **Why the constraint is partial:** `consultantProfileId IS NOT NULL AND NOT
  isTentative AND deletedAt IS NULL`. The denormalized id is set by every 1:1
  occurrence creator; webinar/class attendee rows deliberately leave it NULL
  (many same-window rows per event are legitimate) and tombstoned rows are
  exempt so a cancelled time can be re-booked (#1694).
- **Failure mode:** Postgres `23P01`, mapped to 409 by
  `SchedulingService.classifyError`.
- **Tested:** `__tests__/db/occurrence-overlap-tombstone.test.ts` (the tombstone
  exemption and that the swap script builds the identical predicate),
  `__tests__/booking-algorithm/trial-slot-integrity.test.ts`,
  `__tests__/booking-algorithm/wave1-p0-regression-pins.test.ts`.

### 1.2 A consultee is never double-booked across two different consultants — **no DB backstop**

> One person may not hold two overlapping confirmed sessions, whoever the
> consultant is.

- **Enforcement:** application, and it is the only structural layer.
- **Contention key:** `consultee-booking:{consulteeUserId}`.
- **The gap, stated plainly:** `occurrence_no_confirmed_overlap` is keyed on
  `consultantProfileId` and **cannot see a consultee at all**. So the two guards
  are: the Redis mutex above, and a predicate re-read *inside* the `Serializable`
  write transaction (`assertConsulteeHasNoOverlappingSession` in
  `lib/payments/operations/checkout.ts`). The read has to be on the transaction
  that writes the occurrence — it is the read/write antidependency that makes SSI
  abort one twin. The earlier check in `revalidateInsideLock` runs in a
  `ReadCommitted` transaction that **commits before** the write transaction
  opens, so it closes nothing; it is error text and an early exit, not the
  guarantee.
- **What breaks if Redis is bypassed:** SSI still aborts one of the pair and the
  retry sees the winner's row, so a correctly-written path is safe. What is not
  protected is any path that writes the occurrence without re-reading the
  consultee predicate on the same transaction — and there is no DB constraint to
  catch it.
- **Tested:** `__tests__/booking-algorithm/wave1-p0-regression-pins.test.ts`
  (pins the re-read being on the write transaction, not the read-committed one).

### 1.3 A webinar or class is never oversold — **no structural DB backstop**

> Live seats never exceed the event's capacity.

- **Enforcement:** DB transaction (a `Serializable` recount of live
  `AppointmentParticipant` rows, tentative-inclusive, inside the write
  transaction) → Redis `event-checkout:{appointmentType}:{eventOrPlanId}`.
- **Contention key:** `event-checkout:`.
- **The gap, stated plainly:** capacity is a *count*, not a uniqueness, so there
  is no index or `CHECK` that could express it. The entire guarantee is the
  serializable read-then-write plus the mutex. A writer that inserts a seat
  without the recount — or a recount that does not filter by the same
  `liveParticipant` predicate the readers use — oversells silently.
- **Failure mode:** Prisma `P2034`, retried by `withSerializableRetry`; the
  loser of a last-seat race re-runs and sees the sold seat.
- **Tested:** `__tests__/booking-algorithm/class-crud-conflict-mapping.test.ts`,
  `__tests__/booking-algorithm/checkout-busy-retry.test.ts`,
  `__tests__/booking-algorithm/participant-shadow-write.test.ts`.

### 1.4 At most one live reschedule per appointment

> An appointment can be under at most one open reschedule proposal.

- **Enforcement:** DB `UNIQUE` on `RescheduleRequest.openForAppointmentId`, which
  is **nullable** — open rows claim it, resolved rows NULL it. Postgres treats
  NULLs as distinct, so resolved history accumulates freely.
- **Contention key:** `appointment-lock:{appointmentId}`.
- **This is the only guard.** The propose route has no pre-check; the 409 is a
  bare `P2002` catch. Every list-select, the withdraw route and
  `occurrencesAllowReschedule` read "at most one" as given.
- **Tested:** `__tests__/booking-algorithm/reschedule-proposal-schema.test.ts`,
  `__tests__/booking-algorithm/reschedule-withdraw.test.ts`.

### 1.5 A live occurrence ordinal is unique within its appointment

> Two live sessions cannot claim the same position in a purchase; a
> RESCHEDULED / CANCELLED / VOIDED row keeps its number for history.

- **Enforcement:** DB partial `UNIQUE` (`appointment_occurrence_live_ordinal_key`).
- **Contention key:** `auto-allocate:{consultantProfileId}` (the allocator mints
  ordinals under it).
- **Tested:** `__tests__/booking-algorithm/allocate-reschedule-count.test.ts`.

### 1.6 At most one open rate-card window per scope

> A scope has one `effectiveTo = NULL` card.

- **Enforcement:** DB partial `UNIQUE … NULLS NOT DISTINCT` where
  `effectiveTo IS NULL` (`rate_card_one_open_window`) → `Serializable` rotation
  in `bumpRateCard`.
- **Contention key:** none; the scope key is the card's own columns.
- **Note:** three of the four scope columns are nullable and NULLs are exactly
  the case that must *not* be exempt, hence `NULLS NOT DISTINCT`. An
  enum-to-text `COALESCE` is not `IMMUTABLE` and Postgres refuses it in an index
  — the constraint is the workaround, not a preference.
- **Tested:** `__tests__/payments/invoice-rollup-serialization-retry.test.ts`,
  `__tests__/booking-algorithm/schema-shape.test.ts`.

### 1.7 At most one pending invite per (organization, lower(email))

- **Enforcement:** DB partial `UNIQUE` (`invitations_org_email_pending_key`) →
  the `Serializable` tx in `app/api/organizations/[orgId]/invitations/route.ts`.
- **Contention key:** none.
- **Note:** `lower(email)` because the accept flow compares case-insensitively;
  the index must not admit a mixed-case duplicate from any other writer.
- **Tested:** `__tests__/booking-algorithm/schema-shape.test.ts`.

### 1.8 At most one active erasure request per user

- **Enforcement:** DB partial `UNIQUE` (`erasure_request_active_user_key`), above
  the sidecar's staged banner so it is live today.
- **Contention key:** none.
- **Note:** this is the same shape as §1.7, and it is the reason the staged
  banner exists as a concept: a partial unique over existing rows can only be
  created once the data satisfies it, so anything that might not ships commented
  below `APPLIED AT THE PRE-MVP RESET`. `CREATE` then fails loudly against a
  violating dev database, which is the correct outcome — the constraint is never
  silently skipped.

---

## 2 · State machines

### 2.1 A lifecycle status only ever moves along a declared edge

> `PENDING → APPROVED → SCHEDULED → COMPLETED` and the legal re-entries, and
> nothing else.

- **Enforcement:** CAS. The allowed-from set is baked into the `UPDATE`'s
  `WHERE`, and Postgres re-evaluates the predicate under the row lock, so two
  racing transitions serialize and exactly one wins.
- **Contention key:** none of its own — the CAS is what makes a lock
  unnecessary. The lock families exist to remove contention, not correctness.
- **Authoritative maps:** `REQUEST_ALLOWED_FROM`, `EVENT_ALLOWED_FROM`,
  `TRIAL_ALLOWED_FROM`, `RESCHEDULE_ALLOWED_FROM`, `OCCURRENCE_COMPLETION_ALLOWED_FROM`,
  `LIVE_PARTICIPANT_STATUSES` — all in `lib/booking/transitions.ts` and
  `lib/booking/participants.ts`.
- **A zero-row match is the normal answer,** not an error: the helper throws
  `IllegalTransitionError` where a caller must know, and returns a count where a
  sweep is expected to skip rows it lost a race to.
- **There is no DB constraint here,** and this is deliberate (ADR A11). A
  `CHECK` cannot see the prior value; the only structural equivalent would be a
  trigger, and a trigger cannot know the caller's intended edge.
- **Tested:** `__tests__/booking-algorithm/cas-bypass-regression.test.ts`,
  `__tests__/booking-algorithm/occurrence-completion-transitions.test.ts`,
  `__tests__/booking-algorithm/withdraw-approval.test.ts`.

### 2.2 Every guarded transition appends exactly one audit row, in the same transaction

> A booking that exists has a timeline; a transition that happened is recorded.

- **Enforcement:** application (the helper owns both writes), plus a DB
  **append-only trigger** on the log itself.
- **Contention key:** none.
- **The two non-enum from-statuses** are named constants in
  `lib/booking/transitions.ts`, not literals: `HISTORY_FROM_CREATED` (the row
  that is not a transition) and `HISTORY_FROM_UNKNOWN` (the pre-read missed this
  row). `HISTORY_FROM_UNKNOWN` reports itself per occurrence, so an audit gap is
  countable rather than silent.
- **Tested:** `__tests__/booking/status-history.test.ts`,
  `__tests__/booking-algorithm/booking-status-history.test.ts`,
  `__tests__/booking-algorithm/booking-timeline-read.test.ts`.

### 2.3 The audit log cannot be edited or deleted

- **Enforcement:** DB trigger `booking_status_history_immutable` (`BEFORE UPDATE
  OR DELETE`), same argument and shape as `ledger_entry_immutable`.
- **Why it is not staged behind the reset banner:** a trigger fires on *future*
  writes and never scans existing rows, so it cannot fail against pre-reset data.
  Only a constraint that validates what is already in the table needs the reset
  window.
- **What it protects:** `reschedule-restore` reads the status a request held
  *before* a reschedule off this table, and `response-rate` measures consultant
  response time from the earliest `CREATED` row. A rewritten row moves a booking
  back to a status it never had, or silently moves a published number.
- **Tested:** `scripts/ci/check-db-sidecars.ts` asserts the trigger exists on the
  live database; `__tests__/booking-algorithm/schema-shape.test.ts` pins the sidecar inventory.

### 2.4 An occurrence's liveness is status plus tombstone, never a DELETE

> A released slot keeps its row so the dispute and history trail survives.

- **Enforcement:** application, and it is uniform by construction: every release
  path goes through `transitionOccurrenceCompletion` with
  `data: { deletedAt }`, and `allowZero` marks the sweeps.
- **Contention key:** `auto-allocate:` / `slot-booking:`.
- **Tested:** `__tests__/booking-algorithm/occurrence-liveness-predicates.test.ts`,
  `__tests__/booking/cleanup-tentative-guard.test.ts`,
  `__tests__/booking/expire-unpaid-trials-tombstone.test.ts`.

---

## 3 · Money identity

### 3.1 Payment legs sum to the payment

> Σ `PaymentLeg.amountPaise` (signed, with `*_REVERSAL` siblings) = `Payment.amount`.

- **Enforcement:** DB **deferred constraint trigger**
  (`payment_legs_sum_to_amount`), plus a second trigger on `Payment` updates that
  re-asserts it.
- **Contention key:** none.
- **Tested:** `__tests__/payments/multi-party-booking-journal.test.ts`,
  `scripts/db/validate-ledger-trigger.ts`.

### 3.2 A ledger transaction balances to zero

> Σ DEBIT − Σ CREDIT = 0 per `LedgerTransaction`.

- **Enforcement:** DB **deferred constraint trigger** (`ledger_txn_balanced`),
  so a transaction may post its legs in any order inside its own transaction.
- **Tested:** `__tests__/payments/multi-party-booking-journal.test.ts`.

### 3.3 The journals are append-only

- **Enforcement:** DB `BEFORE UPDATE OR DELETE` triggers on `LedgerEntry`
  (`ledger_entry_immutable`), `LedgerTransaction`
  (`ledger_transaction_immutable`), `UsageLedgerEntry`
  (`usage_ledger_entry_immutable`), `ConsultantReviewRevision`
  (`review_revision_immutable`) and `BookingStatusHistory`
  (`booking_status_history_immutable`).
- **Why this matters here:** `reverseBookingUtilization` computes "how much of
  this booking has already been reversed" by summing its negative rows, and the
  nightly `reconcile-ledgers` asserts Σ `engagementsConsumed` against
  `ProgramAssignment.engagementsUsed`. Both are only true while rows cannot be
  edited — an `UPDATE` passed silently, and the next reversal re-released a seat
  the org had already paid back.
- **Tested:** `scripts/ci/check-db-sidecars.ts`.

### 3.4 Money amounts are non-negative and tax heads are exclusive

- **Enforcement:** DB `CHECK` on every money table: `payment_amounts_nonnegative`,
  `payment_leg_nonreversal_nonnegative`, `refund_amount_nonnegative`,
  `dispute_amount_nonnegative`, `consultant_payout_amounts_nonnegative`,
  `org_payout_amounts_nonnegative`, `ledger_entry_amount_positive`,
  `consumer_invoice_tax_head_xor` and its credit-note twin,
  `tds_record_deductee_xor`, `tds_record_payout_rail_matches`.
- **Note the two deliberate `>= 0` rather than `> 0` floors:** credit-covered
  checkouts and org-sponsored bookings legitimately write `amount = 0` (the
  `free_` / `org_` synthetic payment intents).

---

## 4 · Retention and deletion

### 4.1 Money rows Restrict their parents; removal is a soft delete

> A user, consultant profile or organization with money history cannot be hard
> deleted.

- **Enforcement:** FK `ON DELETE RESTRICT` at the database.
- **The application half:** `DELETE /api/user/[id]` counts payments, referral
  credits, held seats and consultant earnings/payouts/TDS records; anything
  non-zero takes the DPDP §12 **scrub** path (`erasedAt` + pseudonymised PII)
  instead. A hard delete would otherwise 500 on the first `Restrict` and destroy
  records the schema's own comment says are retained per IT Act §44AA and CGST
  §36.
- **Note:** the scrub **never deletes the `User` row**. That is why a `Restrict`
  on `AppointmentParticipant.user` cannot break the compliance erasure flow —
  see the ADR note on the schema for the full argument.
- **Tested:** `__tests__/compliance/erasure-novu-offboarding.test.ts`,
  `__tests__/payments/appointment-delete-forbidden.test.ts`.

### 4.2 A delivered seat survives its payer

> Deleting a user must not erase the record that a person held a place on an
> event and that the consultant delivered it.

- **Enforcement:** FK `ON DELETE RESTRICT` on `AppointmentParticipant.user`, and
  `ON DELETE SET NULL` on `AppointmentParticipant.paymentId` (#781 §B).
- **Why the asymmetry with `paymentId` is the tell:** a soft-deleted `Payment`
  must not take the participation record with it. Cascade on `user` contradicted
  that on the same model — it destroyed the funding fact **and** the fact of
  participation at once.
- **Tested:** `__tests__/payments/appointment-delete-forbidden.test.ts`,
  `__tests__/compliance/erasure-novu-offboarding.test.ts`.

### 4.3 Money-free deletion still removes personal data

> A user with no money and no seat can be hard deleted.

- **Enforcement:** application gate, plus FK cascade for the profile tables.
- **Contention key:** none.

---

## 5 · Availability

### 5.1 A consultant's published hours are the only bookable time

> A booking may only land inside a published availability window, on the 30-minute
> grid.

- **Enforcement:** application, in three layers (Zod shape, `ScheduleValidationService`
  rules, allocator re-validation) — ADR B3. **No DB constraint.**
- **Contention key:** `auto-allocate:{consultantProfileId}` (whole consultant,
  because slots are discovered dynamically under the lock).
- **Tested:** `__tests__/booking-algorithm/availability-grid-alignment.test.ts`,
  `__tests__/booking-algorithm/availability-grid-snap.test.ts`,
  `__tests__/scheduling/availability-contract.test.ts`,
  `__tests__/booking-algorithm/allocator-grid-alignment.test.ts`.

### 5.2 Availability rows have no tombstone

- **Enforcement:** none, by decision. Every removal path hard-deletes, so a
  `deletedAt` on `AvailabilityWindowWeekly` / `AvailabilityWindowCustom` would be
  a column nothing could ever write. `ConsultantProfile.deletedAt` is the
  tombstone that covers them.
- **Why it matters to a reader:** a consultant's availability disappearing is a
  profile-level fact, not a row-level one, and it was previously obscured by a
  `deletedAt: null` filter in the profile-completion count that looked like
  maintenance and was not.

---

## 6 · What has no test worth naming

Named so the gap is a decision rather than an oversight:

- **The consultee double-book (§1.2) has no integration test.** It is pinned by
  a source-reading regression test that asserts the predicate is re-read on the
  write transaction. A behavioural test would need two concurrent Serializable
  transactions against a live database, which this suite does not do for any
  invariant.
- **Oversell (§1.3) is pinned by unit tests of the recount and the mapping**, not
  by a two-buyer race.
- **Every DB constraint is enforced, not tested.** There is no test that inserts
  an invalid row and asserts the error; `scripts/ci/check-db-sidecars.ts` asserts
  the constraint *exists* on the live database, which is the part that rots.
- **`db push` behaviour on a dropped enum value is untested by construction** —
  see the note on `RescheduleRequestStatus` in the schema.
