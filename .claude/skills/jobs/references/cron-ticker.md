# Scheduled work and execution outcomes

## Current entrypoints

`lib/cron/cleanup-registry.ts` supplies the single implementation dispatch for
`/api/cleanup/[job]`. Its bearer check uses `CRON_SECRET`. The Netlify scheduled
adapter runs every five minutes and schedules every registered job (the generated inventory `docs/maintenance/04-cron-jobs-reference.md` lists them);
no Actions workflow schedules a registry job. Check executable target metadata
rather than assuming a registered job is scheduled.

Production operational work belongs on the active platform scheduler: captures,
refunds, payouts, billing, notification delivery, recording copies, retention and
compliance deadlines. GitHub Actions owns code verification, security scans,
configuration/schema drift checks, and explicitly invoked load/race tests.
Migration of an operational workflow requires bounded work and observed replacement
progress before deleting its old schedule. Never run shared-database load tests
on a production schedule.

## Shared schedule catalog

`lib/cron/schedule.ts` owns target names, cadence, offsets, calendar windows, row limits and request timeouts. `JOB_SCHEDULES` exposes their effective values and `scheduleFor(name)` supports lookup. Dispatchers and generated schedule metadata consume this catalog instead of copying maps or scraping the Netlify adapter. Freshness budgets are derived from this catalog (`maxSlotGapMinutes`, then `freshnessBudgetMinutes` in `lib/cron/operational-health.ts`); never write a literal budget. Recording transfer runs every 15 minutes through the catalog background destination, with 202 recorded in `accepted` rather than `ok`; its Actions step is removed. Cleanup and staff recovery queue the same adapter. Preserve the core's fail-closed 15-minute lease and one-copy limit. Its 60-minute freshness budget requires actual successful core completion. The catalog has no database, vendor client or environment reads. `npm run cron:reference` generates `docs/maintenance/04-cron-jobs-reference.md` from this catalog, executable registry AST properties and worker lease declarations. `npm run cron:reference:check` detects stale output; it does not verify deployed execution. Import schedule helpers directly from the catalog; the Netlify adapter contains platform dispatch and failure reporting.

Document retention (`purge-deleted-documents`) runs hourly at `:25`, with a 100-row request limit and 20-second HTTP timeout. Keep these values in the shared catalog when merging worker changes. The twelve-target bound (the busiest tick holds 11) and ledger yielding must match the current cadence/collision test.

## Lease, replay and failure

`withCronLock` uses a Postgres `SystemJobExecution` lease and its partial unique
index. Fail-closed jobs refuse unavailable acquisition, including failed Prisma
imports. Tests must supply a faithful delegate instead of relying on an unlocked
production fallback. Fail-open jobs may continue after a non-connection acquisition
error only when the operation tolerates replay.

`withCronLock` (`lib/cron/with-cron-lock.ts`) provides distributed mutual exclusion backed by a **Postgres lease on `SystemJobExecution`** (`status = 'RUNNING'` with a 15-minute default TTL and 35 minutes for payout/reconcile jobs), keeping Upstash Redis off the cron path. A financial job (`lib/cron/financial-jobs.ts`) additionally checks `assertNotInMaintenance()` and stands down (503) during a `DEGRADED` or `OFFLINE` maintenance phase; a non-financial job exits only on `OFFLINE`. Unreadable or missing phase state refuses guarded work with `MAINTENANCE_STATE_UNREADABLE` and HTTP 503 without a `phase` marker, so the ticker records an operational failure rather than a planned hold.

Completion uses `updateMany` with the execution id and `status: RUNNING`; a worker
whose execution was expired cannot overwrite that history. Only an owned,
successful finish on production refreshes `cron:heartbeat:last` (`touchRedisHeartbeat`
skips the write off production through `mayWriteProductionState`, so a preview
cannot mask a dead production ticker). This shared timestamp is a
liveness hint, not evidence that every capability completed. Nothing in GitHub Actions
writes this key any more; `.github/workflows/cron-heartbeat.yml` only watches the
Actions-scheduled workflows (`db-live-drift`, `security-audit`).

