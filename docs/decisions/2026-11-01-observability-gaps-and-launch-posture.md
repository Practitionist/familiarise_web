# ADR: Observability gaps and the launch posture

- **Status**: Accepted (owner decisions of 2026-11-01). Decisions 1 to 8 ship in the pull request that adds this record, except the Better Stack alerts themselves, which are owner steps in the [Better Stack setup guide](../maintenance/00-betterstack-setup.md). Decisions 9 to 15 change no code.
- **Date**: 2026-11-01
- **Author**: Platform engineering
- **Related**: [Observability ownership](2026-11-01-observability-ownership.md) (amended here on per-item history), [Ownership of Sentry and Better Stack](../observability/01-ownership-sentry-betterstack.md), [Job-runtime experiments](2026-10-31-job-runtime-experiments.md), [Sentry escalations only](2026-10-31-sentry-escalations-only.md), [Money go-live checklist](../finance/70-operations/07-go-live-checklist.md), issues #2424, #2491, #2492, #2493, #2496 and #2503

## Context

The [ownership decision](2026-11-01-observability-ownership.md) made Better Stack the pager for ageing work and planned per-item history as Better Stack events. It also named three prerequisites: ingest rejections were invisible (`emitTelemetryLog` never read the response status), nothing noticed when telemetry stopped arriving, and no capability said what a missing value means. Two cost facts shape the answer. Sentry's free plan drops everything past 5,000 errors a month, and the ticker and its jobs make roughly 91,000 runs a month, so one Better Stack outage reported to Sentry run by run would spend the whole quota. Better Stack's free plan keeps logs for three days.

## Decisions

### Observability (built in this change)

1. **Better Stack stays on the free plan until launch.** That means 3-day log retention and email and Slack alerts only. The responder seat for phone and SMS paging (about $29 to $34 a month) and the Telemetry Nano bundle (30-day retention, about $25 a month billed yearly, EU region) are bought at launch. This is a launch-checklist item in the [money go-live checklist](../finance/70-operations/07-go-live-checklist.md).
2. **Job history on the free tier lives on the run row, with no schema change.** `SystemJobExecution.result` gains two keys, written by `recordRouteRun` (`lib/cron/run-record.ts`) from the run context and validated with Zod (`lib/cron/run-telemetry.ts`):
   - `result.telemetry = { sent, rejected: { "402", "403", "5xx", "network", "other" } }`, the run's Better Stack sends. `other` holds any non-2xx answer that is not 402, 403 or 5xx, so no rejection goes uncounted.
   - `result.failures[]`, at most 50 entries of `{ entityId, reason, attempt }`, with `result.failuresOverflow` counting the rest. Each entry comes from `createRunFailureReporter().add()`: the entity id is the first `id` or `*Id` value in the failure context that is a plain identifier, the reason is the failure class (`op`), and the attempt is the context's `attempt`, `attempts` or `retryCount`. No names, emails or error text.

   `result` already held `outcome`, `reason`, `environment`, `httpStatus`, `counters`, `tickId`, `opsActionLogId`, `holderRunId`, `summary` and `checkpoint`; the new keys sit beside them and clobber none. The run-history prune (180 days for runs that report failures) (`prune-system-job-executions`) bounds them. **This amends the ownership decision:** per-item Better Stack events (gaps PR 2) are deferred until there is traction. It is a deliberate cost decision, to be revisited at traction, because the free tier's three days of retention cannot answer "every attempt on payment X" and the run row can for 180 days.

