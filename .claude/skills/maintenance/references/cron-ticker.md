# Scheduled work and execution outcomes

## Current entrypoints

`lib/cron/cleanup-registry.ts` supplies the single implementation dispatch for
`/api/cleanup/[job]`. Its bearer check uses `CRON_SECRET`. The Netlify scheduled
adapter runs every five minutes; current daily/intra-day/weekly Actions workflows
still own the non-money jobs that have not yet migrated. An Actions workflow is
not a backstop for a ticker target. Check executable target metadata and workflow
steps rather than assuming a registered job is scheduled.

Production operational work belongs on the active platform scheduler: captures,
refunds, payouts, billing, notification delivery, recording copies, retention and
compliance deadlines. GitHub Actions owns code verification, security scans,
configuration/schema drift checks, and explicitly invoked load/race tests.
Migration of an operational workflow requires bounded work and observed replacement
progress before deleting its old schedule. Never run shared-database load tests
on a production schedule.

## Lease, replay and failure

`withCronLock` uses a Postgres `SystemJobExecution` lease and its partial unique
index. Fail-closed jobs refuse unavailable acquisition, including failed Prisma
imports. Tests must supply a faithful delegate instead of relying on an unlocked
production fallback. Fail-open jobs may continue after a non-connection acquisition
error only when the operation tolerates replay.

Completion uses `updateMany` with the execution id and `status: RUNNING`; a worker
whose execution was expired cannot overwrite that history. Only an owned,
successful finish refreshes `cron:heartbeat:last`. This shared timestamp is a
liveness hint, not evidence that every capability completed.

The typed outcome in `lib/cron/job-outcome.ts` classifies a result as success,
partial failure, failure or hold. A job's own `success`/`overallSuccess` boolean
is its verdict and outranks every counter. Only a result with no verdict is read
from its counters: a positive `failed` or `exhaustedReported`, a non-empty
`errors` array, or a completed audit report with `ok: false`. A resumable audit
report with summary status RUNNING is continuation, not failed reconciliation.
Remaining work by itself is never a failure. Execution history stores the
outcome: partial failures and failures are FAILED, intentional holds are
CANCELLED, and successes are COMPLETED. Results also record the Sentry deployment
environment, so shared-database preview runs can be told apart.

HTTP responses carry `X-Job-Outcome`. When a registry entry supplies a `status`
callback, that status is authoritative and the header follows it: 4xx or 5xx is
`failure`, and any 2xx is `success`, so the ticker's `PARTIAL_FAILURE_TARGETS`
list still decides whether a 207 counts as failed. Only an entry without a
callback gets `statusFor` and the inferred outcome. A lease-held 409 is an
attempted run, never fresh successful work.

A per-job lease does not serialize different jobs touching the same payment or
payout. Conditional state transitions, transactionally staged obligations and
vendor idempotency keys protect those boundaries. A lease renewal failure or
client timeout does not cancel a worker or roll back committed effects. Test
concurrent jobs, sequential replays, interrupted staging and ambiguous gateway
responses independently.

## Runtime envelope and monitoring

Netlify scheduled functions have a 30-second limit; their HTTP targets execute as
separate functions. The ticker starts its budget before the fleet-owner read,
stops waiting for targets by 24 seconds, and reserves bounded telemetry waiting
through 27 seconds. Worker-side deadlines must stop new work independently; a
fetch abort only makes that target's outcome ambiguous.

Each tick reads `ops:active_cron_platform` once. Missing/unreadable state fails
open as required by AGENTS.md. The switch cannot stop already-running work or
prove exclusive delivery across hosts during a dependency failure.

Sentry check-in failures log a structured rejection/unavailability event. A
disabled Sentry monitor accepts no check-ins: verify the monitor is active and
that accepted check-ins and missed-run alerts actually arrive. Independent
absence monitoring must inspect completed capabilities and oldest outstanding
obligations, not the ticker's always-200 response or `/api/health` alone.

## `?limit=` semantics

`parseLimitParam` (`lib/cron/cleanup-route.ts`) reads an optional `?limit=`. An
absent key means the route's own default, a value above 500 is clamped, and an
empty, non-numeric, zero, negative or fractional value answers
`400 INVALID_LIMIT` without running the job. Per-row routes use
`parseLimitParamOrDefault`, so every caller is bounded, not only the ticker. The
ticker sends `limit=50` unless `TARGET_LIMITS` overrides it, for example 10 for
`abandoned-payments`. A `null` override sends no limit to a route that takes
none, such as `reconcile-ledgers`.

## Adding a job

Never create 3-layer wrappers. A job has one implementation, registered in
`CLEANUP_JOB_BUILDERS` and wrapped in `withCronLock`. Do not add a parallel
`app/api/cleanup/<job>/route.ts`, `jobs/<domain>/<job>.ts` or
`scripts/<domain>/<job>.ts` wrapper.

1. Register one implementation, maintenance classification, and active schedule.
2. Bound candidate reads, examined rows and runtime; preserve durable continuation.
3. Rotate unchanged/error polls so old unresolved rows cannot starve later work.
4. Stage delivery obligations atomically with the state claim using the supplied tx.
5. Test same-job overlap, cross-job races, sequential replay and missed schedules.
6. Update the generated job reference and operational recovery instructions.
7. Put a ticker job in `TARGETS` with an offset or a `TARGET_WINDOWS` slot so
   that no tick fires more than `MAX_TARGETS_PER_TICK` (9) targets; the cadence
   test pins it.
8. If the job moves money or payouts, add its slug to `FINANCIAL_JOB_NAMES`
   (`lib/cron/financial-jobs.ts`). The maintenance gate then also stops it in
   `DEGRADED`, and the lock-registry test requires a fail-closed lock.

Some existing jobs intentionally take no row limit. That is not evidence that
an unbounded implementation fits a function envelope; inspect its actual work.
Calendar-window schedules also require explicit missed-window recovery.

## Deprecated & Superseded Approaches

Redis cron locks, production fallbacks for incomplete unit-test mocks, and shared
heartbeats described as proof of complete fleet health are superseded. Recovery
is not guaranteed by a parallel Actions workflow or by making every HTTP result 200. Keep the required Netlify standby; platform moves change adapters, not
transaction or replay guarantees.

## Stream organisation wind-down

`wind-down-deactivated-orgs` must not record either organisation completion marker
after a truncated/failed tagged-channel scan or channel failure in that pass. Its
retention marker uses the organisation's pre-wind-down error count, not a fresh
post-error baseline. Other organisations can finish independently while the run
still reports failure. The pager's offset ceiling and the unbounded related
surface/recording work remain capacity gates: a frozen messaging prefix can leave
the filter, but an unchanged prefix does not guarantee tail progress. Do not add a
ticker target or second automatic clock on the strength of these marker checks.
See `docs/stream/17-channel-lifecycle.md#organisation-wind-down-completion`.

## Sources

- [Netlify function limits](https://docs.netlify.com/build/functions/configuration/)
- [Sentry disabled monitor semantics](https://docs.sentry.io/api/crons/update-a-monitor/)
- [Vercel scheduling limitations](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