The typed outcome in `lib/cron/job-outcome.ts` classifies a result as success,
partial failure, failure or hold. A job's own `success`/`overallSuccess` boolean
is its verdict and outranks every counter. Only a result with no verdict is read
from its counters: a positive `failed` or `exhaustedReported`, a non-empty
`errors` array, or a completed audit report with `ok: false`. A resumable audit
report with summary status RUNNING is continuation, not failed reconciliation.
Remaining work by itself is never a failure. Execution history stores the
outcome: partial failures and failures are FAILED, intentional holds are
CANCELLED, and successes are COMPLETED. Results also record the Sentry deployment
environment, stamped when `withCronLock` opens the `RUNNING` row, so the job
console can filter every read by it. A preview or branch deploy never reaches
the job body: `cleanupRoute` refuses with 409 `JOB_RUN_PRODUCTION_ONLY` (see
`lib/cron/dispatch-refusal.ts`).

HTTP responses carry `X-Job-Outcome`. When a registry entry supplies a `status`
callback, that status is authoritative and the header follows it: 4xx or 5xx is
`failure`, and any 2xx is `success`, so the ticker's `PARTIAL_FAILURE_TARGETS`
list still decides whether a 207 counts as failed. Only an entry without a
callback gets `statusFor` and the inferred outcome. A lease-held 409 is an
attempted run, never fresh successful work.

`reconcile-ledgers` runs as an hourly `:55` bounded slice whose cursor persists on
its report. When the dispatched cohort (after idle skips) reaches `MAX_TARGETS_PER_TICK`, the ledger
yields before dispatch so statutory and settlement slots keep priority; later
admitted slices resume the report. It answers 200 with summary status RUNNING while work
remains and 207 once a completed audit has discrepancies; it is listed in
`PARTIAL_FAILURE_TARGETS`, so that 207 counts as failed.

No GitHub Actions workflow schedules a registry job: every registered job, including the former daily, weekly and hourly housekeeping batch, runs on the ticker (at most 12 targets per tick). The three fleet workflows `cron-daily.yml`, `cron-intra-day.yml` and `cron-weekly.yml` and their `tsx` wrappers are deleted; run a job by hand through the admin Run door or `POST /api/cleanup/<slug>` with the `CRON_SECRET` bearer. The weekly `consent-retention-sweeper` is count-only from the ticker, which never sends the delete flag. When a job is already running, `withCronLock` returns `409`, which the ticker records as `lockHeld` rather than `failed`. A 503 carrying an explicit `DEGRADED`/`OFFLINE` phase is a planned maintenance hold; an unreadable-state 503 remains `failed`.

A per-job lease does not serialize different jobs touching the same payment or
payout. Conditional state transitions, transactionally staged obligations and
vendor idempotency keys protect those boundaries. A lease renewal failure or
client timeout does not cancel a worker or roll back committed effects. Test
concurrent jobs, sequential replays, interrupted staging and ambiguous gateway
responses independently.

## Idle probes: the ticker skips targets with no work

Every `CLEANUP_JOB_BUILDERS` entry has a required `idle: IdleProbe` (`lib/cron/cleanup-registry.ts`): either `{ hasWork(db, now, outOfTime) }`, which lazily imports an exported `has...Work` function from the job's own core module, or `{ alwaysRun: "<one-line reason>" }`.

- **Flow.** `cron-tick.mts` computes `scheduledTargets(tickDate)` and calls `claimTickSlot(...)`, which POSTs `/api/health/jobs/tick?tickId=...&slot=...&due=<comma list>`. The route runs `probeTick(due, db, now, deadline)` (`lib/cron/idle-probe.ts`): the idle probes, then, only while the 2-second budget lasts and no probe failed, the seven oldest-pending-age gauges in one statement (`readPendingAges` in `lib/cron/pending-ages.ts`). It writes the claim row with `result.idle` (target names) and `result.idleCount` in the same insert, and answers `{claimed: true, idle, pendingAges?}`. A duplicate dispatch gets `{claimed: false}`. The ticker then dispatches `capToTick(scheduled minus idle)`, and its log line, body and Better Stack summary carry `skippedIdle` and the gauges as `oldestPendingAgeS`. Never add a ticker target for a gauge; add it to the one statement.
- **Why it exists.** Every dispatched target is a billable Netlify function invocation, and the legacy Pro bill steps up by $25 past 125,000 a site; see `docs/decisions/2026-11-01-ticker-skip-idle-targets.md` (Billing rationale).
- **Probe budget.** Probes run in one transaction with `SET LOCAL statement_timeout` of 750 ms (`IDLE_PROBE_STATEMENT_TIMEOUT_MS`), which holds through the transaction pooler. No statement starts after the 2 s budget (`IDLE_PROBE_BUDGET_MS`): a probe checks `outOfTime()` before every statement and answers "has work" once it is true, and the drift test counts those checks. Probing therefore ends by 2.75 s.
- **Claim timeout.** `TICK_CLAIM_TIMEOUT_MS` is 5 s: up to 2.75 s of probes plus the commit and claim insert leaves about 2 s for a cold start.
- **Fail open.** A probe that throws or whose statement Postgres cancels (the aborted transaction stops probing, so later targets are dispatched too), a probe cut short by the budget, an always-run job, a target the budget never reached, a probe module that cannot load (the route claims with `idle: []`), and an unreachable, non-2xx or unreadable claim reply all dispatch the target. Probe failures are one `idle-probe-failed` log line per tick, never Sentry.
- **Shared predicate.** A probe reuses the `...Where` builders the job's own claim query uses. `__tests__/maintenance/idle-probe-drift.test.ts` fails when a target has neither a probe nor a reason, a probe's `where` is more than a combination of builders, a builder the probe reads is not also read by the claim query, or the probe is not in the module the entry's `build` imports.
- **Run history.** A skipped target writes no `SystemJobExecution` row. `readIdleCompletions` (`lib/cron/idle-skips.ts`) reads the claim rows' `idle` arrays; `app/api/health/jobs/route.ts`, `app/api/health/jobs/streaks/route.ts`, `lib/backoffice/job-run-metrics.ts` (the "Idle skips" column) and `app/api/health/route.ts` treat a skip as a healthy finished run. Never add a reader of job freshness that ignores them.
- **Always-run is the exception.** Use it for vendor-state reconcilers, statutory exports whose window is the work, jobs that record a config skip on every run (`irp-uploader`), and jobs due so rarely that a probe saves little. State the reason in the entry.

