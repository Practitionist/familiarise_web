---
title: Cron, Sidecars and Reconciliation — Operational Reference
type: reference
band: maintenance
audience: sde2
status: live
last-reviewed: 2026-10-22
---

# Cron, Sidecars and Reconciliation — Operational Reference

This is the operational counterpart to [../start-here/04-platform-architecture.md](../start-here/04-platform-architecture.md), which explains _why_ the scheduling and enforcement machinery is shaped this way. This document covers the **mechanics**: the registry structure, the dispatch path, the response-code contract, lock modes and lease durations, phase staggering, the Postgres sidecars, and the reconciler taxonomy.

For the **job catalogue** — what each job is, what it mutates, and which workflow runs it — see [04-cron-jobs-reference.md](./04-cron-jobs-reference.md). The two pages deliberately do not repeat each other: this one describes the machinery every job passes through, that one describes the jobs themselves.

## The dispatch path

A scheduled job is defined exactly once, in `lib/cron/cleanup-registry.ts`. Each entry carries a `// @cleanup-twin <slug>` comment, which exists purely so tests can parse the registry statically. That comment is not read at runtime.

```
core module (one implementation, in scripts/ or lib/)
   ↑
lib/cron/cleanup-registry.ts          57 slugs, lazy imports
   ↑
app/api/cleanup/[job]/route.ts        the only cleanup route file
   ↑
lib/cron/cleanup-route.ts             CRON_SECRET · ?limit= · maintenance gate
   ↑
withCronLock()                        SystemJobExecution lease
   ↑
   ├── netlify/functions/cron-tick.mts          every 5 min, the TARGETS array
   └── .github/workflows/cron-*.yml             daily / weekly / statutory
```

Three things are banned by the repository's own rules, because in practice the copies drift:

- A per-job `app/api/cleanup/<name>/route.ts` file. There is one dynamic route.
- A parallel `jobs/<domain>/<job>.ts` wrapper when a `scripts/<domain>/<job>.ts` implementation already exists.
- A per-job `GITHUB_OUTPUT` wrapper script.

### The maintenance gate

Every dispatch calls `assertNotInMaintenance(job)` from `lib/maintenance-cron.ts` before the lock is taken. The phase lives in Upstash Redis and is read with a short success cache.

| Phase      | Effect on scheduled work                                                        |
| ---------- | ------------------------------------------------------------------------------- |
| `OFF`      | Everything runs                                                                 |
| `DEGRADED` | Only the names in `FINANCIAL_JOB_NAMES` (`lib/cron/financial-jobs.ts`) are held |
| `OFFLINE`  | Every job is held                                                               |

A held job raises `MaintenanceActiveError`, which the route turns into a `503` carrying the phase. The ticker recognises the phase in the body and records the target as _held_, not _failed_.

The maintenance read fails **open** on a Redis error. That is deliberate — the site stays up when Redis is unreachable — but it does mean a Redis outage silently disables the maintenance gate as well.

## Response codes

| Code  | Condition                                                                                                                                    | Operator action                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `200` | Clean run                                                                                                                                    | None                                                     |
| `207` | Succeeded, but `needsAttention` — a double-booking was detected, a row was escrowed, a cascade is still failing, a document has gone missing | **Look at it**                                           |
| `400` | Malformed `?limit=` (empty, non-numeric, zero, negative, fractional)                                                                         | Fix the caller                                           |
| `401` | Both `CRON_SECRET` and `VERCEL_CRON_SECRET` are absent, or the bearer token does not match the selected secret                               | Fix the secret                                           |
| `404` | Slug is not in the registry                                                                                                                  | Fix the slug                                             |
| `409` | `CronLockHeldError` — another copy holds the lease                                                                                           | None; expected under overlap                             |
| `500` | `result.success === false`, or an uncaught throw                                                                                             | Investigate                                              |
| `503` | Maintenance hold (body carries `phase`), or `CronLockUnavailableError` on a fail-closed job                                                  | Maintenance is active, or the lease table is unreachable |

