---
title: Cron, Sidecars and Reconciliation — Operational Reference
type: reference
band: maintenance
audience: sde2
status: live
last-reviewed: 2026-10-25
---

# Cron, Sidecars and Reconciliation — Operational Reference

This is the operational counterpart to [platform architecture](../start-here/04-platform-architecture.md). It covers dispatch, response codes, maintenance admission, leases, Postgres sidecars and reconciler boundaries.

The generated [configured cron jobs reference](./04-cron-jobs-reference.md) owns the inventory, executable entrypoints, declared leases, request bounds and configured schedules. Run `npm run cron:reference` after changing those sources and `npm run cron:reference:check` to detect stale output. Configuration does not establish deployed execution or completed business obligations. The generator traverses local imports for at most two levels, parses fleet steps from source and labels unresolved lease metadata explicitly. For generator refactors, verify unchanged output against the same registry/catalog inputs, then run the normal Jest configuration with mocked dependencies; do not import workers or connect to shared services to validate documentation.

## The dispatch path

Each key in `CLEANUP_JOB_BUILDERS` in `lib/cron/cleanup-registry.ts` lazily builds a cleanup handler for one canonical implementation. The inventory generator reads executable object keys through the TypeScript AST; marker comments are not its source of truth. The generated inventory reports the current roster of registered jobs, ticker targets and registered jobs outside the ticker, with a separate table for operational Actions steps lacking a registered builder. Regenerate it as worker migrations merge.

```text
netlify/functions/cron-tick.mts       five-minute authenticated dispatcher
   ↓
lib/cron/schedule.ts                 cadence, UTC windows and request bounds
   ↓
app/api/cleanup/[job]/route.ts        dynamic route; one registered builder
   ↓
lib/cron/cleanup-route.ts             bearer authentication and maintenance gate
   ↓
canonical core module               job-specific lease and bounded work

Actions-owned jobs → existing CLI → the same canonical core where registered
Admin run door    → explicit mapped canonical core (recording copies use async admission)
```

Recording transfer and the five daily Stream lifecycle targets use a separate execution path: the same catalog's background destination → authenticated narrow adapter → canonical transfer core. The ticker dispatches recording copies every 15 minutes and daily lifecycle slices in staggered windows, accepts only 202, and lists that receipt in `accepted`. Cleanup and staff run doors queue that adapter using a server-configured HTTPS origin. They do not claim a successful copy. Only an owned successful core execution refreshes completion health: 60 minutes for copy, 90 minutes for synchronous session recovery, and 28.5 hours for the daily lifecycle jobs. Every ticker target gets such a budget, derived from its schedule in `lib/cron/operational-health.ts` and printed on the "Freshness" line of the [generated reference](./04-cron-jobs-reference.md); `/api/health/jobs` answers 503 when a `paging` one lapses. See [Stream lifecycle operations](../stream/09-background-sync.md) for slice bounds and continuation. See the [recording worker runbook](../stream/recording-background-worker.md) for the 72-hour/three-attempt alarm, source classification and orphan-object recovery.

Do not add per-job cleanup route files, parallel implementations or new `GITHUB_OUTPUT` wrappers. Keep one automatic owner per job. A lease reduces overlap; it does not make sequential external effects safe to repeat.

### The maintenance gate

The cleanup route calls `assertNotInMaintenance(job)` from `lib/maintenance-cron.ts` before invoking the core. The phase is read from Upstash Redis with a short cache.

| Phase      | Effect on scheduled work                                               |
| ---------- | ---------------------------------------------------------------------- |
| `OFF`      | Maintenance does not hold work                                         |
| `DEGRADED` | Names in `FINANCIAL_JOB_NAMES` (`lib/cron/financial-jobs.ts`) are held |
| `OFFLINE`  | All jobs passing through this gate are held                            |

A hold raises `MaintenanceActiveError`; the route returns `503` with the phase, and the ticker records a hold. An absent or unreadable Redis phase refuses guarded work with an operational `503`; it is an availability failure, not evidence of planned maintenance. Neither a cached phase nor a later maintenance change cancels work already in flight.

## Response codes

