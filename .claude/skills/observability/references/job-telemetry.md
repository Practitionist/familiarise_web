# Job telemetry: the ticker, the lease, outcome truth and the health endpoints

Read this before changing what a scheduled job records or reports, the ticker's alerting, a health endpoint, or a Better Stack or Sentry monitor for the fleet. The facts per job are in `docs/maintenance/11-job-machinery-catalog.md`; the design is in `docs/observability/00-system-design.md`.

## The ticker

`netlify/functions/cron-tick.mts` runs every five minutes. It runs only on the production deploy (it reads `context.deploy.context` and skips any other, so Netlify's "Run now" on a preview does nothing). It reads the fleet switch `ops:active_cron_platform` once (failing open), claims its five-minute slot (`POST /api/health/jobs/tick` inserts a `cron-tick` `SystemJobExecution` row whose id is the tick id; a second dispatch of the slot answers `{duplicate: true}` and stands down; an unreachable claim fails open), calls up to `MAX_TARGETS_PER_TICK` (12, in `lib/cron/schedule.ts`) due targets, retries once a target whose request never reached the app (connection failure that was not the tick's own abort, or Netlify's own 500 page) while 5 seconds of the budget remain, and always answers 200 (`statusFor`), because Netlify re-invokes a scheduled function that answers 5xx. For targets answered 202 (background) it then reads `GET /api/health/jobs/streaks`, whose `lastFailedAt` lets it file a target whose newest finished run failed as failed ("last background run failed"). After that it does four independent, bounded things: `sendCheckIn()` posts the Sentry cron check-in for the monitor `cron-tick`, `emitTickSummary()` posts one Better Stack Telemetry line, `pingHeartbeat()` sends one GET to `BETTERSTACK_HEARTBEAT_URL` when it is set (2-second timeout; the "did not run" signal), and `alertFailedTargets()` reports failing targets. The `tickId` is deterministic per five-minute slot (`tickIdForSlot`, a custom (version 8) UUID from a SHA-256 of the slot) and is sent to every target as `x-tick-id`; it is in the console line and the Better Stack line, with `lockUnavailable` and `lockUnavailableCount` for fail-closed leases the database could not grant (the 503 body's code `CRON_LOCK_UNAVAILABLE`; no run row exists for those). Keep the check-in dependency-free and bounded to two seconds, and never let any of them make the tick throw. Do not add a second scheduler or a per-target Sentry monitor.

## The lease

`withCronLock()` in `lib/cron/with-cron-lock.ts` is the only cron mutual exclusion. The lease is one `RUNNING` row in `SystemJobExecution`, and the partial unique index `SystemJobExecution_running_jobName_key` in `prisma/sql/check-constraints.sql` arbitrates a race. The default time-to-live is 15 minutes and `LONG_JOB_TTL_MS` is 35; on Netlify every lease is capped at 90 seconds (`effectiveLeaseTtlMs`; `onNetlify()` in `lib/runtime-host.ts` reads the build-inlined `NETLIFY` or the runtime `SITE_ID`, so the cap also applies inside the background functions). A timer renews `startedAt` every third of the time-to-live, so that column is the last heartbeat; `createdAt` is the acquisition time and is never rewritten. Acquisition is one `findFirst` of the job's `RUNNING` row: live throws `CronLockHeldError` carrying `holderRunId`; stale is swept by CAS to `FAILED` with `result` `{outcome: "failed", reason: "lease-expired", environment, takenOverBy: <new run id>}` and `durationMs` from `createdAt`. The new row id goes into the run context and the Sentry tag `job_run_id`. Never add a Redis lock for a job; Redis keeps only the liveness timestamp `cron:heartbeat:last`.

## Outcome truth

`cleanupRoute()` (`lib/cron/cleanup-route.ts`) is the single writer of the final row. It derives the outcome from the HTTP status it answers (`routeOutcome` in `lib/cron/run-outcome.ts`: config skip is `skipped`, 400 or above is `failed`, a 207 from `needsAttention` with no failing item (`hasItemFailures`) is `attention`, any other 207 is `partial`, else `completed`) and `recordRouteRun()` (`lib/cron/run-record.ts`) rewrites each row whose own finish write landed, by CAS. The status and the response therefore agree; a job's own `success` boolean no longer decides the row. `withCronLock`'s own finish write is only the safety net for CLI and background callers.

| `result.outcome` | Status      | When                                                                                                                             |
| ---------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `completed`      | `COMPLETED` | 2xx other than 207                                                                                                               |
| `attention`      | `COMPLETED` | 207 from `needsAttention`, no item failing; success for streaks and paging, amber in the console                                 |
| `partial`        | `FAILED`    | any other 207; counts as a failure for streaks, as finished for freshness SLOs                                                   |
| `failed`         | `FAILED`    | 400 or above, a throw, or `lease-expired` takeover                                                                               |
| `held`           | `CANCELLED` | 409 live lease; `holderRunId` stored                                                                                             |
| `skipped`        | `CANCELLED` | config skip (`irp-uploader`, `heal-consumer-invoices`, `reconcile-gateway-settlements`) or a core that declined (`job-declined`) |
| `refused`        | `CANCELLED` | maintenance (`maintenance:<phase>`, `maintenance-state-unreadable`)                                                              |
| `paused`         | `CANCELLED` | reserved for the Phase 2 pause control; nothing writes it                                                                        |

