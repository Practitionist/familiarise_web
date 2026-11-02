# The ingest canary

The ingest canary answers one question: **is Sentry storing our errors, or throwing them away?** It is the only check that can catch an exhausted error quota, because an exhausted quota looks exactly like a quiet day.

## Why it exists

On 2026-09-22 the organisation's error allowance for the billing period was spent. For six days Sentry answered `429` to the `error` item of every envelope while still answering `200` to its `session` and `transaction` items. The app was healthy, deploys were green, the cron jobs were quiet, and the error stream was empty. The SDK behaved as designed: it dropped each event, honoured `retry-after` and told the application nothing. Spans and logs kept arriving, so the dashboard looked alive while every error issue sat frozen.

Three facts from that incident shape the canary:

- **A health check on the application proves nothing about the error stream.** The SDK never surfaces a drop.
- **The dashboard cannot be the check.** "Did the canary event appear" fails exactly when it is needed.
- **The alert cannot go through Sentry.** A check that reports its own failure through the failing system is not a check.

## How it works today

The canary is the registry job `sentry-ingest-canary` in `lib/cron/cleanup-registry.ts`, dispatched by the ticker once a day at 00:50 UTC (06:20 IST; `TARGET_EVERY_MINUTES` is 1,440 and the offset is 50 in `lib/cron/schedule.ts`). It sends **no event to Sentry**. Instead it reads the organisation's error outcomes for the last day from Sentry's usage stats API:

```
GET {SENTRY_API_URL}/api/0/organizations/{SENTRY_ORG}/stats_v2/
    ?category=error&field=sum(quantity)&statsPeriod=1d&groupBy=outcome&groupBy=reason
Authorization: Bearer {SENTRY_STATS_TOKEN}
```

The answer is a list of groups, one per outcome and reason pair, each with a `totals["sum(quantity)"]` count (Sentry API reference, "Retrieve Event Counts for an Organization (v2)"). `judgeStats` in `lib/observability/ingest-canary.ts` parses it with Zod and classifies it:

| Verdict            | When                                                                                                                                                                        | Pages? |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `accepted`         | No group with a non-zero count has outcome `rate_limited` or reason `usage_exceeded` / `error_usage_exceeded`.                                                              | No     |
| `rejecting`        | At least one such group. The quota case is reason `error_usage_exceeded`; Spike Protection and short-window throttles also show as `rate_limited`, with a different reason. | Yes    |
| `stats-unreadable` | The request failed, answered non-2xx, timed out after 8 seconds, or returned a body that does not match the schema. Ingest health is unknown.                               | Yes    |

`client_discard` groups (`before_send`, `sample_rate`, `network_error`, `ratelimit_backoff`) are the SDK's own drops. They never page, because most are deliberate.

A worked example from the live organisation, read on 2026-10-31 over 30 days: `accepted/none` 276, `rate_limited/error_usage_exceeded` 6,639, and four `client_discard` reasons (`network_error` 1,077, `ratelimit_backoff` 746, `before_send` 440, `sample_rate` 172). A one-day read with the 6,639 rejections in it would be `rejecting` with the quota remedy. A day holding only the 276 accepted errors and the discards would be `accepted`.

### What it does with a verdict

| Verdict                           | Route answer | Run row                                                                    | Alert                                                    |
| --------------------------------- | ------------ | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| `accepted`                        | 200          | `COMPLETED`; the canary takes a fail-open lease, so every run writes a row | None                                                     |
| `rejecting` or `stats-unreadable` | 503          | `FAILED`; the tick also lists it under `failed`                            | Email, Better Stack error line, ops chat mirror          |
| `SENTRY_STATS_TOKEN` unset        | 200          | `CANCELLED`, outcome `skipped`, reason `SENTRY_STATS_TOKEN not configured` | None. It is a config skip, listed by `/api/health/jobs`. |

`sendSentryIngestAlert` in `lib/observability/ingest-alert.ts` sends on two independent channels at once:

- **Email** through `deliver()` to `OBSERVABILITY_ALERT_EMAIL`, falling back to the support mailbox. Resend is a separate provider with a separate quota.
- **Better Stack**, as one log line through `emitTelemetryLog` at level `error` with the message `sentry-ingest-canary unhealthy` and the verdict, accepted count and rejections as fields. A Better Stack alert matching that message pages on the same event. The line needs `ENABLE_BETTERSTACK_TELEMETRY=true` and the source token, like every other telemetry line.

When the email is taken, the same text is mirrored to `SLACK_OPS_WEBHOOK_URL` if it is set. The remedy is chosen per case, because the wrong action is worse than no alert: a spent allowance is told to triage or raise the plan, a throttle is told it clears on its own and not to buy a plan, and an unreadable read is told to check the token, the API URL and the organisation slug.

There is no cooldown. The job runs once a day, so an outage that lasts a week sends one reminder a day, and an operator who re-runs it by hand from the System Jobs page gets a fresh answer.

