---
title: Observability system design
type: explanation
band: observability
audience: sde2
status: live
last-reviewed: 2026-10-31
---

# Observability system design

This page explains how the platform finds out that something went wrong, what it keeps so that a person can work out why, and which tool answers which question. It is the high-level design for the whole subsystem. The detail lives in the Sentry set (`sentry/01` to `sentry/08`), in the [job machinery catalog](../maintenance/11-job-machinery-catalog.md) and in the [2026-10-26 decisions record](../decisions/2026-10-26-launch-sweep-observability-and-money-holds.md). Behaviour that is not on `dev` yet is labelled **(arrives with #N)**, **(pending)** or **(planned)**. The run record, run id, tick id, outcome vocabulary, counters and SLO tiers below are Phase 1 of the operations console.

## 1. Three questions, three layers

An operator asks one of three questions, and each is answered by a different tool. Using the wrong tool is the usual mistake, because each tool is blind to the other two questions.

| Question                                      | Layer                                                  | Why the other layers cannot answer it                                                                       |
| --------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| What failed, in which code, for which user?   | Sentry                                                 | Needs an exception or a deliberate report. A refund sitting in `PENDING` for a day throws nothing.          |
| What did not run?                             | Better Stack, plus the Sentry cron monitor `cron-tick` | A job that never starts produces no error, so Sentry stays silent.                                          |
| What happened to this payment or this booking | The back-office Entity trace and job run metrics       | Sentry holds at most a capped sample per run, and Better Stack only knows the ticker and the health probes. |

A worked example shows the split. On Monday 26 October 2026 at 10:00 IST (04:30 UTC) Hannah Anderson cancels Priya Anderson's one-hour consultation. Priya paid ₹1,180 (118,000 paise: ₹1,000 plus 18 % GST), and her refund does not arrive. If the refund sweep threw, Sentry holds the error. If the refund sweep stopped being scheduled, Better Stack's probe of `/api/health/jobs` turns red within the sweep's 45-minute completion budget. If neither happened and the gateway simply never confirmed the refund, only the payment's own rows can say so, and the Entity trace is the page that reads them together.

## 2. The picture

```mermaid
flowchart LR
    subgraph Sources["Signal sources"]
        APP["Server, edge and client code<br/>(Sentry SDK)"]
        CANARY["Ingest canary<br/>(daily stats_v2 read)"]
        TICK["cron-tick ticker<br/>(Netlify, every 5 min)"]
        JOBS["Job cores<br/>(withCronLock)"]
        DOMAIN["Domain tables<br/>Payment, Refund, ledger, booking history"]
    end

    subgraph Stores["Stores and sinks"]
        SENTRY["Sentry<br/>errors, traces, logs"]
        MONITOR["Sentry cron monitor<br/>cron-tick"]
        BS["Better Stack<br/>uptime monitors and tick summary log"]
        SJE[("SystemJobExecution")]
        SE[("SystemEvent")]
        MAIL["Operator email<br/>(Resend)"]
    end

    subgraph Probes["Read endpoints"]
        H1["/api/health"]
        H2["/api/health/jobs"]
        H3["/api/health/jobs/streaks"]
    end

    subgraph Humans["Who looks"]
        ENG["Engineer on call"]
        OPS["Admin and staff<br/>back-office"]
    end

    APP -->|errors, 10 percent traces, logs| SENTRY
    SENTRY -->|stats_v2 outcomes| CANARY
    CANARY -->|unhealthy verdict| MAIL
    CANARY -->|unhealthy verdict, error log line| BS
    TICK -->|check-in each tick| MONITOR
    TICK -->|one summary line per tick| BS
    TICK -->|heartbeat ping per tick| BS
    TICK -->|repeated target failure only| SENTRY
    TICK -->|asks for last COMPLETED| H3
    TICK -->|POST /api/cleanup/job| JOBS
    JOBS -->|lease and finish row| SJE
    JOBS -->|durable findings| SE
    JOBS -->|once per run| SENTRY
    SJE --> H2
    SJE --> H3
    BS -->|polls| H1
    BS -->|polls with bearer| H2
    SENTRY --> ENG
    MONITOR --> ENG
    BS --> ENG
    MAIL --> ENG
    SJE --> OPS
    SE --> OPS
    DOMAIN -->|read only, one query per source| OPS
```

The Entity trace and the Run metrics card are the only readers of the domain tables in this picture. Everything drawn here is on `dev`.

## 3. Signal sources and sinks

| Signal                    | Produced by                                                                                                                               | Lands in                                                                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Errors and warnings       | `initSentry()` in `sentry.shared.config.ts`, called by `sentry.server.config.ts`, `sentry.edge.config.ts` and `instrumentation-client.ts` | Sentry issues                                                                                       | Application code reports through `reportSentryError` and `reportSentryMessage` in `lib/observability/report.ts`, which apply the `subsystem`, `op` and `expected` tags.                                                                                                                                                                                                                                                                                  |
| Traces                    | The same SDK, through `tracesSampler`                                                                                                     | Sentry performance                                                                                  | Production keeps about 10 % of ordinary requests, 50 % of `/api/webhooks/`, `/api/payments/` and `/api/checkout`, 2 % of `/api/cleanup/`, and none of `/api/health`.                                                                                                                                                                                                                                                                                     |
| Sentry Logs               | `Sentry.logger.*`, enabled by `enableLogs: true`                                                                                          | Sentry Logs                                                                                         | `beforeSendLog` drops `debug` and `trace` in production and scrubs the rest (`scrubSentryLog` in `lib/observability/sentry-scrubber.ts`). Logs do not draw on the error quota.                                                                                                                                                                                                                                                                           |
| Ingest canary             | `sentry-ingest-canary` target, `lib/observability/ingest-canary.ts`                                                                       | Nothing in Sentry. When unhealthy, an email through Resend and an error-level Better Stack log line | Runs once a day at 00:50 UTC. It reads the last day's error outcomes from Sentry's `stats_v2` API with `SENTRY_STATS_TOKEN` and alerts on quota or rate-limit rejections, or when the read fails. Without the token the run is a config skip. See `sentry/06-ingest-canary.md`.                                                                                                                                                                          |
| Ticker check-in           | `sendCheckIn()` in `netlify/functions/cron-tick.mts`                                                                                      | The Sentry cron monitor `cron-tick`                                                                 | Five-minute schedule, three-minute margin, failure threshold 3, recovery threshold 1. A missed check-in raises an issue even though no code ran.                                                                                                                                                                                                                                                                                                         |
| Tick heartbeat            | `pingHeartbeat()` in the same file                                                                                                        | A Better Stack heartbeat monitor                                                                    | One GET per completed tick when `BETTERSTACK_HEARTBEAT_URL` is set (two-second timeout, never fails the tick). A missing ping is the "did not run" signal that no row can give.                                                                                                                                                                                                                                                                          |
| Per-tick summary          | `emitTickSummary()` in the same file                                                                                                      | Better Stack Telemetry, one JSON line per tick                                                      | Only when `ENABLE_BETTERSTACK_TELEMETRY` is `true` and the source token and ingest URL are set. Carries the tick id, the ok, accepted, lock-held and failed target lists, and the targets whose fail-closed lease the database could not grant (`lockUnavailable`, `lockUnavailableCount`). The same tick id is sent to every target as `x-tick-id` and stored on each run row.                                                                          |
| Uptime and absence probes | Better Stack HTTP monitors                                                                                                                | Better Stack incidents and email                                                                    | `/api/health` is the public liveness and dependency check. `/api/health/jobs` is the bearer-protected completion-freshness check. Whether each monitor exists is a deployment gate (`docs/maintenance/00-betterstack-setup.md`).                                                                                                                                                                                                                         |
| Fleet heartbeat           | `touchRedisHeartbeat()` in `lib/cron/with-cron-lock.ts`                                                                                   | The Redis key `cron:heartbeat:last`                                                                 | A liveness hint shown by `/api/health` (`cron.stale` after 45 minutes). It is not a lock and never proves a particular job ran.                                                                                                                                                                                                                                                                                                                          |
| Job run record            | `withCronLock()`                                                                                                                          | `SystemJobExecution`                                                                                | One row per lease or stand-down: status, acquisition time (`createdAt`), last heartbeat (`startedAt`), error text, `triggeredBy`, and a `result` with the outcome (section 7), `environment`, `summary`, `counters`, `tickId`, `httpStatus` and optional `checkpoint`, `holderRunId`, `opsActionLogId`. Written by `withCronLock()` and finished by `cleanupRoute()` (`recordRouteRun`). Kept 90 days by `prune-system-job-executions`, a ticker target. |
| Durable findings          | `recordSystemEvent` and `recordSystemError` in `lib/enterprise/system-events.ts`                                                          | `SystemEvent`                                                                                       | The row is the truth and Sentry is the pager. `context.jobRunId` names the job run row when the event was raised inside a run; `correlationId` stays the caller's own entity key. Kept 400 days (`lib/observability/system-event-retention.ts`), pruned by the ticker target `prune-system-events`. Each insert is also mirrored to Better Stack Telemetry when the flag is on.                                                                          |
| Entity history            | Money, booking, support and audit tables written by the domain code                                                                       | The Entity trace                                                                                    | Read only. One bounded query per source, in sequence, because `PG_POOL_MAX=1` on Netlify.                                                                                                                                                                                                                                                                                                                                                                |

### 3.1 The health endpoints

Three routes expose job health, and they have different callers.

- `/api/health` (`app/api/health/route.ts`) is public. It reports `status` as `healthy` or `degraded`, together with the database, Redis, maintenance phase, Stream status and the cron heartbeat age.
- `/api/health/jobs` (`app/api/health/jobs/route.ts`) requires `Authorization: Bearer <CRON_SECRET>`. It reads the newest finished `endedAt` (a `COMPLETED` row, or a `FAILED` row with outcome `partial`) for each `paging`-tier capability in `OPERATIONAL_COMPLETION_REQUIREMENTS` (`lib/cron/operational-health.ts`) and answers 503 when any is overdue, when the environment label is unset, or when history cannot be read. Only rows whose `result.environment` matches the serving deployment count, so a preview run cannot mask a stopped production job. The body also lists `configSkips`: each job whose run in the last 26 hours was a configuration skip, with its reason. They never change `healthy`.
- `/api/health/jobs/streaks` (`app/api/health/jobs/streaks/route.ts`) is bearer-protected and read-only. The ticker calls it once per tick, for failing targets only, and it returns each target's last `COMPLETED` start within seven days. It exists for the escalation rule in section 6. It still reads `COMPLETED` starts only, so a `partial` run counts as a failure there.

The SLO list has two tiers. The 20 original entries are `paging`. Sixteen money SLOs (payout processing and recovery, disputes, ledgers, gateway settlements, platform incidents, cancelled sessions, referral vesting and expiry, consumer-invoice healing, subscription invoices, dunning, e-invoicing, payout batches, invoice accruals) are `watched`: the console shows them red, but they cannot make `/api/health/jobs` answer 503. A watched SLO is promoted to `paging` after 7 clean production days.

## 4. The layers compared

| Layer                               | What it stores                                                                    | Retention                                                                               | Quota or cost today                                                                                             | Who sees it                                                                                                                          | How it alerts                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Sentry                              | Error and warning events, sampled traces, Sentry Logs, the cron monitor           | 30-day lookback on the free Developer plan (checked on sentry.io/pricing on 2026-10-27) | Developer plan: 5,000 errors, 5M spans, 5 GB of logs and one cron monitor a month. Errors are the scarce one.   | Engineers in the Sentry project. Admin and staff see recent issues for one user on User 360, which needs identity stamping to be on. | A high-priority alert workflow filtered to `production`, and the `cron-tick` missed-check-in.            |
| Better Stack                        | Uptime checks of `/api/health` and `/api/health/jobs`, the per-tick summary lines | Set by the vendor's plan; not recorded in this repository                               | Free plan: three-minute checks, email alerts only (`docs/maintenance/00-betterstack-setup.md`).                 | Engineers and the owner; the public status page shows incidents it creates for OFFLINE maintenance.                                  | Email on a failed probe. It creates and resolves an incident when maintenance enters and leaves OFFLINE. |
| `SystemJobExecution`, `SystemEvent` | Job runs, and durable findings with a `context` JSON                              | 90 days for runs, 400 days for events                                                   | Postgres storage only. Both pruning jobs are ticker targets in the 20:00 to 23:30 UTC band, 500 rows per slice. | Admin only: the System Jobs page and executions API (`systemJobs.manage`) and the system events API.                                 | None by itself. The health probes read it, and a finding row is paired with a Sentry report.             |
| Entity trace and Run metrics        | Nothing. It reads the domain and audit tables and `SystemJobExecution`            | Whatever those tables keep                                                              | No vendor cost. A trace costs 10 to 17 statements, about one second at 95 ms a round trip.                      | Admin and staff (`payments.read`). Run metrics are admin only. Organisation members see nothing today.                               | None. It is pull, not push.                                                                              |

Organisation members have no view of any of these layers. An organisation money timeline is a later phase of the operations console (section 9).

## 5. Quota rules

The free Sentry plan allows 5,000 errors a month, and an exhausted allowance once blinded the platform for six days (`sentry/06-ingest-canary.md`). These rules keep real errors inside it. Each names what enforces it.

| Rule                                                   | Enforcer                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One report per run, never one per row                  | `createRunFailureReporter` in `lib/observability/run-failures.ts` collects failures and flushes one event per failing operation, with the count and ten sample ids in `extra`. A jest test pins the jobs that use it.                                            |
| Fixed fingerprints                                     | Reports pass `fingerprint: [subsystem, op]`. `applyErrorBudget` in `sentry.shared.config.ts` also forces a fixed family for Upstash quota, cron lock, Prisma pool and `SystemEvent` write failures, so one outage is one issue.                                  |
| A repetition is throttled; a set is aggregated         | `beforeSend` in `sentry.shared.config.ts` lets the first event for a key through and then one an hour per process (`INFRA_THROTTLE_MS`), and caps a process at 10 non-fatal events an hour. `fatal` events skip the cap.                                         |
| Expected failures go to logs, not issues               | `markExpected` and `expected: true` re-level a modelled refusal to a warning in `beforeSend`, and `applyErrorBudget` drops an expected event at `info`. The console and Sentry Logs keep the line.                                                               |
| Previews send no events                                | `isPreviewDeploy` in `beforeSend` drops every event when `NEXT_PUBLIC_SENTRY_ENVIRONMENT` is `preview`, on the server, edge and client alike. Traces and Sentry Logs still flow.                                                                                 |
| Config skips never reach Sentry                        | `reportConfigSkip` in `lib/cron/config-skip.ts` only logs. The run row stores outcome `skipped` with the reason (for example `PLATFORM_GSTIN not configured`), and `/api/health/jobs` lists the last day's skips under `configSkips` without changing `healthy`. |
| Business findings go to the console, money drift pages | Orphaned-confirmation channel skips, Stream membership removals and the 72-hour needs-human queue are `SystemEvent` rows only. Wallet and ledger drift still page Sentry once per new id set through `reportStandingFinding`.                                    |
| Boot-time configuration warnings go to Sentry Logs     | A missing key at boot is logged and sent as a `Sentry.logger.warn`, never as an issue, and only in production. The first user is `AUTH_CAPTCHA_DISABLED` in `lib/auth/captcha.ts` **(arrives with #2423)**.                                                      |
| Browsers' CSP reports are not sent until enforcement   | `next.config.mjs` builds the `report-uri` directive only when `ENABLE_CSP_ENFORCE` is `true`, because a report bypasses every SDK hook and is a billable event. `__tests__/lib/csp-report-gate.test.ts` pins it.                                                 |
| The canary costs no error quota                        | The canary reads `stats_v2` once a day and sends no event. `reportableToSentry` in `netlify/functions/cron-tick.mts` keeps its own failing run out of Sentry.                                                                                                    |

## 6. Ticker failure escalation

The ticker answers 200 to Netlify whatever happens, because Netlify re-invokes a scheduled function that returns 5xx. It therefore reports target failures itself, in `alertFailedTargets` (`netlify/functions/cron-tick.mts`).

A failing target is judged only on its own first due tick of an hour (`isFirstDueTickOfHour` in `lib/cron/schedule.ts`), so one target is judged at most once an hour. `isRepeatedFailure` in `lib/cron/failure-streak.ts` then decides where it goes:

- **A one-off goes to the logs only.** The ticker writes one `cron-tick.target-failed-once` JSON line with the target, the status and `class: platform` when the body is Netlify's own error page. The tick's summary line and its Better Stack copy carry it too, as does the run row when the target ran. No Sentry event is sent.
- **A repeat is a per-target error.** It is raised only when the target has had no `COMPLETED` run for three times its own cadence (`STREAK_CADENCES`). Its fingerprint is `cron-tick` / `<target>`, so each broken target is its own issue.

For example, `reconcile-refunds` runs every 15 minutes at offset 5, so its slots are :05, :20, :35 and :50 UTC and its first slot of an hour is :05. Three cadences are 45 minutes. At 05:05 UTC (10:35 IST) on Monday 26 October 2026 the target answers 500.

| Last `COMPLETED` start of `reconcile-pending-refunds` | Gap at 05:05 UTC | Result                                                    |
| ----------------------------------------------------- | ---------------- | --------------------------------------------------------- |
| 04:50 UTC                                             | 15 minutes       | Log line only.                                            |
| 04:05 UTC                                             | 60 minutes       | Error issue for `reconcile-refunds`.                      |
| No row in the last 7 days                             | not known        | Log line only, because unknown history is never a repeat. |

The ticker reads that history from `/api/health/jobs/streaks` with a two-second bound. An unreachable endpoint also counts as unknown. Two limits follow from the design. A platform 5xx leaves no `SystemJobExecution` row, so the test is the absence of a recent `COMPLETED` row and not a run of `FAILED` rows. And because the test reads `COMPLETED` rows, a job that keeps answering 207 is stored `partial` (`FAILED`) and is escalated after three cadences, which the old `COMPLETED` row would have hidden (section 7).

The `cron-tick` monitor is separate and unchanged. It catches the ticker going silent, and it needs three bad check-ins in a row to open an issue, because the first tick after every deploy aborts most targets.

## 7. The run record and its outcome vocabulary

A run's HTTP status, not the job's own boolean, decides what is stored. `cleanupRoute()` derives the outcome from the status it answers (`routeOutcome` in `lib/cron/run-outcome.ts`) and `recordRouteRun()` (`lib/cron/run-record.ts`) rewrites the row once, so the row and the response agree. The outcome is stored in `result.outcome` and maps to a status:

| Outcome     | Status      | Meaning                                                                                                                                                                      |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed` | `COMPLETED` | Answered 2xx other than 207.                                                                                                                                                 |
| `attention` | `COMPLETED` | Answered 207 through the route's `needsAttention` with no item failing: findings for a person. It counts as a success for streaks and paging and shows amber in the console. |
| `partial`   | `FAILED`    | Any other 207: items failed, or work remained that the job reports as partial. It counts as a failure for the streak rule.                                                   |
| `failed`    | `FAILED`    | Answered 400 or above, threw, or was taken over after its lease expired.                                                                                                     |
| `held`      | `CANCELLED` | Another run held the lease (409). The row stores `holderRunId`.                                                                                                              |
| `skipped`   | `CANCELLED` | A configuration skip, or a core that declined.                                                                                                                               |
| `refused`   | `CANCELLED` | The maintenance phase refused the run.                                                                                                                                       |
| `paused`    | `CANCELLED` | Reserved for the pause control of Phase 2; nothing writes it yet.                                                                                                            |

Three identifiers link the layers. The **run id** is the `SystemJobExecution` row id: it is set as the Sentry tag `job_run_id`, written into `SystemEvent.context.jobRunId`, and named by a later run as `takenOverBy` or `holderRunId`. The **tick id** is a UUID derived from the tick's five-minute slot (so a duplicate dispatch of one slot carries the same id) that the ticker sends as `x-tick-id`; it is on every run row it dispatched, in the ticker's console line and in the Better Stack summary. The **ops-log id** (`result.opsActionLogId`) joins an admin-started run to its audit entry, and `triggeredBy` is `admin:<userId>` for such a run. Each run also stores six counters, `casMiss`, `serializationRetry`, `deadlockOrLockTimeout`, `poolTimeout`, `leaseLost` and `leaseTakeover`, as evidence for the Integrity panel. Postgres still prevents the bad states; the counters only show how contended a run was.

For example, on Monday 26 October 2026 at 10:55 IST (05:25 UTC) `retry-auto-refunds` spends the third attempt on Priya Anderson's ₹1,180 (118,000 paise) refund. The attempt failed in this run, so the route answers 207 and the row is `FAILED` with outcome `partial`, `httpStatus` 207 and the tick's id; the "refund by hand" `SystemEvent` carries that row's id in `context.jobRunId`. A later run whose only finding is the retired marker is `COMPLETED` with outcome `attention`. The per-job list is in section 4 of the machinery catalog.

Still not stored: a bad bearer, a bad `?limit=` and a fail-closed lease the database could not grant leave no row (the ticker counts the last in `lockUnavailable`), and refund, payout and invoice rows carry no run id.

## 8. Identity and privacy

An error is useful only if it can be attributed to a person and an organisation, and attaching a person to an event is personal-data processing. Request-scoped stamping is opt-in (`SENTRY_IDENTITY_ENABLED` must be exactly `on`), is currently off, and is gated on a data-protection determination. The ingest canary sends no event, so it carries no person. The design, the lawful-basis reasoning and the cross-border transfer question live in [sentry/05-identity-and-triage.md](./sentry/05-identity-and-triage.md) and [sentry/08-error-telemetry-privacy-reference.md](./sentry/08-error-telemetry-privacy-reference.md). This page does not repeat them.

## 9. The operations console: Phase 1 implemented, the rest planned

Phase 1 ("record the truth": real outcomes, the stored summary, held and skipped rows, the counters, the run and tick ids, the SLO tiers and the registry-driven admin Run door) is implemented and described in section 7. The bullets below record the rest of the design accepted as ADR-13 and tracked in issue #2424; the Needs attention inbox, the sub-tabs, Pause and Retry, the per-item table and the Run detail page do not exist yet.

- **Principle (owner decision, 2026-10-28):** Sentry and Better Stack fix the system, with one grouped issue per failure class and a sample of ids. The console fixes the customer: for one user's stuck refund, payout or dispute, an operator sees the specific item, why it failed and what was tried, then remediates through the audited money doors and the linked support case. The console is a failed-items list plus a run log, not a metrics dashboard.
- **Sub-tabs, in the support inbox pattern:** Overview, Jobs, Runs, Integrity and Performance, as a `Tabs` strip whose value lives in a URL query parameter (`SupportInboxShell` with `useListParams`). Nothing of this exists yet.
- **Phase 2, no DDL (planned):** the Overview is a "Needs attention" inbox of failed or stuck items (refunds owed and retired, payouts `PROCESSING` or `FAILED`, unpaid invoice captures, dead-lettered emails, recording copies) built from existing domain columns. Each row shows the reason, attempts, age, a Retry door where one is allowed and a link to the Entity trace. A registry of owed-work sources drives it: each source declares its stuck-item query, reason field, age limit and remediation door, as the cron registry drives jobs (specified in section 5.3 of the job machinery catalog). A job health table shows the last real outcome, age, backlog, SLO tier, Run and Pause. Drain is dropped, and p50 and p95 sit in a collapsed Performance tab.
- **Admin-only, audited controls:** Run now (one bounded slice, implemented), Pause and Resume (a database flag the ticker checks before dispatching, with a reason and an optional auto-resume time), and Retry failed items (requeues specific owed items, not a blind re-run). There is no hard Stop, because a running serverless invocation cannot be killed from outside.
- **Integrity panel:** the reconcilers' latest findings, plus the per-run counters for lost compare-and-swap claims, serialization retries, deadlock and lock timeouts, pool timeouts and lease takeovers (the counters are recorded; the panel is not built). Postgres constraints and compare-and-swap transitions keep preventing bad states; the panel only shows evidence.
- **Phase 3, DDL (planned):** `SystemJobRunItem` holds one row for each entity a run changed or failed on, with the outcome, a reason code, the attempt number and a short error, kept for 90 days, and a Run detail page gives each item's attempt history. An entity is **STUCK**, a computed state that is not stored, after it fails in consecutive runs or after its owed marker ages out.

Why Sentry alone cannot do this: a cron failure is one grouped issue per failing step with at most ten sample ids in `extra`, it carries no user identity (identity is stamped only on request-scoped events), and Better Stack gets one aggregate line per tick. The run id (`job_run_id` tag, `SystemEvent.context.jobRunId`) links the three layers to the per-item rows in Postgres.

The console is pull, not push. Alerting stays in Sentry and Better Stack.

## Where in code

| Concern                                  | File                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SDK initialisation, budget and scrubbing | `sentry.shared.config.ts`, `lib/observability/sentry-scrubber.ts`                                                                                                                                |
| Reporting helpers                        | `lib/observability/report.ts`, `lib/observability/run-failures.ts`, `lib/observability/standing-finding.ts`                                                                                      |
| Ingest canary                            | `lib/observability/ingest-canary.ts`, `lib/observability/ingest-alert.ts`                                                                                                                        |
| Ticker, check-in, summary and escalation | `netlify/functions/cron-tick.mts`, `lib/cron/failure-streak.ts`, `lib/cron/schedule.ts`                                                                                                          |
| Run record and lease                     | `lib/cron/with-cron-lock.ts`, `lib/cron/job-outcome.ts`, `lib/cron/cleanup-route.ts`, `lib/cron/run-context.ts`, `lib/cron/run-counters.ts`, `lib/cron/run-outcome.ts`, `lib/cron/run-record.ts` |
| Health endpoints and completion budgets  | `app/api/health/route.ts`, `app/api/health/jobs/route.ts`, `app/api/health/jobs/streaks/route.ts`, `lib/cron/operational-health.ts`                                                              |
| Durable findings                         | `lib/enterprise/system-events.ts`, `lib/observability/system-event-retention.ts`                                                                                                                 |
| Better Stack telemetry                   | `lib/observability/betterstack-telemetry.ts`                                                                                                                                                     |

## Related

The Sentry set is indexed in [README.md](./README.md). The ticker drill is in [the Better Stack guide](../maintenance/00-betterstack-setup.md#ticker-missed-run-alerts). Issues: #2424 (operations console), #2165 and #2402 (ticker and job visibility).

## Sentry noise policy: escalations only

The free Sentry plan stores 5,000 errors a month, shared by every environment. A Sentry event means "a person must act now". Before this policy, 193 errors were accepted in the 7 days to 2026-10-31, about 28 a day. The rules, each with its enforcer:

- **A single failed ticker target is logged, not sent.** Only `isRepeatedFailure` (no `COMPLETED` run for three cadences) sends an error (section 6).
- **Config skips stay out of Sentry.** They are `skipped` run rows with the reason, shown on the console and in `/api/health/jobs` (section 5). A boot-time missing key such as `AUTH_CAPTCHA_DISABLED` is a Sentry Logs line, which draws on no error quota.
- **Standing business findings are `SystemEvent` rows for the console.** Money-integrity drift (wallet and ledger) still pages once per new id set.
- **The canary reads usage stats instead of sending an event**, and pages by email and Better Stack (`sentry/06-ingest-canary.md`).
- **Preview deploys send no error events** to the shared project.
- **Spike Protection is on** for the project, so a burst is cut off by Sentry before it spends the month.

**Documented alternative, not adopted:** a second Sentry project for previews, so preview errors stay visible without touching the production quota. Adopt it if preview debugging needs Sentry and the second project's quota is affordable. The decision record is `docs/decisions/2026-10-31-sentry-escalations-only.md`.

## Deprecated & Superseded Approaches

| Superseded approach                                                                                    | Why it was superseded                                                                                              | What to do with residue                                                                          |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| An ingest canary every 30 minutes                                                                      | It cost about 1,440 events a month on a 5,000 quota. The cadence is now 6 hours and the issue is archived.         | Delete any text or config that says 30 minutes.                                                  |
| CSP reports sent while the policy is report-only                                                       | Reports bypass every SDK hook and each is a billable event.                                                        | Keep the report directive gated on `ENABLE_CSP_ENFORCE`.                                         |
| Redis locks for cron jobs                                                                              | Redis is often the outage, and a lock there fails open or closed wrongly. The lease is a `SystemJobExecution` row. | Delete any Redis lock in a job. Redis keeps only the heartbeat timestamp.                        |
| Capturing to Sentry once per failing row                                                               | A systemic fault spent the quota in a day.                                                                         | Use `createRunFailureReporter`, with `skipSentry: true` on the per-row `recordSystemError` call. |
| A Sentry error for every failing ticker target, then a grouped warning for a one-off                   | Noise, and every one-off still spent quota.                                                                        | Log one-offs; send only on the streak test.                                                      |
| An ingest canary that posted a stored error event, and preview errors sampled at 10 %                  | About 120 and 46 stored events a month for no action.                                                              | Delete any `isThinnedOnPreview`, `isBelowErrorOnPreview` or envelope-probe residue.              |
| Config skips and business findings filed as Sentry warnings                                            | A configuration state or a queue for a person is not a fault.                                                      | Record a `skipped` run or a `SystemEvent` instead.                                               |
| A run row that said only `outcome`, `environment` and `checkpoint`, with `COMPLETED` for a partial run | The row could not say what a run did, and it disagreed with the HTTP answer.                                       | Any reader or alert that treats `COMPLETED` as clean without the outcome; read `result.outcome`. |
| Pruning the run trail and `SystemEvent` from Actions                                                   | The Actions batch jobs are budget-blocked. Both prunes are ticker targets.                                         | Any note that says the prunes are Actions-scheduled.                                             |
| A Drain control and a percentile-first Overview                                                        | The console answers which item failed, not how fast the job ran (ADR-13 amendment)                                 | Do not build Drain; keep p50 and p95 on the Performance tab.                                     |