Two subtleties worth knowing before you alert on status codes:

**`409` is not a failure.** It is the designed answer to overlap. The ticker records it as `lockHeld` and the tick still succeeds.

**`207` is not a success either.** It means the job ran and found something. An alert rule that treats any 2xx as healthy will silently swallow every needs-human finding.

`statusFor()` in `lib/cron/cleanup-route.ts` tests `success === false` **before** it tests for a flagged row. That ordering is deliberate and is documented in the function: the previous per-route ternaries asked the second question first, so a run that both failed and found a problem answered `207` — a 2xx that reads as healthy.

## `?limit=` semantics

`parseLimitParam()` in `lib/cron/cleanup-route.ts` reads an optional `?limit=`.

- An absent key returns `undefined`, and the job applies its own default.
- A present but malformed value throws `InvalidLimitError`, which the route turns into a `400`.
- A valid value is clamped to a maximum of 500. It is clamped, not rejected.

`parseLimitParamOrDefault()` exists so a per-row job can never be invoked unbounded by _any_ caller, not just the ticker. Several jobs also declare their own hard caps in the registry, independent of `?limit=` — for example the stale-slot release arm of `expire-stale-requests` releases at most 200 rows per run regardless of the query parameter.

### Payment, refund and top-up polling

Payment status, pending-refund and abandoned top-up polling order by nullable `lastReconciledAt` (never polled first), then ID. Every attempted lookup rotates the row, including unchanged provider state, transient failure and an attempted request that times out. The timestamp records an attempt, not verified provider progress; timeout errors remain run failures. Otherwise a slow first row can consume every run and starve later payments. The cursor write does not change `updatedAt`, so polling does not postpone business aging. A run interrupted before a row starts leaves that row ahead of attempted work on the next run. Payment lookups also require three seconds of remaining start budget; candidates skipped by that check remain unstamped.

Defaults are 50 payment candidates, 10 pending refunds and 25 abandoned top-ups. Payment and refund cohorts share their respective limit across candidate queries. Jobs stop starting rows at their execution deadline; an in-flight database transaction or provider operation must still finish or hit its own timeout. Refund polling reserves time for stranded successful cascades and failed-refund notices instead of letting pending work consume the entire invocation. Failed notices are capped at 10 by default and stage their notification and email in the same transaction that claims `failedNotifiedAt`; post-commit delivery failure remains recoverable by the existing outboxes. The invoice-accrual rollup counts every examined organization against its limit, including skipped organizations, and rotates it with `Organization.lastAccrualRollupAt` even after a skip or failure. Existing accrual, deactivation and window predicates still select the billable cohort.

The invoice selector reads at most `limit + 1` organization IDs with eligible accruals, avoiding an unbounded distinct-payment result. `remaining` is a lower bound from that peek, not a total backlog count. The bound is on organizations; a large organization’s invoice can still contain many accrual lines and needs its own capacity verification.

The invoice cursor updates the physical `organizations` relation, preserving business `updatedAt`. Cursor failures are counted without aborting later organizations or discarding invoices already committed. Rollup and cursor errors are reported once per run with their organization and phase. A failed-refund notice-stage error makes the enclosing reconciliation result unsuccessful while preserving the polling counters; the standalone notification entry point still rejects the failure.

Before deploying this code, an operator must apply the additive columns/indexes described by `prisma/schema.prisma` and `prisma/sql/reconciliation-cursors.sql`. The SQL artifact is for a controlled schema operation; this change does not run it automatically. No cursor backfill is necessary: existing NULL values receive priority.

## The Netlify ticker

`netlify/functions/cron-tick.mts` runs on a `*/5 * * * *` schedule. It posts to `/api/cleanup/<slug>?limit=N` with `Authorization: Bearer <CRON_SECRET>` and an `AbortController` timeout per target.

`dueTargets(now)` decides which targets are due:

```
((minuteOfDay - offset) mod every + every) mod every < 5
```

