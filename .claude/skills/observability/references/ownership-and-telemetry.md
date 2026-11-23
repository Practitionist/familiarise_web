# Ownership and per-item telemetry

Read this before adding a log event, an alert, a Postgres log table, or a Sentry call for something that is not a bug. The reasoning is in `docs/observability/01-ownership-sentry-betterstack.md`, `docs/decisions/2026-11-01-observability-ownership.md` and its amendment `docs/decisions/2026-11-01-observability-gaps-and-launch-posture.md`.

## Decision table

| Question                 | Owner                                                                                                                                                                                    | Not            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Alive? Who is paged?     | Better Stack (monitors, `pingHeartbeat()` in `netlify/functions/cron-tick.mts`, the tick summary and its freshness alert, the backlog gauges, `emitTelemetryLog`, maintenance incidents) | Sentry         |
| Which code broke?        | Sentry (grouped issue, `job_run_id` tag, `cron-tick` check-in)                                                                                                                           | Better Stack   |
| What is the truth?       | Postgres (`SystemJobExecution` with `result.telemetry` and `result.failures`, owed markers, entity rows)                                                                                 | a log store    |
| What do I do about it?   | The back-office console (System Jobs, Run metrics, Entity trace, the read-only Stuck work page)                                                                                          | Sentry samples |
| Raw prints, vendor truth | Netlify logs, vendor dashboards                                                                                                                                                          |                |

## Rules

- **Every Better Stack event goes through `emitTelemetryLog` and its fixed schema.** `telemetryEventSchema` in `lib/observability/betterstack-telemetry.ts` is a strict Zod object; a new field is added there, never spread in from a caller's context. Messages, correlation ids and errors are scrubbed of email addresses. A `SystemEvent` mirror sends only its entity id (`entityIdOf` in `lib/observability/entity-id.ts`) and the run id.
- **A send never throws and never reaches Sentry.** It resolves to `sent`, `skipped`, `402` (quota or spending limit), `403` (bad source token), `5xx`, `network` or `other`, with a 2-second timeout. Inside a job run the outcomes are counted on the run row as `result.telemetry`; the ticker's own summary rejection is a log line and trips the freshness alert. At about 91,000 runs a month, one ingest outage reported to Sentry would spend the 5,000-error quota.
- **A backlog breach pages via Better Stack, not Sentry.** The eight oldest-pending-age gauges ride on the tick summary as `oldestPendingAgeS` (`lib/cron/pending-ages.ts`, inside the slot claim's probe transaction and budget): seven in one statement, and `parkedCaptures`, the seconds since the oldest parked, unreturned capture (0 when none), read through the Stuck work queue's own `PARKED_CAPTURE_WHERE`. Their limits are `PENDING_AGE_LIMITS_MS`; the alert definitions and the missing-data policy (money queues alert on missing data, the rest rely on the freshness alert) are owner steps in `docs/maintenance/00-betterstack-setup.md`. Never add a ticker target or a job for a gauge: the tick cap of 12 is full.
- **Do not add a Postgres per-item log table.** No `SystemJobRunItem`. Current state lives on the entity row.
- **Per-item history is the run row until traction.** `createRunFailureReporter().add()` also lists the failure in `result.failures` (`{ entityId, reason, attempt }`, at most 50, then `failuresOverflow`), validated in `lib/cron/run-telemetry.ts` and bounded by the 180-day prune. Put the entity id in the failure context as an `id` or `*Id` key and the attempt as `attempt`, `attempts` or `retryCount`; never a name or an email. Batched per-item Better Stack events are deferred by owner decision (a cost decision, revisited at traction).
- **Ids only, and the ids are still personal data.** A payment id resolves to a person (`Payment.userId` references `User`, and `readRootPayments()` in `lib/backoffice/entity-trace.ts` reads the customer's name), so events and failure lists are pseudonymous personal data under [DPDP §2(t)](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf), the same position `docs/observability/sentry/05-identity-and-triage.md` takes for the Sentry cuid. The EU region does not make them non-personal.
- **Per-item Better Stack events need a privacy assessment first.** When they are built, settle the processor entry, the privacy-notice disclosure, access and erasure handling, and retention, using the processor inventory in `docs/compliance/02-dpdp-and-privacy.md` (Data inventory, Gap #11) and the `compliance` skill.
- **India region.** Neither Better Stack (EU, US, Singapore) nor Sentry (US, EU) has one. If in-country telemetry is ever required, Grafana Cloud (AWS `ap-south-1`) and SigNoz Cloud both list India; compare them in section 7 of the research page.
- **Plans.** Better Stack stays on the free plan (3-day logs, email and Slack alerts) until launch; the responder seat and the Telemetry Nano bundle are a go-live checklist item.
- **Never send per-item events to Sentry** (Logs or spans). Quota and sampling make it wrong.

## Per-item event schema (DEFERRED)

When per-item Better Stack events are built, each carries these six fields, added to the fixed schema:

| Field       | Meaning                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `run_id`    | The `SystemJobExecution` id (the same value as the Sentry `job_run_id` tag). |
| `job`       | The registry job name.                                                       |
| `entity_id` | The id of the payment, booking, payout or other row. Id only; a pseudonym.   |
| `outcome`   | `ok`, `skipped`, `failed` or `held`.                                         |
| `reason`    | A short code such as `GATEWAY_TIMEOUT` or `LOST_CAS`.                        |
| `attempt`   | The attempt number read from the entity row.                                 |

`tick_id` and `duration_ms` are optional extras.

## Links

- `docs/observability/01-ownership-sentry-betterstack.md` and `docs/observability/02-research-per-item-history-and-vendors.md`
- `docs/decisions/2026-11-01-observability-ownership.md`, `docs/decisions/2026-11-01-observability-gaps-and-launch-posture.md`
- `docs/maintenance/00-betterstack-setup.md` (freshness alert, missing-data policy, gauge thresholds)
- `references/job-telemetry.md`, `references/entity-trace-and-console.md`
- Issues #2424, #2453, #2492, #2496
