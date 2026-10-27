# Job telemetry: the ticker, the lease, outcome truth and the health endpoints

Read this before changing what a scheduled job records or reports, the ticker's alerting, a health endpoint, or a Better Stack or Sentry monitor for the fleet. The facts per job are in `docs/maintenance/11-job-machinery-catalog.md`; the design is in `docs/observability/00-system-design.md`.

## The ticker

`netlify/functions/cron-tick.mts` runs every five minutes. It reads the fleet switch `ops:active_cron_platform` once (failing open), calls up to `MAX_TARGETS_PER_TICK` (10, in `lib/cron/schedule.ts`) due targets, and always answers 200 (`statusFor`), because Netlify re-invokes a scheduled function that answers 5xx. After the targets answer it does three independent, bounded things: `sendCheckIn()` posts the Sentry cron check-in for the monitor `cron-tick`, `emitTickSummary()` posts one Better Stack Telemetry line, and `alertFailedTargets()` reports failing targets. Keep the check-in dependency-free and bounded to two seconds, and never let any of the three make the tick throw. Do not add a second scheduler or a per-target Sentry monitor.

## The lease

`withCronLock()` in `lib/cron/with-cron-lock.ts` is the only cron mutual exclusion. The lease is one `RUNNING` row in `SystemJobExecution`, and the partial unique index `SystemJobExecution_running_jobName_key` in `prisma/sql/check-constraints.sql` arbitrates a race. The default time-to-live is 15 minutes and `LONG_JOB_TTL_MS` is 35; on Netlify every lease is capped at 90 seconds (`effectiveLeaseTtlMs`). A timer renews `startedAt` every third of the time-to-live, so that column is the last renewal, not the start. The next acquisition sweeps an expired `RUNNING` row to `FAILED`. Never add a Redis lock for a job; Redis keeps only the liveness timestamp `cron:heartbeat:last`.

## Outcome truth

The row's status comes from `jobOutcome()` in `lib/cron/job-outcome.ts` and nothing else, and a job's own `success` or `overallSuccess` boolean outranks every counter. `success: true` becomes `COMPLETED`, `success: false` becomes `FAILED`, `held` or `skipped` becomes `CANCELLED`, and counters classify only jobs that declare no verdict.