Two consequences follow from that formula. A tick that fires up to four minutes late still counts as its slot, and — critically — the per-target intervals and offsets spread work so that **no single five-minute tick fires more than `MAX_TARGETS_PER_TICK` targets**. Before phase staggering was introduced, nineteen targets fired simultaneously at the same four minutes past the hour, which saturated the single-connection Postgres pool that Netlify functions run with.

### The ticker targets

The targets, their cadence and phase, their `limit` and their timeouts are in `netlify/functions/cron-tick.mts` (`TARGETS`, `TARGET_EVERY_MINUTES`, `TARGET_OFFSET_MINUTES`, `TARGET_WINDOWS`, `TARGET_LIMITS`, `TARGET_TIMEOUTS_MS`). The money subset is rendered by schedule, with the DEGRADED hold, in [scheduled money jobs](../finance/70-operations/01-scheduled-jobs.md), generated from the same file. The stagger is pinned by `MAX_TARGETS_PER_TICK` and the cadence test (`__tests__/maintenance/cron-tick-targets.test.ts`).

### Why the ticker always answers 200

`statusFor()` in the ticker is hard-coded to return 200. Netlify re-invokes a scheduled function that answers 5xx up to three times, seconds apart, and every retry re-fires every due target. This was observed in production: a single failing target made the whole ticker run at triple rate for weeks.

Failure still reaches an operator through two channels: a structured `{"event":"cron-tick", ...}` log line, and one Sentry cron-monitor check-in per tick whose status follows whether any target failed. The monitor is configured with `checkin_margin: 3` and `failure_issue_threshold: 3`, which is calibrated for a five-minute tick — **it will not trip for a fifteen- or thirty-minute target**, because three consecutive misses fit inside that target's normal interval.

The canary target is excluded from Sentry reporting by `reportableToSentry()`: a monitor must not report its own failure through the system it is monitoring. It alerts by email instead.

## The lock

`withCronLock()` in `lib/cron/with-cron-lock.ts` inserts a `SystemJobExecution` row and relies on a partial unique index:

```sql
CREATE UNIQUE INDEX "SystemJobExecution_running_jobName_key"
  ON "SystemJobExecution" ("jobName") WHERE "status" = 'RUNNING';
```

Acquisition sweeps expired `RUNNING` rows, checks for a live one, then inserts. A unique-violation on the race between the check and the insert is collapsed into the same `CronLockHeldError`, so two replicas racing produce exactly one winner.

| Declared mode     | Policy when the lease table is unreachable                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `closed`          | Refuse execution and surface lease unavailability. Verify the actual acquisition failure path before activation. |
| `open`            | Permit repeat-safe work with a warning; no owned execution row is established.                                   |
| no core lease     | Inspect the dispatcher and caller; absence of a nearby lock is not proof of deliberate unlocked execution.       |
| interactive mutex | Payout cores also coordinate with interactive request paths using their existing domain mutexes.                 |

`expire-onboarding-drafts` now owns its open-mode Postgres lease in `scripts/cleanup/expire-onboarding-drafts.ts`, rather than inline in the registry. Use the actual core when checking lease policy and bounds; copied aggregate counts drift. See [bounded housekeeping](./housekeeping-bounds.md) for all four cleanup families.

Both closed and open modes flip to **closed** when the error looks like connection or pool exhaustion (`isDbConnectionOrPoolError`). The reasoning is that the pool outage which breaks the lease is precisely the window in which two runners would both believe they held it.

### Lease durations

| Constant               | Value      | Applies to                      |
| ---------------------- | ---------- | ------------------------------- |
| `DEFAULT_TTL_MS`       | 15 minutes | Everything else                 |
| `LONG_JOB_TTL_MS`      | 35 minutes | The payout and reconcile family |
| `SYNC_LOCK_TTL`        | 40 minutes | `stream-sync`                   |
| `TRANSFER_LOCK_TTL_MS` | 45 minutes | `transfer-recordings`           |