After the verdict, the same run calls `checkSentryQuota` (`lib/observability/quota-alert.ts`), which emails once per billing period when accepted errors pass 70 % of `SENTRY_ERROR_QUOTA`. It uses the same token, and its failure never changes the canary's verdict.

Because every run writes a row, `/api/health/jobs` judges the canary like any other paging target (a budget of 30.5 hours). A `FAILED` run does not count as having run, so if Sentry keeps rejecting events for longer than that budget the probe answers 503 as well; by then the canary's own email has fired twice and the signal pipeline is still broken. The canary's own 503 never reaches Sentry: `reportableToSentry()` in `netlify/functions/cron-tick.mts` keeps it out of the ticker's escalation, while it stays in the tick's `failed` list and in its run row.

### The token

`SENTRY_STATS_TOKEN` is **an Internal Integration token (Organization: Read)**, which grants the `org:read` scope the endpoint needs (it accepts `org:read`, `org:write` or `org:admin`). An organization auth token does not work, because it only carries `org:ci`. It is a runtime key for the production Netlify context. It is not `SENTRY_AUTH_TOKEN`, the build-time token that uploads source maps. `SENTRY_API_URL` defaults to `https://us.sentry.io` and `SENTRY_ORG` to `practitionist`.

## Running it by hand

```bash
curl -sS -X POST https://<site>/api/cleanup/sentry-ingest-canary \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```

A healthy body is `{"healthy":true,"verdict":"accepted","accepted":<n>,"rejections":[],...}`. An unhealthy one answers 503 with `verdict`, `rejections`, `detail` and `alerted`. The admin Run door on the System Jobs page runs the same code in-process.

## The remedy, and why you do not have to wait for the month

The quota is measured against the plan's included volume. Upgrading raises the ceiling at once: the usage already spent sits under the new number, and `error_usage_exceeded` clears on the next event. Developer is 5,000 errors a month; Team is 50,000. So the sequence is: upgrade, then confirm recovery with the same `stats_v2` read at `statsPeriod=1h`. Re-running the canary is not enough: its one-day window still holds the earlier rejections, so it can stay unhealthy for up to a day after the fix.

## Mass events: what each one costs

Measured against the 5,000-error Developer allowance:

| Mechanism                               | Events it costs        | What survives                                                       |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| Report every occurrence                 | N                      | everything, and nothing left in the budget                          |
| Shared `fingerprint` (one issue)        | **N**, still N events  | grouping in the UI only; the count is real, the budget is not saved |
| **Throttle** (`INFRA_THROTTLE_MS`)      | about 24 a day a class | one genuine event per window, with a real stack trace               |
| **Aggregate** (a set, not a repetition) | 1 per run              | the count and the ids, in `extra`                                   |
| Raise the plan                          | n/a                    | all of it                                                           |

**Grouping into one issue is not grouping into one event,** and an issue marked "ignored" still counts against the quota. Only sending fewer events reduces the bill. **A repetition is throttled, a set is aggregated;** the rule is on the conventions page (`02`).

## A quota drops every error, whatever its level

Once the allowance is spent, Sentry rejects the whole `error` category at ingest. Raising an event to `fatal` or fingerprinting it does nothing, because the throttle and the level only decide which events the SDK sends.

- **Absence of an error is not evidence of health while the quota is spent.** Before treating silence as good news, read the canary's last run, or the same `stats_v2` query by hand.
- **An alert whose only sink is Sentry fails with the quota.** `scripts/ci/notify-ops-failure.sh` posts to Slack first and falls back to a Sentry envelope, which Sentry answers 2xx and then drops. Provision `SLACK_OPS_WEBHOOK_URL`.

## The standing risk

A 5,000-error monthly allowance is smaller than one 24-hour dependency outage. Three things bound it today: the process-local throttle and breaker in `sentry.shared.config.ts`, the escalations-only policy (`00-system-design.md` section 5), and **Spike Protection, which is on for the project**. The canary does not prevent exhaustion; it makes it visible within a day, on channels that do not depend on Sentry.

The alert email's routing, sender and Slack mirror are described in [Email at Familiarise](../../email/README.md).

## Deprecated & Superseded Approaches

- **Posting a real error envelope as the probe** (to 2026-10-31): each run was a stored event, about 120 a month at a six-hour cadence, and "ignored" did not stop it counting. The stats read costs nothing against the quota. Delete any `envelopeEndpointFromDsn`, `buildErrorEnvelope` or `SentryIngestCanary` residue.
- **A Redis-backed alert cooldown** (`canaryAlertNeeded`, `recordCanaryAlertSent`, key `observability:canary:last-alerted-verdict`): needed when the canary ran every six hours; a daily run is its own reminder cadence. The key can be left to expire.
- **A five-minute, then six-hour cadence**: five minutes alone exceeded the monthly allowance. It runs once a day.