3. **Ingest rejections are counted, never paged through Sentry.** `emitTelemetryLog` (`lib/observability/betterstack-telemetry.ts`) reads the status and resolves to a typed outcome: `sent`, `skipped`, `402` (quota or spending limit spent), `403` (invalid source token), `5xx`, `network` or `other`. It never throws and has a 2-second timeout. A run's verdict write waits for its in-flight sends, so the counts are complete. There is no Sentry capture per rejection and none per run; the earlier `Sentry.captureException` on a failed send is gone.
4. **Events are built from a fixed, Zod-validated field set.** The arbitrary `context` spread is removed. A `SystemEvent` mirror sends its level, message, category, organisation id, correlation id, the run id and one entity id; the row in Postgres keeps the full context. Messages, correlation ids and errors pass through `scrubStringValue`, which removes email addresses. The ticker's summary uses the same emitter.
5. **A freshness alert is the single catch-all for missing telemetry.** A Better Stack SQL alert fires when no `cron-tick summary` event arrives for 15 minutes (three ticks), by email and Slack. It is vendor configuration, so it is an owner step with the exact query in the [setup guide](../maintenance/00-betterstack-setup.md#owner-step-the-tick-summary-freshness-alert). The ticker already emitted that event; it is reused.
6. **Missing data has a policy per capability.** The four money queues (refunds owed, payouts, dunning notices, disputes) open an incident when their gauge is missing. Non-money gauges treat missing data as no incident, and the freshness alert covers them. The table is in the [setup guide](../maintenance/00-betterstack-setup.md#missing-data-policy-per-capability).
7. **Oldest-pending-age gauges ride on the tick summary.** The slot claim reads seven gauges in one SQL statement after the idle probes, inside the existing probe transaction and its 2-second budget (`readPendingAges` in `lib/cron/pending-ages.ts`, called from `probeTick` in `lib/cron/idle-probe.ts`). The ticker puts them on its summary as the fixed field `oldestPendingAgeS`. No ticker target is added, `MAX_TARGETS_PER_TICK` stays at 12, and the cost is one round trip of about 62 ms per tick. The thresholds, each justified against `lib/cron/schedule.ts`, are:

   | Gauge                 | Alert when past due by          | Draining job and cadence                                      |
   | --------------------- | ------------------------------- | ------------------------------------------------------------- |
   | `refundsOwed`         | 1 h                             | `retry-auto-refunds`, every 15 min after a 15-minute grace    |
   | `payoutsStuck`        | 4 h                             | `process-payouts` hourly; `reconcile-payout-status` every 2 h |
   | `dunningNotices`      | 26 h                            | `dunning`, three slots a night in the 23:30–02:30 UTC window  |
   | `disputesDue`         | 0 (inside 48 h of the deadline) | `reconcile-disputes` hourly                                   |
   | `webhookEvents`       | 1 h                             | `sweep-stuck-webhook-events`, every 15 min                    |
   | `emailRetries`        | 1 h                             | `retry-failed-emails`, every 15 min                           |
   | `notificationRetries` | 1 h                             | `drain-notification-outbox`, every 10 min                     |

   All seven alert by email and Slack now. The four money gauges move to phone paging when the responder seat is bought (its trigger is kept in Notion, see the note under Consequences); until then they keep alerting by email and Slack, including after launch.

8. **The Stuck work inbox is read-only.** One console page, `/dashboard/admin/stuck-work`, behind `systemJobs.manage` like System Jobs, lists the stuck items of the same seven queues with the age past due, the attempts and the last error, linked to the Entity trace and the existing money, invoice, compliance and System Jobs pages where the actions already live. Each queue shows its total and, when it holds more than 25 items, the oldest 25 and the newest 25 with a count of those in between, so a failure from today shows beside a backlog of 131 dead letters. Disputes are measured from `Dispute.dueBy` itself ("due in 5 h", "overdue by 42 d"); only their listing opens 48 hours early, matching the `disputesDue` gauge. It adds no mutation path. It reads eight bounded statements in sequence while every table fits on the page, and two more (the newest rows and a count) for each table that overflows (`lib/backoffice/needs-attention.ts`). It is named Stuck work because the admin Home page is already titled Needs attention. The totals, the newest items, the deadline-based dispute label and the name were approved by the owner on 2026-11-01 after deploy-preview QA. This is #2424 Phase 2 without the Retry buttons.

### Launch posture (no code)

9. **Stay on Netlify legacy Pro** until a person from Netlify billing answers ticket #1159326. The switch to credit-based billing is one-way, so it is not made on an automated reply.
10. **The F1 RazorpayX static-IP proxy: buy nothing until the first live payout**, then QuotaGuard Static in the Mumbai region. The code is on `dev`: `RAZORPAYX_EGRESS_PROXY_URL` and the `ProxyAgent` in `lib/payments/payouts/razorpay-payouts.ts`. The runbook step (set the variable in Netlify production, allowlist the proxy addresses in RazorpayX, then a ₹1 test payout) is in [the money go-live checklist](../finance/70-operations/07-go-live-checklist.md).
11. **Keep the Netlify ticker.** No QStash replacement.
12. **Keep the hourly "Run now" backstop at :40** (`drain-admin-run-requests`, every 60 minutes at offset 40).
13. **Post-launch order:** #2496 (retention audit), then #2492 (job backlog and throughput) with #2493 (the long-route audit) folded in, then #2491 (a portable `runJob`).
14. **The Vercel `bom1` and Mumbai VM measurements happen after launch.** The owner unblocks the Lightsail IAM access now so the VM probe is ready.
15. **Trigger.dev is not adopted until a job needs more than 25 seconds.** Issue #2503 tracks it.

## Alternatives rejected

| Option                                          | Why it was rejected                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Per-item Better Stack events now                | Three days of free retention cannot answer a customer's question; the run row keeps 180 days at no cost.                |
| A new `SystemJobRunItem` table or column        | Still rejected; the run row's `result` Json carries the bridge with no DDL.                                             |
| Report ingest rejections to Sentry              | One Better Stack outage across about 91,000 runs a month would spend the 5,000-error quota.                             |
| A new ticker target or job for the gauges       | The tick cap of 12 is full; the slot claim already runs a bounded probe transaction.                                    |
| One Prisma aggregate per queue                  | About eleven statements at about 62 ms each inside the claim's 5-second budget; one raw statement costs one round trip. |
| Retry buttons on the inbox now                  | No new mutation paths; the existing pages already hold the audited doors.                                               |
| A count and a newest read for every inbox table | Three statements per table on every load; reading them only when a table overflows keeps a quiet console at eight.      |
| Aging disputes from 48 hours before `dueBy`     | Overstates how late a dispute is by two days; only the gauge keeps that lead, so its alert fires early.                 |
| Buy the responder seat and the Nano bundle now  | Cost before there is real money to protect.                                                                             |

## Consequences

- A rejected or stalled Better Stack send adds at most 2 seconds to a run's verdict write, and only while ingest is degraded.
- `ENABLE_BETTERSTACK_TELEMETRY` is read at call time by the emitter; the module-load constant in `lib/feature-flags.ts` is removed.
- The gauges are blind when the probe budget is spent or the claim is unreachable; the money alerts then open an incident by policy, and the freshness alert covers a stopped ticker.
- On the shared database the money gauges are not zero today because of seeded and QA rows; the owner chose to create the alerts muted and unmute them after the go-live data reset, without deleting rows on the shared database.
- **Superseded in part (2026-11-11).** The Better Stack responder seat and the Telemetry Nano bundle are no longer bought "at launch"; each moves to a trigger kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend). The static-egress vendor in decision 10 is open: QuotaGuard Static or another fixed-IP HTTP or HTTPS forward proxy that supports `CONNECT` works, because the code reads only `RAZORPAYX_EGRESS_PROXY_URL` and sends through undici's `ProxyAgent` (a SOCKS-only proxy does not). The purchase stays tied to the first live platform payout. See [the 2026-11-11 levers record](2026-11-11-cfo-csmo-levers.md).

## Deprecated & Superseded Approaches

- **Per-item Better Stack events as the history store** (the ownership decision's selected option (a), "gaps PR 2") are deferred, not built. Until traction, per-item history is `SystemJobExecution.result.failures`.
- **`Sentry.captureException` on a failed Better Stack send** and the **`context` spread into every event** were removed; any code that sends free-form context to Better Stack is left over from that approach.
- **The ticker's inline summary emitter** was replaced by the shared emitter.
- **The first inbox build** was titled Needs attention, listed each queue oldest-first capped at 25 with no total, and aged disputes from 48 hours before `dueBy`. With 131 dead-lettered emails a new failure never showed, so it gained totals and the newest items and was renamed Stuck work, at `/stuck-work`.