| Code  | Condition                                                 | Operator action                         |
| ----- | --------------------------------------------------------- | --------------------------------------- |
| `202` | Background execution was admitted; completion is separate | Inspect the core execution and effects  |
| `200` | The handler reports success                               | Check completion/effect evidence too    |
| `207` | A job-specific needs-attention result                     | Inspect the result and target policy    |
| `400` | Malformed `limit` or `windowStart`                        | Fix the caller                          |
| `401` | No configured cron secret or bearer mismatch              | Fix authentication                      |
| `404` | Cleanup slug is absent from the registry                  | Fix the slug                            |
| `409` | `CronLockHeldError`: another invocation holds the lease   | Inspect persistent holds and progress   |
| `500` | Reported failure or an uncaught error                     | Investigate                             |
| `503` | Maintenance hold or a fail-closed lease acquisition error | Inspect the phase or lease availability |

`statusFor()` in `lib/cron/cleanup-route.ts` checks `success === false` before a needs-attention flag. The ticker treats overlap separately from a failed request and has target-specific handling for partial `207` outcomes. A `409`, maintenance hold, accepted request or generic `2xx` is not evidence that a business obligation completed.

## `?limit=` semantics

`parseLimitParam()` returns `undefined` when the parameter is absent, rejects a present non-positive or fractional value, and clamps a valid value to 500. `parseLimitParamOrDefault()` supplies a route default; each core still needs to enforce its own work bound. The generated inventory records configured request bounds, without asserting that every downstream operation obeys them. An omitted parameter must not be treated as authorization for an unbounded fallback.

### Payment, refund and top-up polling

Payment status, pending-refund and abandoned top-up polling order by nullable `lastReconciledAt` (never polled first), then ID. Every attempted lookup rotates the row, including unchanged provider state, transient failure and an attempted request that times out. The timestamp records an attempt, not verified provider progress; timeout errors remain run failures. Otherwise a slow first row can consume every run and starve later payments. The cursor write does not change `updatedAt`, so polling does not postpone business aging. A run interrupted before a row starts leaves that row ahead of attempted work on the next run. Payment lookups also require three seconds of remaining start budget; candidates skipped by that check remain unstamped.

Defaults are 50 payment candidates, 10 pending refunds and 25 abandoned top-ups. Payment and refund cohorts share their respective limit across candidate queries. Jobs stop starting rows at their execution deadline; an in-flight database transaction or provider operation must still finish or hit its own timeout. Refund polling reserves time for stranded successful cascades and failed-refund notices instead of letting pending work consume the entire invocation. Failed notices are capped at 10 by default and stage their notification and email in the same transaction that claims `failedNotifiedAt`; post-commit delivery failure remains recoverable by the existing outboxes. The invoice-accrual rollup counts every examined organization against its limit, including skipped organizations, and rotates it with `Organization.lastAccrualRollupAt` even after a skip or failure. Existing accrual, deactivation and window predicates still select the billable cohort.

The invoice selector reads at most `limit + 1` organization IDs with eligible accruals, avoiding an unbounded distinct-payment result. `remaining` is a lower bound from that peek, not a total backlog count. The bound is on organizations; a large organization’s invoice can still contain many accrual lines and needs its own capacity verification.

The invoice cursor updates the physical `organizations` relation, preserving business `updatedAt`. Cursor failures are counted without aborting later organizations or discarding invoices already committed. Rollup and cursor errors are reported once per run with their organization and phase. A failed-refund notice-stage error makes the enclosing reconciliation result unsuccessful while preserving the polling counters; the standalone notification entry point still rejects the failure.

Before deploying this code, an operator must apply the additive columns/indexes described by `prisma/schema.prisma` and `prisma/sql/reconciliation-cursors.sql`. The SQL artifact is for a controlled schema operation; this change does not run it automatically. No cursor backfill is necessary: existing NULL values receive priority.

## The Netlify ticker

