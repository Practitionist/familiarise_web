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
- **No PII, EU region.** Events carry ids only, never names, emails or free text from users. Create the Better Stack source in the EU region. Neither vendor has an India region.
- **Never send per-item events to Sentry** (Logs or spans). Quota and sampling make it wrong.
- **The oldest-pending-age gauge is computed in Postgres once per tick**, one aggregate per capability, and alerted by a Better Stack SQL threshold. PLANNED.

## Event schema (PLANNED)

| Field       | Meaning                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `run_id`    | The `SystemJobExecution` id (the same value as the Sentry `job_run_id` tag). |
| `job`       | The registry job name.                                                       |
| `entity_id` | The id of the payment, booking, payout or other row. Id only.                |
| `outcome`   | `ok`, `skipped`, `failed` or `held`.                                         |
| `reason`    | A short code such as `GATEWAY_TIMEOUT` or `LOST_CAS`.                        |
| `attempt`   | The attempt number read from the entity row.                                 |

The research suggests `tick_id` and `duration_ms` as optional extras.

## Links

- `docs/observability/01-ownership-sentry-betterstack.md` and `docs/observability/02-research-per-item-history-and-vendors.md`
- `docs/decisions/2026-11-01-observability-ownership.md`
- `references/job-telemetry.md`, `references/entity-trace-and-console.md`
- Issues #2424, #2453, #2492, #2496