## Runtime envelope and monitoring

Netlify scheduled functions have a 30-second limit; their HTTP targets execute as
separate functions. The ticker starts its budget before the fleet-owner read,
stops waiting for targets by 24 seconds, and reserves bounded telemetry waiting
through 27 seconds. Worker-side deadlines must stop new work independently; a
fetch abort only makes that target's outcome ambiguous.

The ticker returns HTTP `200` after reporting individual target failures on the
structured `{"event":"cron-tick",...}` line. Do not infer a scheduled retry contract
from the documented background-function retries; observe target completion independently.

Each tick reads `ops:active_cron_platform` once. Missing/unreadable state fails
open as required by AGENTS.md. The switch cannot stop already-running work or
prove exclusive delivery across hosts during a dependency failure.

Sentry check-in failures log a structured rejection/unavailability event. A
disabled Sentry monitor accepts no check-ins: verify the monitor is active and
that accepted check-ins and missed-run alerts actually arrive. Independent
absence monitoring must inspect completed capabilities and oldest outstanding
obligations, not the ticker's always-200 response or `/api/health` alone.
`/api/health/jobs` is that probe: one requirement per ticker target (every target
writes a run row; `jobNameFor` never returns `null`), `maxAge = gap + min(gap, 6 h) + 30 min` over the target's longest gap
between due slots, `paging` unless the target is in the housekeeping set
`WATCHED_TARGETS`, 503 when a paging job lapses. An external Better Stack monitor
polls it (owner step, runbook in `docs/maintenance/00-betterstack-setup.md`), and
Sentry's free uptime monitor is the second watcher. The probe also answers 503 from the
daily `ops-digest` row (`RELEASE_LAG_OVERDUE`, and `STANDING_CONFIG_SKIP` once Razorpay
keys are live). `checkJobCoverage` (`lib/cron/job-coverage.ts`) enforces target,
requirement and `MANUAL_ONLY` coverage inside `npm run build` (`npm run cron:coverage`).

## Explicit maintenance booking remediation

Selecting OFFLINE never cancels bookings. Maintenance-control lease results carry the HTTP command outcome; rejected or incomplete commands must not refresh successful execution evidence. ADMINs preview at most 20 whole bookings in an explicit interval up to 24 hours, then confirm a signed five-minute preview with a fresh session and an audit reason. `MaintenanceRemediation` and its items persist the confirmed request; `maintenance-booking-remediation` processes one item per fifteen-minute ticker slice. It belongs to `FINANCIAL_JOB_NAMES` and resumes only after maintenance ends. Cancellation stages refund-owed and notification obligations in its domain transaction; canonical relays deliver them. Item and request completion commit together, so a lost completion transaction replays safely. Preview, confirmation and execution also reject bookings beyond the conservative per-booking recipient/session/payment envelope; do not truncate obligations or claim large-roster remediation is supported.