`netlify/functions/cron-tick.mts` retains the `*/5 * * * *` schedule. Once per tick it reads `ops:active_cron_platform` through Upstash REST and skips dispatch when another platform is selected. An absent key, missing credentials, unreadable response or timeout permits Netlify dispatch. This fail-open preference is not an exactly-once mechanism. After the fleet switch the tick claims its slot through `POST /api/health/jobs/tick`, which also probes the due targets for work and skips the idle ones (5-second claim timeout, fail open); see [the job machinery catalog](11-job-machinery-catalog.md#11-the-path-from-a-tick-to-a-job-run). verify standby ownership and in-flight work during failback.

`lib/cron/schedule.ts` owns the target roster, cadence, offsets, UTC calendar windows, row limits and HTTP timeouts. `JOB_SCHEDULES` and `scheduleFor()` expose effective metadata; `scheduledTargets()`, `capToTick()`, `dueTargets()`, `windowStartFor()` and `targetRequest()` provide pure scheduling helpers. The adapter supplies authentication and uses the catalog’s background destination for background targets, including `transfer-recordings`; other targets use `/api/cleanup/<slug>`. Document retention runs hourly at `:25`, requesting at most 100 rows with a 20-second HTTP timeout. The resumable ledger target yields only when the dispatched roster (the scheduled targets minus those the idle probes skipped) would exceed the twelve-target bound (no tick reaches it today); statutory and settlement work keeps its slots.

For targets with a configured cadence, the slot check is:

```text
((minuteOfDay - offset) mod every + every) mod every < 5
```

Calendar windows are applied separately. The four-minute tolerance permits a slightly late tick to match its slot; it is not a replay mechanism for older missed windows. The current ten-target wave is a tested design bound, not a runtime dispatch cap. The 400-day cadence/collision test in `__tests__/maintenance/cron-tick-targets.test.ts` guards that roster.

The [scheduled money jobs guide](../finance/70-operations/01-scheduled-jobs.md) explains the money workflow boundaries. The generated inventory is the source for exact configured cadence and request limits. A ticker abort stops waiting for HTTP; it does not cancel a worker or provider effect.

### Ticker acknowledgment and monitoring

The ticker's `statusFor()` returns `200` even when targets fail, avoiding whole-fleet retry amplification through the scheduled adapter. Target failures are recorded in the structured tick result and reported through Sentry. The source declares a five-minute monitor, three-minute check-in margin and three-failure threshold; those settings are not proof that the monitor is enabled or accepted a check-in. A tick-level monitor also cannot establish freshness of every slower or calendar-gated target.

The canary is excluded from its own Sentry failure reporting. Verify accepted monitoring events and an independent alert path, then check each required capability's completed obligations. A fresh shared heartbeat establishes liveness only.

## The lock

`withCronLock()` in `lib/cron/with-cron-lock.ts` uses `SystemJobExecution` and the partial unique index in `prisma/sql/check-constraints.sql`:

```sql
CREATE UNIQUE INDEX "SystemJobExecution_running_jobName_key"
  ON "SystemJobExecution" ("jobName") WHERE "status" = 'RUNNING';
```

Acquisition sweeps expired rows and inserts a `RUNNING` execution; a concurrent unique violation maps to `CronLockHeldError`. The core declares its job name, fail mode and optional TTL. Use the generated inventory for source-derived declarations and unresolved metadata, rather than copying lock counts or per-job lease durations here.

The requested `closed` policy refuses work when acquisition is unavailable; `open` permits an unlocked path. Verify the active implementation and actual acquisition result before relying on either declaration. Connection/pool exhaustion is treated as closed. Renewals occur approximately every third of the lease TTL. Renewal failure and lease expiry do not cancel existing work, so row-level claims, compare-and-set transitions and vendor idempotency remain necessary. Lease TTL, HTTP abort and worker execution deadline are different bounds.

For export attempt ownership, exact artifact expiry and transactional expiry-to-refund obligations, see [worker recovery](12-worker-recovery.md).

`expire-onboarding-drafts` owns its open-mode Postgres lease in its canonical core, rather than inline in the registry. Use the actual core when checking lease policy and bounds. See [bounded housekeeping](./housekeeping-bounds.md) for all four cleanup families.

## The Actions-scheduled jobs

The generated inventory lists every registered job with its ticker schedule, entrypoint, lease and request bounds, and counts any registered job outside the ticker (none today). No Actions workflow schedules a registry job, so the generator reads no workflow file. Successful effects in the deployed environment still require separate verification.

Moving a job requires a bounded canonical core, restart-safe progress and a controlled deployed check that establishes cadence and backlog-drain capacity. Switch its automatic schedule as one reviewed handoff and preserve unmigrated workflow steps. Do not enable Actions as an additional automatic fallback for an already ticker-owned job.

## Sidecars

The three sidecar files under `prisma/sql/` (`check-constraints.sql`, `ledger-triggers.sql`, `payment-legs-triggers.sql`, listed in `SIDECAR_FILES` in `scripts/db/sidecar-objects.ts`) are hand-written and idempotent. Each statement is preceded by a `DROP ... IF EXISTS`, statements are separated by a literal `-- SPLIT` marker, and each runs in its own short transaction with `lock_timeout = '3s'` so an unobtainable lock fails fast instead of blocking the table. `reconciliation-cursors.sql` in the same folder is not a sidecar: it is a one-off operator rollout of columns and indexes the schema already declares, so neither `db:sidecars` nor the sidecar checks read it.

| File                        | `ADD CONSTRAINT` | Indexes | Triggers |
| --------------------------- | ---------------- | ------- | -------- |
| `check-constraints.sql`     | 82               | 28      | 3        |
| `ledger-triggers.sql`       | 0                | 0       | 3        |
| `payment-legs-triggers.sql` | 0                | 0       | 2        |

`scripts/db/sidecar-objects.ts` is the deduplicating parser and the authority on the exact count; it strips comments in a quote-aware and dollar-quote-aware way because PL/pgSQL bodies routinely contain comment markers.

### The load-bearing objects

| Object                                   | File                        | Enforces                                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occurrence_no_confirmed_overlap`        | `check-constraints.sql`     | `EXCLUDE USING gist` over `(consultantProfileId, tstzrange(startsAt, endsAt))`. Two confirmed live occurrences cannot overlap for one expert. Violation is SQLSTATE `23P01`, mapped to a typed `SCHEDULE_CONFLICT` 409 |
| `program_assignment_no_active_overlap`   | `check-constraints.sql`     | Two active programme assignments cannot overlap for one member                                                                                                                                                         |
| `ledger_txn_balanced`                    | `ledger-triggers.sql`       | Deferrable constraint trigger. `SUM(DEBIT) - SUM(CREDIT) = 0` per transaction, checked at `COMMIT`                                                                                                                     |
| `ledger_entry_immutable`                 | `ledger-triggers.sql`       | Append-only journal; refuses any `UPDATE` or `DELETE`                                                                                                                                                                  |
| `payment_legs_sum_to_amount`             | `payment-legs-triggers.sql` | Deferrable constraint trigger on `PaymentLeg`. Funding legs sum to `Payment.amount`, with `REFERRAL_CREDIT` and licence-only payments carved out                                                                       |
| `payment_amount_vs_legs`                 | `payment-legs-triggers.sql` | The same invariant from a direct `Payment.amount` write, which the leg-side trigger would not see                                                                                                                      |
| `ledger_entry_amount_positive`           | `check-constraints.sql`     | `amountPaise > 0`. Without it a negative entry could cancel a positive one and an unbalanced transaction would sum to zero and pass                                                                                    |
| `rate_card_bps_sum_is_whole`             | `check-constraints.sql`     | `platformBps + orgBps + consultantBps = 10000`                                                                                                                                                                         |
| `SystemJobExecution_running_jobName_key` | `check-constraints.sql`     | One `RUNNING` lease per job name                                                                                                                                                                                       |

The two carve-outs in `payment_legs_sum_to_amount` are both deliberate and both documented in the file header. `REFERRAL_CREDIT` is excluded because the credit is already netted out of `Payment.amount`, so counting the leg would demand it twice. A payment whose non-reversal legs are all zero-value licence legs skips the comparison entirely, because the licence is absorbed at contract time. A payment that mixes a licence leg with a card co-pay still enters the check.

### Three independent verification layers

| Layer        | Mechanism                                                                                | What it catches                                           |
| ------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Static       | `scripts/db/sidecar-objects.ts` parses the SQL                                           | An object accidentally commented out                      |
| Live catalog | `scripts/ci/check-db-sidecars.ts` queries `pg_constraint`, `pg_indexes` and `pg_trigger` | An object that exists in the file but not in the database |
| Round trip   | `ci.yaml` spins a throwaway `postgres:17`, runs `db push`, applies sidecars, asserts     | An object that cannot be recreated on a fresh database    |
| Daily drift  | `scripts/ci/check-db-live-drift.ts` runs `prisma migrate diff` read-only                 | The live database having drifted from the schema          |

`check-db-sidecars.ts` exits 0 when `DATABASE_URL` is absent, which is why the `db-live-drift` workflow asserts the variable is non-empty before invoking it — otherwise the guard would skip itself and report green forever.

### The `db push` trap

`prisma db push` plans to drop every sidecar-owned index, because they are deliberately absent from the Prisma schema. The correct sequence is `db:preflight` → `prisma db push` → `db:sidecars`, which is what `db:push:schema` does.

The trap is that `db:push:schema` **also exists as a standalone script** and completes without applying sidecars. A plain `prisma db push` therefore silently drops four money-related unique indexes. Run the full `db:push`.

`prisma/sql/known-drift.json` is an allowlist of expected differences between the live database and the schema, with expiry dates. It is currently empty.

## Reconcilers

Reconcilers are set-based, and there are two families plus a third category that must not exist.

**They are not all read-only.** The internal-cache family only reports. The vendor-boundary family _writes_: adopting the gateway's answer means updating the local row through a conditional update, and a payment or refund reconciler can therefore re-enter the pipeline it is reconciling — `reconcile-refunds` can move a refund to `FAILED` through a CAS, and `reconcile-payment-status` adopts a terminal payment state. What no reconciler does is _invent_ a state. Every write it makes copies an external authority across a compare-and-set.

**Vendor-boundary reconcilers** adopt the external system's answer when it disagrees with a local row.

| Job                             | Boundary                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reconcile-payment-status`      | Razorpay payment lookup; `unknown_id` becomes unresolvable, then retired past an age bound; orders closed in the last 72 hours are read again and a capture there is refunded |
| `reconcile-payout-status`       | RazorpayX payout status                                                                                                                                                       |
| `handle-stuck-payouts`          | Payouts stuck in `PROCESSING` beyond a window                                                                                                                                 |
| `reconcile-disputes`            | Gateway dispute status; writes a reconciliation note for manual review rather than moving status                                                                              |
| `reconcile-refunds`             | Gateway refund status for local `PENDING` refunds                                                                                                                             |
| `reconcile-orphaned-recordings` | Stream recordings for meetings that ended                                                                                                                                     |
| `reconcile-document-storage`    | Supabase Storage objects against database rows                                                                                                                                |
| `sweep-stuck-webhook-events`    | Inbound events left unprocessed or transiently failed                                                                                                                         |

**Internal-cache reconcilers** re-derive a cached value from the system that authored it. `reconcile-ledgers` is the largest, covering about seventeen derivation families and writing a reconciliation report. `BillingAccount.walletBalance` exists only as a cache for an atomic debit guard, and this sweep asserts it against the ledger.

**A reconciler must not re-verify a database invariant.** If a `CHECK` constraint, an exclusion index or a trigger already refuses the state at `COMMIT`, a sweep that re-checks it is waste. Write reconcilers only across a vendor boundary or against a cache.

### Failure handling in a sweep

A sweep that finds something it cannot safely repair records a finding and stops. It does not guess. The vocabulary in use is:

- **Dead-letter** — the attempt budget is exhausted; a human decides.
- **Needs-human** — the state is legitimate but unusual; the operator queue owns it.
- **Escrow** — the row is parked in a holding state with a stamp explaining why.
- **`AWAITING_HUMAN`** — an earnings or session marker that suppresses automatic release.

## Workflow inventory

Three workflows declare a `cron:` schedule. The three fleet workflows `cron-intra-day.yml`, `cron-daily.yml` and `cron-weekly.yml` are deleted; every registered job runs on the Netlify ticker.

| Workflow             | Schedules (UTC) | Purpose                                             |
| -------------------- | --------------- | --------------------------------------------------- |
| `cron-heartbeat.yml` | `04:40`         | Dead-man's switch for the other scheduled workflows |
| `db-live-drift.yml`  | `07:03`         | Read-only schema drift against the live database    |
| `security-audit.yml` | Mon `07:00`     | Supply-chain audit, including between PRs           |

The heartbeat watches only `db-live-drift` and `security-audit`, by reading the Actions API (`scripts/ci/check-cron-heartbeat.ts`); it alerts when one has stopped starting. It watches no runtime job, writes no Redis key and takes no lease, because it never touches the database. Runtime jobs are watched from outside Actions: `/api/health/jobs` (freshness budgets derived from `lib/cron/schedule.ts`, plus the digest verdicts), the ticker heartbeat and the daily `ops-digest`. The Redis key `cron:heartbeat:last` that `/api/health` exposes as `cron.stale` after 45 minutes is written only by `withCronLock` on a completed production run.

Two workflows that write to the shared production database — the load gate and the load smoke test — are `workflow_dispatch`-only and refuse to self-fire.

## Known document-versus-code drift

Recorded here so the next reader does not trust the prose over the source. The authoritative status of each item is the linked issue.

| Area                             | Documented                                                                                     | Actual                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone container build       | A conditional `output: "standalone"` for non-Netlify hosts                                     | No `output` key is set. The production Dockerfile is not standalone                                                                                                                                      |
| Image optimisation exclusion     | `sharp` excluded only on Netlify or Vercel, so container hosts keep in-process optimisation    | It is excluded unconditionally                                                                                                                                                                           |
| Client IP trust                  | Platform-scoped headers trusted only on their matching runtime                                 | Trusted unconditionally, so off-Netlify a caller can choose its own rate-limit key                                                                                                                       |
| Smoke-test auth header           | A dedicated cron header for the failback drain command                                         | The route accepts only `Authorization: Bearer`; the documented command returns 401                                                                                                                       |
| Overlap constraint name          | A constraint named `slot_no_confirmed_overlap` in the agent instructions                       | The object is `occurrence_no_confirmed_overlap`                                                                                                                                                          |
| Cron schedule staggering         | That CI enforces stagger minutes across the fleet                                              | `scripts/ci/check-workflow-hygiene.ts` checks the secrets manifest, not staggering. Stagger minutes are maintained by hand                                                                               |
| Dead job names in the alert list | `cascade-refund-earnings` and `release-pending-trust-earnings` listed in `MONEY_CRITICAL_JOBS` | Both jobs were folded into the `reconcile-refunds` and `release-earnings` cores. The names remain in `scripts/ci/notify-ops-failure.sh` where they can never match, so those two failures would not page |

The general rule these rows all illustrate: **verify a named object with a grep before building on it.** The repository has taught an agent a phantom constraint before, and agents trust these files as doctrine.

## Verifying a change

```bash
# The registry's own drift guards (these run in CI).
npx jest __tests__/maintenance/cron-lock-registry.test.ts
npx jest __tests__/maintenance/cleanup-job-scheduler-drift.test.ts

# Sidecars are present in the live catalog.
npx tsx -r dotenv/config scripts/ci/check-db-sidecars.ts

# Schema has not drifted from the live database (read-only).
npx tsx -r dotenv/config scripts/ci/check-db-live-drift.ts

# Docs cite paths that exist and resolve their links.
npx tsx -r dotenv/config scripts/ci/check-docs-drift.ts
```

`check-db-sidecars.ts` exits 0 when `DATABASE_URL` is unset. Check the variable is present rather than trusting a green result.

## Related issues

Issue 2157 (infrastructure and maintenance audit) and its sub-issues carry the ranked findings behind several rows above. Issue 2137 carries the booking productionization programme. Issue 2145 and issue 2156 cover the alert paths.

## Deprecated & Superseded Approaches

**Per-job API route files.** Replaced by the single dynamic route `app/api/cleanup/[job]/route.ts` built from `lib/cron/cleanup-route.ts`. If you find an `app/api/cleanup/<name>/route.ts`, it is residue.

**Redis-based cron locking.** Replaced by the `SystemJobExecution` lease in `withCronLock`. The `CronLockUnavailableError` message in `lib/cron/cron-lock-errors.ts` still says the lock "requires a real Redis lock"; that text is stale.

**An hourly GitHub Actions backstop for the booking sweeps.** The sub-hourly sweeps' duplicate Actions twins were removed once their handlers learned to loop within a time budget. Comments in the registry still refer to the old twin.

**A generic `OutboundWebhook` polling daemon.** Replaced by `OutboundWebhookDelivery` rows drained by a single registered job.

**A keep-warm Netlify function.** Deleted once disabling Next.js entry preloading removed the cold-start stall it existed to fight. A test asserts the file stays absent.

**A "superseded" banner on `04-cron-jobs-reference.md`.** A first attempt at these two pages marked the older job catalogue partially superseded rather than correcting it, on the reasoning that a 76 KB rewrite was not a small change. That was the wrong call: it left two documents claiming the same authority with a signpost between them, and the signpost is where drift grows. The catalogue was corrected in place instead — real entrypoints, real schedules, dead rows deleted — and the division of labour between the two pages is by subject, not by recency.