Known gap, until Phase 1 of the operations console (#2424): a row records `COMPLETED` for a partial run (a job that returns `success: true` while work remains or failed), for a run that looked at nothing, and for a configuration skip. A 409 from a live lease, a maintenance refusal and a bad bearer write no row. `result` stores only `outcome`, `environment` and an optional `checkpoint`; the `summarize()` output is logged and not persisted, and `itemsProcessed` and `errorCount` are never written. Do not build a new alert, probe or dashboard figure on "the row says `COMPLETED`" without saying so, and do not paper over the gap in the reader. Fix the recording instead.

## Streak escalation

A failing ticker target is a grouped Sentry warning (fingerprint `cron-tick` / `target-failed-once`, the target in the `target` tag, `class: platform` for Netlify's own error page) unless `isRepeatedFailure()` in `lib/cron/failure-streak.ts` says it has had no `COMPLETED` run for three of its own cadences (`STREAK_CADENCES`). Only then is it an error with the fingerprint `cron-tick` / `<target>`. A target is judged only on its first due tick of an hour (`isFirstDueTickOfHour`). The ticker reads each target's last `COMPLETED` start from `GET /api/health/jobs/streaks`, bounded to two seconds; unknown history, an unreachable endpoint and a job whose rows use another name all count as a one-off. Never count consecutive failing ticks in Redis.

## Better Stack

The ticker writes one summary line per tick when `ENABLE_BETTERSTACK_TELEMETRY` is `true` and `BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_INGEST_URL` are set. The function inlines this because `lib/observability/betterstack-telemetry.ts` imports `@sentry/nextjs`, which must stay out of the function bundle. Every `SystemEvent` insert is mirrored through `emitTelemetryLog` under the same flag, not awaited. Better Stack's uptime monitors poll `/api/health` and the bearer-protected `/api/health/jobs`. Setup and the alert drill are in `docs/maintenance/00-betterstack-setup.md`.

## The missed-run drill

Ticker liveness needs an enabled, unmuted `cron-tick` monitor and an enabled
notification alert connected to that exact monitor source. Verify the operator
recipient and production environment; a general high-priority issue rule is not
delivery proof. Read back both configurations, observe an accepted normal
check-in, then prove one controlled missed-check-in notification reaches the
operator and restore the normal configuration. Do not stop production jobs,
create another paid monitor, or disable another project's monitor for the drill.
Serialize the watchdog and `finally` cleanup through one restoration routine;
compare current state before writing and escalate unexpected drift. Without
verified conditional updates, arrange exclusive operator configuration access.
Preserve the required monitor identity fields and complete configuration in the
update payload, changing only the drill settings back to their saved values.
Record unavailable cron-update access as pending; alert-write access alone does
not enable the cron source. See the
[ticker missed-run runbook](../../../../docs/maintenance/00-betterstack-setup.md#ticker-missed-run-alerts).

Check project email digest timing as well as the alert route. Familiarise's
owner-approved minimum/maximum is 60/60 seconds; these are project-wide email
settings, separate from the cron alert's 30-minute repeat throttle. Sentry's
published digest path excludes resolved issues, so a brief incident can disappear
before an email is built. A successful test notification proves only that test
path. Verify receipt of the actual missed-check-in issue, wait out its repeat
interval before another drill, and keep the watchdog deadline inside the reserved
operator window. Treat `isUpserting` as runtime metadata; do not send it as a
restoration field or mistake its manual-edit transition for configuration drift.

## The health endpoints

`GET /api/health/jobs` is a bearer-protected read-only capability freshness probe.
It returns 503 for missing/overdue COMPLETED evidence or an unreadable history,
using `endedAt` and actual core job names. Required capabilities/SLOs live in
`lib/cron/operational-health.ts`; they are monitoring policy, not another schedule.
The shared heartbeat, a RUNNING attempt, an accepted background dispatch, or an
HTTP 200 from the public health route cannot replace this evidence. The recorder
and probe must use the same environment label; untagged or preview rows do not
establish production freshness. Verify tagged, truthful completion recording and
active required workers before enabling the monitor.

Configure the external monitor with CRON_SECRET in a protected Authorization
header, never a URL parameter. Calendar-only/config-gated jobs and business
backlog/vendor correctness need separate checks. Verify accepted telemetry and
actual alert delivery after deployment; tests establish probe behavior, not that
the vendor monitor is configured. Verify that worker maintenance refusals and
held outcomes cannot record COMPLETED evidence before activation. The probe keeps
reading during maintenance; suppress notifications externally without advancing
successful-work freshness.

`GET /api/health/jobs/streaks` is the third route. It is bearer-protected, read-only, uncached, and returns each requested target's last `COMPLETED` start in the past seven days plus whether any `COMPLETED` or `FAILED` row exists. It leaves out targets whose job writes no execution row.

## Retention

`SystemEvent` history retention has one bounded core in `lib/observability/system-event-retention.ts`. Preserve its existing 400-day cutoff, repeat eligibility during deletion and carry the caller deadline through lease admission and CLI slices. Its Actions owner is currently budget-blocked; a configured cadence does not prove execution. See [compliance and event-retention workers](../../../../docs/maintenance/compliance-retention-workers.md) for operator recovery and the scheduler cutover gate.

`SystemJobExecution` rows are kept 90 days by `prune-system-job-executions`; both pruning jobs are Actions-scheduled and currently budget-blocked.

## Adding or changing a job's reporting

- Report once per run through `createRunFailureReporter`, and pass `skipSentry: true` to `recordSystemError` or `recordSystemErrorSafe` when the same row also needs a durable `SystemEvent`.
- Send a missing-configuration skip through `reportConfigSkip` (`lib/cron/config-skip.ts`), not `reportSentryMessage` directly.
- Return a `success` verdict that matches reality. A run that did not finish its work must not return `success: true`.
- A job that must be seen cannot rely on a Sentry warning. It needs a durable row, or an alert on another channel.