Maintenance ETA is informational, and active Redis keys do not expire into an automatic reopening. ADMIN recovery must succeed before OFF is published. OFFLINE setup and recovery are serialized with the Postgres `maintenance-control` lease. `Meeting.maintenanceWindowId` preserves the exact operation scope even if later webhooks change the end reason. `maintenanceChannelFrozenAt` records acknowledged freezes; recovery includes all linked group meetings lacking `maintenanceChannelRecoveredAt`, including uncertain freeze outcomes, and advances only acknowledged unfreezes. Partial setup must be acknowledged through Retry Offline Setup before OFFLINE can end or downgrade. Partial drain or channel batches remain retryable and cannot complete setup/recovery.

## `?limit=` semantics

`parseLimitParam` (`lib/cron/cleanup-route.ts`) reads an optional `?limit=`. An
absent key means the route's own default, a value above 500 is clamped, and an
empty, non-numeric, zero, negative or fractional value answers
`400 INVALID_LIMIT` without running the job. Per-row routes use
`parseLimitParamOrDefault`, so every caller is bounded, not only the ticker. The
ticker sends `limit=50` unless `TARGET_LIMITS` overrides it, for example 10 for
`abandoned-payments`. A `null` override sends no limit to a route that takes
none, such as `reconcile-ledgers`.

## Job history and messaging retention

`prune-system-job-executions` is a ticker target (every 30 minutes at offset 25, window 20:00 to 23:30 UTC, `limit=500`); the daily Actions step and the CLI wrapper are deleted. Its registered HTTP core always runs bounded: maximum 500 rows per bounded page, and a 16-second start budget. Run history (no-op runs at 14 days, every other finished run at 180 days) is drained in raw 1,000-row batches until a short batch or the deadline; the secondary tables (`EmailEvent` 1 year (calendar), export jobs 1 year, anonymous cookie rows 13 months, meeting presence and attendance 3 years) are pages of the same job. No new retention gets its own ticker target: the busiest tick holds 11 of 12. `archive-webhook-events` keeps its weekly Sunday slot and drains the same way, in 2,000-row batches inside its 16-second budget and 20-second ticker timeout. `hasMore` indicates continuation; it is not a failure or a drained-backlog guarantee. Final mutations repeat eligibility so an admin-requeued message is preserved, and scrubbing keeps the delivery/legacy retention clocks unchanged. See [the execution and replay contract](../../../../docs/maintenance/messaging-retention.md).

## Adding a job

Never create 3-layer wrappers. A job has one implementation, registered in
`CLEANUP_JOB_BUILDERS` and wrapped in `withCronLock`. Do not add a parallel
`app/api/cleanup/<job>/route.ts`, `jobs/<domain>/<job>.ts` or
`scripts/<domain>/<job>.ts` wrapper.

1. Register one implementation, maintenance classification, active schedule and `idle` field: an exported `has...Work` probe that shares the claim query's `...Where` builders, or an `alwaysRun` reason.
2. Bound candidate reads, examined rows and runtime; preserve durable continuation.
3. Rotate unchanged/error polls so old unresolved rows cannot starve later work.
4. Stage delivery obligations atomically with the state claim using the supplied tx.
5. Test same-job overlap, cross-job races, sequential replay and missed schedules.
6. Update the generated job reference and operational recovery instructions.
7. Put a ticker job in `lib/cron/schedule.ts` (`TARGETS` with an offset or a `TARGET_WINDOWS` slot) so
   the cadence/collision tests preserve the twelve-target design bound (the busiest tick holds 11).
   Only the resumable ledger target yields when the due roster exceeds this bound;
   the dispatcher does not truncate other due work. The target gets a `paging`
   freshness budget automatically; add it to `WATCHED_TARGETS`
   (`lib/cron/operational-health.ts`) only if it is housekeeping. Its core must write
   a run row (take `withCronLock`, fail-open if read-only), because `npm run build`
   runs `checkJobCoverage` and fails on a target with no requirement.
8. If the job moves money or payouts, add its slug to `FINANCIAL_JOB_NAMES`
   (`lib/cron/financial-jobs.ts`). The maintenance gate then also stops it in
   `DEGRADED`, and the lock-registry test requires a fail-closed lock.

Some existing jobs intentionally take no row limit. That is not evidence that
an unbounded implementation fits a function envelope; inspect its actual work.
Calendar-window schedules also require explicit missed-window recovery.

## Compliance and retention slices

