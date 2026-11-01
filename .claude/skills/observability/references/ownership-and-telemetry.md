# Ownership and per-item telemetry

Read this before adding a log event, an alert, a Postgres log table, or a Sentry call for something that is not a bug. The reasoning is in `docs/observability/01-ownership-sentry-betterstack.md` and `docs/decisions/2026-11-01-observability-ownership.md`.

## Decision table

| Question                 | Owner                                                                                                                                    | Not            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Alive? Who is paged?     | Better Stack (monitors, `pingHeartbeat()` in `netlify/functions/cron-tick.mts`, tick summary, `emitTelemetryLog`, maintenance incidents) | Sentry         |
| Which code broke?        | Sentry (grouped issue, `job_run_id` tag, `cron-tick` check-in)                                                                           | Better Stack   |
| What is the truth?       | Postgres (`SystemJobExecution`, owed markers, entity rows)                                                                               | a log store    |
| What do I do about it?   | The back-office console (System Jobs, Run metrics, Entity trace, inbox)                                                                  | Sentry samples |
| Raw prints, vendor truth | Netlify logs, vendor dashboards                                                                                                          |                |

## Rules

- **A backlog breach pages via Better Stack, not Sentry.** Ageing work is not a bug and Sentry quota is capped.
- **Do not add Postgres log tables.** No `SystemJobRunItem`. Current state lives on the row; history lives in the log store.
- **Per-item history is one batched Better Stack POST per run**, never a call per row. PLANNED; not built yet. Use the `emitTelemetryLog` conventions: best-effort, never throws, bounded timeout.
- **Ids only, and the events are still personal data.** Events carry ids only, never names, emails or free text from users. That minimises disclosure but does not anonymise: a payment id resolves to a person (`Payment.userId` references `User`, and `readRootPayments()` in `lib/backoffice/entity-trace.ts` reads the customer's name), so the events are pseudonymous personal data under [DPDP §2(t)](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf), the same position `docs/observability/sentry/05-identity-and-triage.md` takes for the Sentry cuid. Creating the source in the EU region does not make them non-personal.
- **The Better Stack rollout needs a privacy assessment first.** Before per-item events ship, settle the processor entry, the privacy-notice disclosure, access and erasure handling, and retention, using the processor inventory in `docs/compliance/02-dpdp-and-privacy.md` (Data inventory, Gap #11) and the `compliance` skill.
- **India region.** Neither Better Stack (EU, US, Singapore) nor Sentry (US, EU) has one. If in-country telemetry is ever required, Grafana Cloud (AWS `ap-south-1`) and SigNoz Cloud both list India; compare them in section 7 of the research page.
- **Ingest rejection is silent today.** Better Stack's ingest API answers 402 once the free quota or spending limit is reached and 403 for a bad token, which stops per-item events and backlog gauges alike while the separate uptime heartbeat stays green. `emitTelemetryLog` awaits `fetch` but never reads the status. Before gaps PR 1 and PR 2, record and surface 402, 403 and 5xx answers, add a freshness check on a channel independent of ingest, and write a per-capability missing-data policy. Business work stays best-effort with respect to telemetry.
- **Never send per-item events to Sentry** (Logs or spans). Quota and sampling make it wrong.
- **The oldest-pending-age gauge is computed in Postgres once per tick**, one aggregate per capability, and alerted by a Better Stack SQL threshold. PLANNED.

## Event schema (PLANNED)

| Field       | Meaning                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `run_id`    | The `SystemJobExecution` id (the same value as the Sentry `job_run_id` tag). |
| `job`       | The registry job name.                                                       |
| `entity_id` | The id of the payment, booking, payout or other row. Id only; a pseudonym.   |
| `outcome`   | `ok`, `skipped`, `failed` or `held`.                                         |
| `reason`    | A short code such as `GATEWAY_TIMEOUT` or `LOST_CAS`.                        |
| `attempt`   | The attempt number read from the entity row.                                 |

The six fields above are required on every event. `tick_id` and `duration_ms` (suggested by the research) are optional extras; the decision record and the research page use the same split.

## Links

- `docs/observability/01-ownership-sentry-betterstack.md` and `docs/observability/02-research-per-item-history-and-vendors.md`
- `docs/decisions/2026-11-01-observability-ownership.md`
- `references/job-telemetry.md`, `references/entity-trace-and-console.md`
- Issues #2424, #2453, #2492, #2496
