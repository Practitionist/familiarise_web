# Pre-MVP database reset runbook

This runbook is the ordered, copy-pasteable procedure for the one-time reset that finalises the launch schema. It exists because several guarantees were deliberately staged for a clean database rather than applied mid-cycle: they can fail against pre-reset data (existing nulls, historical overlaps, drifted denormalisations), and applying them piecemeal would have left the assertion script reporting a permanent failure that people learn to ignore. The reset is also why wave 5 (#1319) added the `AppointmentParticipant` and `BookingStatusHistory` tables without any backfill: the reset starts from clean data, so every writer populates them from day one.

## Why there is no backfill migration

The schema is managed with `prisma db push`, not migrations, and the pre-MVP data is seed data. A backfill written now would run once against rows that are about to be discarded, and it would have to be maintained until then. The doctrine is therefore: freeze the schema shape before launch, write the new tables from every code path from the first day after the reset, and never write a data migration for pre-reset rows.

## Order of operations

Run every step from the repository root with `DATABASE_URL` pointing at the target database. Do not run any of this against the shared development database outside the agreed reset window.

1. **Capture the two phantom columns.** `ConsultantReview.isAnonymous` and `AppointmentFeedback.slotOfAppointmentId` exist in the database but not in the schema, and the push in step 3 drops them. Nothing in application code reads either, so this is insurance rather than a migration.

   ```sh
   psql "$DIRECT_URL" -At -c '\copy (SELECT "id", "isAnonymous" FROM "ConsultantReview" WHERE "isAnonymous" IS NOT NULL) TO capture-consultant-review-is-anonymous.csv CSV HEADER'
   psql "$DIRECT_URL" -At -c '\copy (SELECT "id", "slotOfAppointmentId" FROM "AppointmentFeedback" WHERE "slotOfAppointmentId" IS NOT NULL) TO capture-appointment-feedback-slot.csv CSV HEADER'

   Capture to FILES, not to tables. The 2026-09-03 additive push proved that `prisma db push` drops every table the Prisma schema does not know, so the `_phantom_*` tables that `prisma/sql/one-off/2026-09-02-capture-phantom-columns.sql` creates are removed by the very push they were meant to survive (the rows were recovered from the pre-push `pg_dump` afterwards). Keep the two CSV files with the backup from step 2.
   ```

1b. **Duplicate rows that block the new unique keys.** The push adds `AppointmentFeedback (appointmentId, userId)` and `ConsultantReview (appointmentId, consulteeProfileId)` unique keys; a duplicate pair fails the whole push mid-way. Check first with `SELECT "appointmentId", "userId", count(*) FROM "AppointmentFeedback" GROUP BY 1, 2 HAVING count(*) > 1` (and the review twin) and remove the extras deliberately (on 2026-09-03 the only pair was two QA rows from a per-slot feedback test).

2. **Snapshot.** Take a database backup through the Supabase dashboard or `pg_dump`, and record the backup identifier in the reset ticket.

3. **Push the schema and apply the sidecars.** `npm run db:push` is chained as push, then sidecars, then the assertion. Because `prisma db push` refuses in non-interactive mode when a statement drops data, run `npx prisma db push --accept-data-loss` yourself first when the diff contains the phantom-column drops, then `npm run db:sidecars && npm run db:assert-sidecars`; Prisma 7 has no `--skip-generate` flag, so a schema push can no longer silently leave `slot_no_confirmed_overlap` and the money CHECK constraints behind.

   ```sh
   npm run db:push
   ```

4. **Uncomment the STAGED block and re-apply.** The block sits at the very bottom of `prisma/sql/check-constraints.sql` under the banner that begins `STAGED FOR THE PRE-MVP RESET`. Uncomment only the statements inside that banner; three live objects used to sit below it, which is why it was moved to the true end of the file. Then re-run the sidecars and the assertion.

   ```sh
   npm run db:sidecars
   npm run db:assert-sidecars
   ```

5. **Drop the legacy review index.** `consultant_review_legacy_pair_key` kept pre-`appointmentId` review rows unique and expires with the reset once no such rows exist. Remove its `CREATE UNIQUE INDEX` from the sidecar in the same commit that uncomments the staged block.

6. **Seed.** `npm run db:seed`. The seed suite writes `AppointmentParticipant` rows alongside every seeded appointment and links them to their seeded payments; `BookingStatusHistory` starts empty by design.

7. **Drift check.** `npx tsx scripts/ci/check-db-drift.ts` and `npm run db:assert-sidecars` must both pass before the database is declared live.

## The staged constraints and their preconditions

The following four statements are the STAGED block. Each precondition must hold on the target database or the statement fails and the whole sidecar run stops.

| Constraint                                                                 | Precondition                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Payment.clientIdempotencyKey SET NOT NULL`                                | No Payment row has a null key. Writers have minted keys since #1169 PR 9, so only pre-reset rows can violate this. |
| `OrganizationPayout.idempotencyKey SET NOT NULL`                           | Same as above for org payouts.                                                                                     |
| `program_assignment_no_active_overlap`                                     | No two ACTIVE `ProgramAssignment` rows for one program and membership overlap in time.                             |
| `subscription_plan_total_sessions_min` and `class_plan_total_sessions_min` | Every plan carries `totalSessions >= 1`.                                                                           |

## Decisions recorded for the reset

Two schema decisions are deferred to the reset day and must be settled in the same window: whether to unify the `uuid()` and `cuid()` id defaults across the booking aggregate (65 models use one, 59 the other), and whether the `#834` waitlist-to-slot unique constraint is added. Both are recorded in `docs/booking/00-architecture-decisions.md` under the A-series.
