# ADR: Retention may delete booking history older than three years

- **Status**: Accepted on 2026-11-03 by the owner (Kaustav).
- **Date**: 2026-11-03
- **Related**: [Retention windows for every log-like and audit table](2026-11-01-data-retention-windows.md), [Booking architecture decisions, ADR A12](../booking/00-architecture-decisions.md), issue #2557

## Context

The retention decision gives `BookingStatusHistory` a three-year window after a booking is terminal, and `prune-audit-logs` deletes the rows. The table also carries the trigger `booking_status_history_immutable`, which refused every `DELETE`. The database tier test for the prune caught the conflict: the job selected a row, the trigger raised `P0001`, and no history row was ever removed. The job would have failed on every run in production.

## Decision

The trigger function `assert_booking_status_history_immutable()` in `prisma/sql/check-constraints.sql` now lets a `DELETE` through only when the row's `createdAt` is more than three years old. An `UPDATE` of an audit column and a `DELETE` of any younger row are still refused. `prune-audit-logs` already selects only rows with `createdAt` before its three-year cutoff, so the trigger never refuses a row the job chose.

## Why the floor lives in Postgres

Per the repository rule that Postgres-enforced invariants are not re-checked in application code, the guarantee "no history younger than three years is ever deleted" is held by the trigger, so a future caller of `deleteMany` cannot erase recent audit rows by mistake. The job's own `WHERE` is the policy (terminal booking, old parents); the trigger is the floor.

## Owner action after merge

The sidecar file is applied by hand. After this merges, run the human-run sidecar step (`npm run db:sidecars`) so the live database carries the new function body. Until then the live trigger still refuses every delete and the prune keeps reporting an error for this table. The statement is `CREATE OR REPLACE FUNCTION`, so re-running it is safe.

## Deprecated & Superseded Approaches

The earlier trigger refused every `DELETE`, which made the retention prune impossible. Any other hand-rolled delete path or trigger bypass for this table is superseded by this rule.
