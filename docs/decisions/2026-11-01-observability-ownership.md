# ADR: Observability ownership, per-item history and backlog alerting

- **Status**: Accepted (owner decisions of 2026-11-01), amended the same day by [observability gaps and launch posture](2026-11-01-observability-gaps-and-launch-posture.md). The ownership split, the oldest-pending gauges, the inbox and observable ingest are built; per-item Better Stack events are deferred until traction, and until then per-item history is `SystemJobExecution.result.failures`.
- **Date**: 2026-11-01
- **Author**: Platform engineering
- **Related**: [Ownership of Sentry and Better Stack](../observability/01-ownership-sentry-betterstack.md), [the research](../observability/02-research-per-item-history-and-vendors.md), [Sentry escalations only](2026-10-31-sentry-escalations-only.md), issues #2424, #2453, #2492 and #2496

## Context

Jobs run from one Netlify ticker and each run leaves a thin trail: a `SystemJobExecution` row per run, owed markers on entity rows, and Sentry issues for repeats. That cannot answer "show every attempt on payment X", and nothing pages when work merely ages. The question was where per-item history should live and which tool owns which question. Sentry's free plan drops data over 5,000 errors a month, and Better Stack's free logs keep three days.

## Decisions

### Selected

1. **Per-item history.** Current state (attempts, last error, age) lives on the entity row. History goes to batched Better Stack log events, one POST per run with `{run_id, job, entity_id, outcome, reason, attempt}` (all required; `tick_id` and `duration_ms` optional), identifiers only, EU region. Identifiers only minimises disclosure, but a payment id resolves to a customer, so the events are pseudonymous personal data under [DPDP §2(t)](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf) and the rollout carries a processor, disclosure, access and erasure, and retention assessment (see [DPDP and privacy](../compliance/02-dpdp-and-privacy.md)). There is no `SystemJobRunItem` table and no warehouse. (DEFERRED to traction by the [gaps decision](2026-11-01-observability-gaps-and-launch-posture.md); the run row's `result.failures` is the free-tier bridge.)
2. **Ownership split.** Sentry owns grouped errors, the `cron-tick` check-in and sampled traces. Better Stack owns per-item events, heartbeats and uptime, paging, and SQL threshold alerts.
3. **Backlog breaches page through Better Stack, not Sentry.** The oldest pending age per capability is computed once per tick in Postgres, emitted on the tick summary as `oldestPendingAgeS`, and alerted by a Better Stack SQL threshold. (Built; the alerts are owner steps.)
4. **Paging.** Email and Slack now. One Better Stack responder licence (about $29 to $34 a month) at launch.
5. **Retention.** Free three-day logs now; the Telemetry Nano bundle (30 days, EU, about $25 a month billed yearly) at launch.
6. **Build order.** Gaps PR 1 (inbox plus oldest-pending alerts) is built; gaps PR 2 (per-item events plus the Entity trace link) is deferred to traction by the gaps decision. Both depend on observable ingest first: Better Stack answers 402 at the free quota or spending limit, which silently stops per-item events and gauges while heartbeats stay green, and `emitTelemetryLog` never reads the response status. So record and surface 402, 403 and 5xx answers, add a gauge freshness check through a channel independent of ingest, and write a per-capability missing-data policy. Business work stays best-effort with respect to telemetry. The retention audit of log-like tables is #2496.
7. **Warehouse.** None. Postgres with retention is enough pre-launch.

### Rejected

| Option                                                                                     | Why it was rejected                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Postgres `SystemJobRunItem` table, with or without a TTL                                 | Unbounded growth, no owner for cleanup, and it makes the transactional database a warehouse. It was first recommended, then rejected by the owner (the reversal). |
| OpenTelemetry spans per item                                                               | Messaging conventions are at Development status, and Sentry sampling can drop the span of a rare entity.                                                          |
| Sentry Logs for per-item events                                                            | Quota cost, and a [7-day query window](https://docs.sentry.io/product/explore/logs/) on the free plan.                                                            |
| Better Stack for everything                                                                | We would lose Sentry's grouping, stack traces and release health.                                                                                                 |
| Sentry for everything                                                                      | Hard quota with dropped data, and email-only free alerts.                                                                                                         |
| Reporting a backlog breach to Sentry                                                       | Spends quota and mixes backlog with bugs.                                                                                                                         |
| Console-only backlog alerts                                                                | Nobody is paged.                                                                                                                                                  |
| Email-only paging, or phone paging before launch                                           | Too weak for a money backlog at night, or cost before there is anything to protect.                                                                               |
| Free three-day logs forever                                                                | History vanishes before a customer asks.                                                                                                                          |
| BigQuery or ClickHouse now                                                                 | Not needed pre-launch.                                                                                                                                            |
| Highlight (LaunchDarkly)                                                                   | Redirects to LaunchDarkly and is reportedly shut down.                                                                                                            |
| Axiom, Grafana Cloud, Honeycomb, OpenObserve, Datadog, New Relic, PostHog, Supabase drains | No capability we lack; cost, new vendor or wrong tool. Reasons are in the options tables of the ownership page.                                                   |

### Deferred, with the trigger

- **Job-engine dashboards** (Inngest, Trigger.dev, Vercel Workflows): only if an engine is adopted.
- **Read replica, or Parquet exports read with DuckDB:** when the largest analytical table passes about 50 to 100 GB, reports measurably slow checkout, or a non-engineer needs self-serve reporting.
- **An India-region telemetry store**: if a legal opinion requires in-country telemetry. Grafana Cloud (AWS `ap-south-1`) and SigNoz Cloud (from $49 a month) both list India; the research page compares them.

## Consequences

- Better Stack logs are best-effort: a function killed before the flush loses that run's events. Crash evidence stays in the `SystemJobExecution` row.
- Neither Better Stack (EU, US, Singapore) nor Sentry (US, EU) has an India region. Events carry ids only, never names or emails, yet remain pseudonymous personal data; EU placement does not make them non-personal.
- A Better Stack quota cutoff drops telemetry without failing any job, so coverage must never silently assume unlimited ingest.
- The per-item table in #2424 Phase 3 and #2453 is superseded. The inbox is built read-only; Retry stays on the existing pages.

## Deprecated & Superseded Approaches

The `SystemJobRunItem` Postgres table proposed earlier is superseded by this record. Any code, schema or doc that still plans it should be removed.