Consent, breach-deadline alerts and SystemEvent retention have registered bounded cores under lib/compliance and lib/observability. All three run on the ticker: `consent-retention-sweeper` weekly on Sunday at 00:25 UTC (count only, the ticker never sends the delete flag), `databreach-deadline-alerts` hourly at :15 (limit 50) and `prune-system-events` hourly at offset 10 in the 20:00 to 23:30 UTC window. Carry the original caller start time through maintenance, lease admission and repeated slices; a slow read must not admit a post-deadline write. Consent deletion remains DPDP_SWEEPER_DELETE-gated and uses the stored retention deadline; event retention remains 400 days, except that the newest event per `(correlationId, category)` of a `STATE_BEARING_EVENT_PREFIXES` prefix is kept. Breach mail/Novu obligations stage transactionally and resume the oldest unfinished hourly digest, including across hour rollover. Staged or held mail is not delivered-mail evidence. See docs/maintenance/compliance-retention-workers.md; never run a real retention or alerting job to test it against the shared database.

An invalid officer mailbox reports a configuration error while admin alerts still stage; the digest remains active until repaired. Do not complete or abandon an unfinished digest solely because it is old. Persistent staging failures require operator repair and an explicit progression/capacity gate before schedule cutover.

## Source-only verification

Generator changes must preserve output for unchanged executable inputs, including Markdown pipe escaping and unresolved lease labels. Run `cron:reference:check` and the inventory/catalog/ticker Jest suites through the repository configuration. These checks parse source and mock runtime dependencies; they require no live database or vendor calls. The canonical `node_modules` symlink supplies tools in worktrees, but generated Prisma types must match the worktree schema for checks that include workers. Use an isolated matching client for focused typechecks rather than replacing the shared generated client.

## Recording background packaging

The recording background entry is `netlify/functions/recording-transfer-background.mts`. Preserve the supported filename suffix as well as its background config when packaging with the CLI. A dependency-free CLI 26.0.2 branch probe completed after 75 seconds on this account; the temporary drafts were removed. This proves the isolated runtime path, while the application bundle and actual copy handoff still require verification. HTTP 202 is admission only: Netlify answers 202 to any call, so `runBackgroundWorker` (`lib/cron/background-worker.ts`) refuses off production, non-POST and a missing or wrong `CRON_SECRET` bearer before any work and logs `background-worker-refused` with the reason. A dispatch from a non-production deploy refuses with the typed 409 `BACKGROUND_DISPATCH_PRODUCTION_ONLY` and a `CANCELLED` refused run row. For unpublished alias logs, use the deployment branch and ID when function metadata omits its branch. See `docs/stream/recording-background-worker.md` and [Netlify background functions](https://docs.netlify.com/build/functions/background-functions/).

The native entry and shared cleanup factory need the explicit `next/server.js` package subpath. A network-denied compiled-module check catches the extensionless ESM import failure that CommonJS Jest loading misses. The worktree's default NFT archive can retain the external dependency symlink without its target; inspect dependency contents before treating a local archive as deployable. Keep the required canonical worktree dependency symlink.

## Stream organisation wind-down

`wind-down-deactivated-orgs` must not record either organisation completion marker
after a truncated/failed tagged-channel scan or channel failure in that pass. Its
retention marker uses the organisation's pre-wind-down error count, not a fresh
post-error baseline. Other organisations can finish independently while the run
still reports failure. The pager's offset ceiling and the unbounded related
surface/recording work remain capacity gates: a frozen messaging prefix can leave
the filter, but an unchanged prefix does not guarantee tail progress. Do not add a
ticker target or second automatic clock on the strength of these marker checks.
Shared Stream/R2 helpers receive the invocation reporter so row failures produce one final event with a bounded sample, highest severity and a retained billing classification. Other callers retain their existing reporting.
See `docs/stream/17-channel-lifecycle.md#organisation-wind-down-completion`.

## Deprecated & Superseded Approaches

Redis cron locks, production fallbacks for incomplete unit-test mocks, shared
heartbeats described as proof of complete fleet health, and the hand-kept
completion-SLO list (replaced by budgets derived from the schedule) are superseded. So is
`cron-heartbeat.yml` as a runtime watchdog: it ran on Actions and stopped with the jobs it
watched. A target whose healthy run left no run row (`jobNameFor` returning `null`) is gone too. Recovery
is not guaranteed by a parallel Actions workflow or by making every HTTP result 200. Keep the required Netlify standby; platform moves change adapters, not
transaction or replay guarantees.

## Sources

- [Netlify function limits](https://docs.netlify.com/build/functions/configuration/)
- [Sentry disabled monitor semantics](https://docs.sentry.io/api/crons/update-a-monitor/)
- [Vercel scheduling limitations](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
