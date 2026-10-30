# ADR: Sentry escalations only

- **Status**: Accepted (owner decisions of 2026-10-30, implemented 2026-10-31).
- **Date**: 2026-10-31
- **Author**: Platform engineering
- **Related**: [Observability system design](../observability/00-system-design.md) (the noise policy section), [The ingest canary](../observability/sentry/06-ingest-canary.md), [Architecture at scale review](2026-10-30-architecture-at-scale-review.md), issue #2466

## Context

The free Sentry Developer plan stores 5,000 errors a month for every environment together. In the 7 days to 2026-10-31, **193 errors were accepted, about 28 a day**, or roughly 840 a month. Little of that called for a person to act. The 2026-10-30 investigation sorted the 30-day stored events into classes:

| Class                                                   | Share of stored errors | Action needed?                    |
| ------------------------------------------------------- | ---------------------- | --------------------------------- |
| Schema drift: code ahead of the shared database         | 55 %                   | Yes; fixed by the release gate    |
| The ingest canary's own probe event                     | 17 %                   | No, by design                     |
| Stream sweep bugs fixed on `dev`                        | 9 %                    | Yes; fixed by the release         |
| Config skips and standing business findings             | about 8.5 %            | No; configuration or a work queue |
| One-off ticker target failures (network or Netlify 5xx) | about 4 %              | No; the next tick retries         |

An issue marked "ignored" still counts against the quota, and a shared fingerprint groups events without saving any. Only sending fewer events helps.

## Decision

A Sentry event means "a person must act now". Everything else is a log line, a run row or a `SystemEvent`.

1. **Ticker one-offs go to logs only.** `alertFailedTargets` in `netlify/functions/cron-tick.mts` sends an error only when `isRepeatedFailure` says the target has had no `COMPLETED` run for three cadences. A one-off writes a `cron-tick.target-failed-once` log line.
2. **Config skips stay out of Sentry.** `reportConfigSkip` only logs; the run row stores outcome `skipped` with the reason, and `/api/health/jobs` lists the last day's skips. The `CONSUMER_INVOICE_MINT_DISABLED` warning is gone, because `heal-consumer-invoices` records the same gap as a skip. `AUTH_CAPTCHA_DISABLED` stays a Sentry Logs line, which uses no error quota.
3. **Standing business findings are `SystemEvent` rows** for the console: orphaned-confirmation channel skips, Stream membership removals and brakes, and the 72-hour needs-human session queue. Money-integrity drift (wallet and ledger) still pages Sentry once per new id set through `reportStandingFinding`.
4. **The canary reads usage stats instead of sending an event.** It reads `stats_v2` once a day with `SENTRY_STATS_TOKEN` (an organization token with `org:read`). It alerts by email and by an error-level Better Stack log line on any `rate_limited` outcome or `usage_exceeded` / `error_usage_exceeded` reason, and when the read fails. An unset token is a config skip.
5. **Preview deploys send no error events.** `beforeSend` drops every event when `NEXT_PUBLIC_SENTRY_ENVIRONMENT` is `preview`. Netlify sets that value per deploy context and Next inlines it into the server, edge and client bundles.
6. **Spike Protection is on** for the project.
7. **Seed data never reaches the needs-human queue.** The payments seed marks paid past sessions `COMPLETED` with outcome `HELD`, so a fresh database cannot raise the 72-hour finding (Sentry WEB-86).

## Consequences

- The canary alone saves about 120 stored events a month, and previews about 46 a month at the October rate.
- An ordinary preview error is visible only in the Netlify function log. A preview that needs Sentry should use the documented alternative below.
- A platform blip that happens once is visible in the logs, the tick summary and Better Stack, never as a new Sentry issue. A broken job still pages within three of its cadences.
- The success measure is under 1,000 stored errors in 30 days with no schema-ahead events across two releases. It is checked with the same `stats_v2` read the canary uses.

## Alternatives considered

- **A second Sentry project for previews.** It keeps preview errors visible without touching the production quota. Not adopted, because previews mostly repeat what production shows. Adopt it if preview debugging needs Sentry and the quota is affordable.
- **A second cron monitor as the canary.** The Developer plan has one monitor, and `cron-tick` holds it.
- **Keeping one-offs as a grouped warning.** It cost no new issue, but every one-off still spent quota.

## Deprecated & Superseded Approaches

- The grouped `target-failed-once` warning, the six-hourly envelope probe with its Redis cooldown, the 10 % preview sampling with its warning filter, and the once-a-day config-skip warning are all removed. Delete any residue that refers to them.