The stored `result` also holds `reason`, `environment`, `checkpoint`, `summary` (the `summarize()` projection, 8,000 characters at most, else `{truncated, chars}`), `counters`, `tickId`, `httpStatus`, and `opsActionLogId` and `holderRunId` where they apply. `itemsProcessed` and `errorCount` come from a generic extractor over known summary keys and are null when none is present. A held, refused or skipped run that opened no row gets a zero-duration `CANCELLED` row. A bad bearer, a bad `?limit=` and a fail-closed lease the database could not grant write no row.

The run context (`lib/cron/run-context.ts`, `AsyncLocalStorage`) carries `runIds`, `triggeredBy` (`cron`, `github-actions`, `admin:<userId>`, `admin-drain:<userId>`), `tickId`, `opsActionLogId`, the counters and the rows whose finish write landed. Counters (`lib/cron/run-counters.ts`, a leaf module with no Node imports so client-reachable CAS helpers can call it): `casMiss` (the seven booking transition helpers, enterprise `finalize`, three payout claims, two refund claims, two payment-confirm claims), `serializationRetry` and `deadlockOrLockTimeout` (`reportSerializableRetry`), `poolTimeout` (P2024 in `cleanupRoute`'s catch), `leaseLost` (renewer), `leaseTakeover` (stale sweep). A new CAS helper that can lose a race calls `casMiss()` on a zero-row match. A `scheduleAfter` task spawned during a run inherits its context, but a counter incremented after the route wrote the row is dropped. `recordSystemEvent` adds `context.jobRunId` from the active run; never repurpose `correlationId` (wallet-freeze keys on it).

Do not build an alert or figure on the row status without reading `result.outcome`; rows from before the change have none.

## Streak escalation

A failing ticker target that fails once is a log line only (`cron-tick.target-failed-once`, with `class: platform` for Netlify's own error page) plus its entry in the tick summary. It reaches Sentry only when `isRepeatedFailure()` in `lib/cron/failure-streak.ts` says it has had no `COMPLETED` run for three of its own cadences (`STREAK_CADENCES`), as an error with the fingerprint `cron-tick` / `<target>`. A target is judged only on its first due tick of an hour (`isFirstDueTickOfHour`). The ticker reads each target's last `COMPLETED` start from `GET /api/health/jobs/streaks`, bounded to two seconds; unknown history, an unreachable endpoint and a job whose rows use another name all count as a one-off. Never count consecutive failing ticks in Redis.

## Better Stack

The ticker writes one summary line per tick (with `tickId`, `lockUnavailable` and `lockUnavailableCount`) when `ENABLE_BETTERSTACK_TELEMETRY` is `true` and `BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_INGEST_URL` are set. The function inlines this because `lib/observability/betterstack-telemetry.ts` imports `@sentry/nextjs`, which must stay out of the function bundle. Every `SystemEvent` insert is mirrored through `emitTelemetryLog` under the same flag, not awaited. Better Stack's uptime monitors poll `/api/health` and the bearer-protected `/api/health/jobs`. Setup and the alert drill are in `docs/maintenance/00-betterstack-setup.md`.

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
It returns 503 for missing/overdue finished-run evidence (a `COMPLETED` row, or a `FAILED` row with outcome `partial`) or an unreadable history,
using `endedAt` and actual core job names. It judges only `paging`-tier SLOs. Required capabilities/SLOs live in
`lib/cron/operational-health.ts`, each with `tier` `paging` or `watched` (16 money SLOs are `watched`: console red, no 503, promoted after 7 clean production days); they are monitoring policy, not another schedule.
The shared heartbeat, a RUNNING attempt, an accepted background dispatch, or an
HTTP 200 from the public health route cannot replace this evidence. The recorder
and probe must use the same environment label; untagged or preview rows do not
establish production freshness. Verify tagged, truthful completion recording and
active required workers before enabling the monitor.

Both job-history routes select `NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? SENTRY_ENVIRONMENT`
and return 503 if that label is empty or absent. The streak query filters
COMPLETED/FAILED rows by `result.environment`, so dev success cannot reset
production failure escalation. Unknown streak history retains one-off reporting.
This scopes monitoring evidence, not business rows or the shared Postgres lease.

Export and stale-request workers have forty-five-minute completion budgets.
Retained-order invoice recovery runs every four hours, at most five candidates
per slot, with a twelve-hour completion budget. These are execution-freshness
policies, not per-obligation recovery or queue-drain guarantees. See
[readiness and operating gates](../../../../docs/maintenance/13-readiness-and-operating-gates.md)
before making an infrastructure readiness claim.

Configure the external monitor with CRON_SECRET in a protected Authorization
header, never a URL parameter. Calendar-only/config-gated jobs and business
backlog/vendor correctness need separate checks. Verify accepted telemetry and
actual alert delivery after deployment; tests establish probe behavior, not that
the vendor monitor is configured. Verify that worker maintenance refusals and
held outcomes cannot record COMPLETED evidence before activation. The probe keeps
reading during maintenance; suppress notifications externally without advancing
successful-work freshness.

`GET /api/health/jobs/streaks` is the third route. It is bearer-protected, read-only, uncached, unchanged by the outcome vocabulary (a `partial` run is `FAILED`, so it counts as a failure), and returns each requested target's last `COMPLETED` start and last `FAILED` start (`lastFailedAt`) in the past seven days plus whether any `COMPLETED` or `FAILED` row exists. The ticker uses `lastFailedAt` to judge a background target (`lastRunFailed`: the newest finished run failed). It leaves out targets whose job writes no execution row.

For cron activation, use the current Sentry Monitors UI and read back active
state through the API; legacy Crons links can return 404. Check the account's
active-monitor allowance before a drill, and never retire another project's
monitor without its owner's authorization. Configuration, a disabled source or
a failed activation does not establish accepted check-ins or alert delivery.

## Retention

Both retention jobs are ticker targets in the 20:00 to 23:30 UTC band, 500 rows per slice: `prune-system-job-executions` (every 30 minutes, offset 25; 90-day run retention, stranded `RUNNING` rows closed after 6 hours without a heartbeat, messaging cleanup) and `prune-system-events` (hourly, offset 10; 400-day `SystemEvent` cutoff in `lib/observability/system-event-retention.ts`, which carries the caller deadline through lease admission). The daily Actions steps and `jobs/cleanup/prune-system-*.ts` wrappers are deleted. See [compliance and event-retention workers](../../../../docs/maintenance/compliance-retention-workers.md) for operator recovery.

## Manual runs

`POST /api/admin/system-jobs/run` has no job list: it resolves the slug through `CLEANUP_JOB_BUILDERS` (entries are `{meta: {title, description, category, manualRun}, build}`) and calls the handler's `invoke` in-process inside `withRunContext({triggeredBy: "admin:<id>", opsActionLogId})` with the ticker's own `?limit`, plus `windowStart` = `latestWindowStart()` for any `TARGET_WINDOWS` job (no due window: 409 `NO_DUE_WINDOW`, Run disabled). The ops-log row id is generated first so the run row links to it. `manualRun: "after"` (`process-payouts`, `create-payout-batch`) answers 202 via `scheduleAfter`; background jobs use the handler's `dispatchBackgroundJob`, which sends `x-run-trigger` (off production it refuses with a typed 409 `BACKGROUND_DISPATCH_PRODUCTION_ONLY`, a `CANCELLED` refused row, an ops-log `REFUSED` and no Sentry event; the panel shows a non-error toast for any stand-down); `cleanupRoute` adopts it only behind a valid bearer and in the `cron`/`admin:<id>`/`admin-drain:<id>` shape. The ops-log `after.status` follows `X-Run-Outcome` (completed/attention SUCCEEDED, partial PARTIAL, failed FAILED, stand-downs uppercased, dispatch ACCEPTED). Admin payout runs pass the admin as `createdBy` and `triggeredByUserId` (`adminActorId()`) on both the consultant and organisation rails; `isMakerCheckerDisbursementBlocked()` in `lib/payments/payouts/maker-checker.ts` is shared. The page's card list comes from `systemJobCards()` in `lib/cron/job-catalog.ts`; never add a second job list.

## Adding or changing a job's reporting

- Report once per run through `createRunFailureReporter`, and pass `skipSentry: true` to `recordSystemError` or `recordSystemErrorSafe` when the same row also needs a durable `SystemEvent`.
- Send a missing-configuration skip through `reportConfigSkip` (`lib/cron/config-skip.ts`), not `reportSentryMessage` directly.
- Return a `success` verdict that matches reality, and answer 207 (or a `status()` override) when work remains or failed: the stored outcome follows the HTTP status. Declare findings with `needsAttention`, not a `status()` that returns 207, so a findings-only run is stored as `attention`.
- A job that must be seen cannot rely on a Sentry warning. It needs a durable row, or an alert on another channel.
- Sentry fixes the system and the console fixes the customer. Do not expect a cron event to name a user: identity is stamped only on request-scoped events, and `createRunFailureReporter` keeps at most ten sample ids. Per-item truth belongs in domain columns now and in `SystemJobRunItem` later; link them through `job_run_id` and `SystemEvent.context.jobRunId` (see `references/entity-trace-and-console.md`).