A running job renews its lease every `ttl / 3`. A failed renewal logs a warning and increments a metric; it does **not** abort the job. The consequence to plan for: a hard-killed invocation leaks its lease until it expires, and the ticker records the resulting `409` as _held_, not _failed_. There is no per-run time budget on most jobs beyond the ticker's own per-target abort timeout.

## The Actions-scheduled jobs

The remaining 29 registry slugs and the 13 jobs with no HTTP twin are catalogued, with their entrypoints, lock modes and what each mutates, in [04-cron-jobs-reference.md](./04-cron-jobs-reference.md). They are not repeated here.

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

| Job                             | Boundary                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `reconcile-payment-status`      | Razorpay payment lookup; `unknown_id` becomes unresolvable, then retired past an age bound       |
| `reconcile-payout-status`       | RazorpayX payout status                                                                          |
| `handle-stuck-payouts`          | Payouts stuck in `PROCESSING` beyond a window                                                    |
| `reconcile-disputes`            | Gateway dispute status; writes a reconciliation note for manual review rather than moving status |
| `reconcile-refunds`             | Gateway refund status for local `PENDING` refunds                                                |
| `reconcile-orphaned-recordings` | Stream recordings for meetings that ended                                                        |
| `reconcile-document-storage`    | Supabase Storage objects against database rows                                                   |
| `sweep-stuck-webhook-events`    | Inbound events left unprocessed or transiently failed                                            |

**Internal-cache reconcilers** re-derive a cached value from the system that authored it. `reconcile-ledgers` is the largest, covering about seventeen derivation families and writing a reconciliation report. `BillingAccount.walletBalance` exists only as a cache for an atomic debit guard, and this sweep asserts it against the ledger.

**A reconciler must not re-verify a database invariant.** If a `CHECK` constraint, an exclusion index or a trigger already refuses the state at `COMMIT`, a sweep that re-checks it is waste. Write reconcilers only across a vendor boundary or against a cache.

### Failure handling in a sweep

A sweep that finds something it cannot safely repair records a finding and stops. It does not guess. The vocabulary in use is:

- **Dead-letter** — the attempt budget is exhausted; a human decides.
- **Needs-human** — the state is legitimate but unusual; the operator queue owns it.
- **Escrow** — the row is parked in a holding state with a stamp explaining why.
- **`AWAITING_HUMAN`** — an earnings or session marker that suppresses automatic release.

## Workflow inventory

Six workflows declare a `cron:` schedule.

| Workflow             | Schedules (UTC)                                              | Purpose                                          |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `cron-intra-day.yml` | `:25,:55` hourly; `:17` hourly; `:52 */4`; `:33 */6`         | Recovery and sync jobs                           |
| `cron-daily.yml`     | `03:00`; `23:30`                                             | Daily maintenance and billing batches            |
| `cron-weekly.yml`    | Sun `00:25`; Mon `20:00`; Mon `21:00`; monthly and quarterly | Weekly, statutory and payout batch               |
| `cron-heartbeat.yml` | `04:40`                                                      | Dead-man's switch for the Actions fleet          |
| `db-live-drift.yml`  | `07:03`                                                      | Read-only schema drift against the live database |
| `security-audit.yml` | Mon `07:00`                                                  | Supply-chain audit, including between PRs        |

Every step in the three cron fleet workflows sets `continue-on-error: true`, and a final step fans out over every step outcome and calls `scripts/ci/notify-ops-failure.sh`. Each of those three declares a concurrency group with `cancel-in-progress: false`, so an overlapping run queues rather than cancelling one mid-flight. The two workflows that deliberately do the opposite are `ci.yaml` and `knip.yml`: both are pull-request triggered rather than scheduled, so superseding a stale run is the behaviour you want there.

The heartbeat is deliberately **not** in `withCronLock`: a watchdog must not depend on the resource it is monitoring. It is read-only, so a double run is harmless. It writes `cron:heartbeat:last` to Upstash, which `/api/health` exposes as `cron.stale` after 45 minutes so an external uptime pinger can watch it with no GitHub dependency.

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
