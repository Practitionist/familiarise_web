# The ingest canary

Everything on this page exists because of one incident, and the incident is the reason to read it.

## What happened

On 2026-09-22 the organisation's error allowance for the billing period was spent. Sentry had answered `200 {}` for every envelope for six days afterwards, the app was healthy, deploys were green, the cron jobs were quiet — and the error stream was empty. Nothing in the product, in CI, or in the deploy pipeline could tell, because the thing that reports on errors is the thing that had stopped working.

The cause is on the record in `sentry.shared.config.ts`: on 2026-09-21 the Upstash request cap (`ERR max requests limit exceeded. Limit: 500000`) put 2,147 `UpstashError` events and roughly 900 `CronLockUnavailableError` events through the Developer plan's 5,000-error allowance in 24 hours. The `INFRA_THROTTLE_MS` guard was added that day to stop a repeat, and it worked — but the allowance for the period was already gone, and a throttle cannot un-spend it.

## What Sentry actually did

```
HTTP/1.1 429 Too Many Requests
retry-after: 60
x-sentry-rate-limits: 60:default;error;security;attachment:organization:error_usage_exceeded

{"detail":"Sentry dropped data due to a quota or internal rate limit being reached.
 This will not affect your application."}
```

Three properties of that response make it the worst failure mode an error tracker has, and each one is why the canary is shaped the way it is.

**The SDK is well behaved.** It drops the event, honours `retry-after`, and surfaces nothing to the application. There is no exception, no log line, no non-2xx in the app. A health check on the application proves nothing about the error stream.

**Only some categories are limited.** The header names `error`, `security` and `attachment`. It does **not** name `session`, `transaction` or `log`. So the dashboard kept showing current data — the span-derived `N+1 Query` issues went on updating hourly for days — while every error issue sat frozen with `last seen: 6 days ago`. A glance reads as "healthy, just quiet", which is the most expensive possible misreading. Confirming this took two probes: on the same page load, the `session` envelope returned `200` and the `event` envelope returned `429`.

**The dashboard cannot be the check.** Any test of the form "did the canary event appear in the UI" fails precisely when it is needed. The canary therefore asserts on the ingest _response_, which is still available when storage is not.

## The canary

`lib/observability/ingest-canary.ts` posts one real, minimal error envelope at Sentry's envelope endpoint and classifies the response.

| Verdict               | Meaning                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `accepted`            | 2xx with no drop notice. Error events are being taken.                                                   |
| `dropped-despite-2xx` | 2xx, but the body says the data was dropped. Sentry does this.                                           |
| `rate-limited`        | 429. Read `x-sentry-rate-limits` to separate a short-window throttle from an exhausted period allowance. |
| `rejected-auth`       | 401/403, or no parseable DSN. The DSN or public key is wrong.                                            |
| `unavailable`         | 5xx, or the request never completed. Sentry is unwell or unreachable.                                    |

`isIngestHealthy()` is true for `accepted` and nothing else — in particular a 2xx alone is not sufficient, because `dropped-despite-2xx` exists and is the case that hid this for six days.

### Three decisions, each forced by the incident

**A raw `fetch`, not the SDK.** `Sentry.captureException` followed by `flush()` cannot answer this question. `flush()` returns a boolean, not a reason, and a dropped event is indistinguishable from a delivered one from the caller's side. The ingest response — status, `x-sentry-error`, `x-sentry-rate-limits`, body — is the only evidence available while ingest is broken.

**The endpoint is derived from the DSN, never hardcoded.** `envelopeEndpointFromDsn()` parses `NEXT_PUBLIC_SENTRY_DSN` for the public key, host and project id. The host is used **verbatim**: Sentry Cloud DSNs already carry the collector subdomain (`o<orgId>.ingest.<region>.sentry.io`) and a self-hosted DSN points straight at its collector. An earlier draft prepended `ingest.` when the host did not _start_ with it, which produced a host with the label in the middle, `ingest.o<orgId>.ingest.<region>.sentry.io` — the label sits mid-host, not at the front. That resolves to nothing, and the failure mode is a bare DNS `fetch failed` rather than an HTTP status, so a unit test written against the same wrong logic passed while the probe was broken. Only running it live found it.

**It emails; it never reports to Sentry.** A check that reports its own failure through the failing system is not a check. `lib/observability/ingest-alert.ts` sends through Resend to `OBSERVABILITY_ALERT_EMAIL`, defaulting to the platform support mailbox — a separate quota, a separate provider and a separate failure mode. The message carries the verdict, the status, the event id, the raw rate-limit header, and the remedy, because the reader is looking at a dashboard that looks healthy and cannot derive the fix from what they can see.

### Wiring

| Piece         | Path                                            |
| ------------- | ----------------------------------------------- |
| Probe         | `lib/observability/ingest-canary.ts`            |
| Alert         | `lib/observability/ingest-alert.ts`             |
| HTTP twin     | `app/api/cleanup/sentry-ingest-canary/route.ts` |
| Bare-Node job | `jobs/observability/sentry-ingest-canary.ts`    |
| Ticker target | `netlify/functions/cron-tick.mts` → `TARGETS`   |

The HTTP twin uses the shared `cleanupRoute` factory rather than hand-rolling the bearer check, maintenance guard and cron lock, so it inherits the `CRON_SECRET` gate, `withCronLock` and the `CronLockUnavailableError` backstop that every other job has. It sits in `TARGET_EVERY_MINUTES` at **30 minutes**, not on the default five-minute tick, and that is a quota decision rather than an operational one. The canary posts a real _stored_ event every run, so cadence is a direct line item on the error allowance: five minutes is 288/day, 8,640/month, which is **173% of the Developer plan's 5,000 included errors** — the health check alone would exhaust the budget it exists to protect. Thirty minutes is 48/day, 1,440/month (2.9% of Team, 29% of Developer). The 25 minutes of detection latency this gives up is close to free, because the alert email fires on the _failing_ run, and the healthy runs being removed were the ones that could not do anything about anything. It costs one HTTPS round trip to a vendor and no Redis, so unlike the other targets it has no per-tick lock cost to amortise. It reports `503` when unhealthy, so the ticker's `failed` list separates "the route is broken" from "its subject is broken".

The canary event carries a **fixed fingerprint**, so half-hourly runs collapse into one issue with a count rather than hundreds of near-identical issues, and it carries **no user, org, IP or URL**. It is an infrastructure probe and must never become a record about a person.

## Running it by hand

```bash
# Through the job, which is the same code path the ticker drives.
npx tsx -r dotenv/config jobs/observability/sentry-ingest-canary.ts

# Or through the HTTP twin.
curl -sS -X POST https://<site>/api/cleanup/sentry-ingest-canary \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```

A healthy body is `{"healthy":true,"verdict":"accepted","status":200,...}`. An unhealthy one is `503` with `verdict`, `detail` and `alerted`.

Verified live against the exhausted quota on 2026-09-28, which is the only test of this thing that proves anything:

```
verdict    : rate-limited
status     : 429
healthy    : false
rateLimits : 60:default;error;security;attachment:organization:error_usage_exceeded
```

## The remedy, and why you do not have to wait for the month

The quota is measured against the plan's **included volume**, not against a counter that resets independently of the plan. Upgrading therefore raises the ceiling immediately — the usage already spent is under the new number, and `error_usage_exceeded` clears on the next event. Developer is 5,000 errors/month; Team is 50,000 at $26/mo, and also brings 90-day retention instead of 30 and the `event:read` REST scope that `lib/observability/sentry-issues.ts` needs. So the sequence is: upgrade, then re-run the canary and confirm `healthy: true`. There is no need to wait for the period to roll over.

## The standing risk

The canary is wired, but the underlying fragility is unchanged: a 5,000-error monthly allowance is smaller than a single 24-hour dependency outage, and the whole system depends on that allowance never being exhausted. The throttle in `sentry.shared.config.ts` bounds the damage from a _known_ pattern and does so deliberately: `INFRA_THROTTLE_MS` is ten minutes, keyed by error **class** and not by route, and process-local rather than Redis-backed, because Redis _is_ the outage being guarded — a shared limiter needs the downed dependency to answer, and must then either fail open (restoring the firehose) or fail closed (dropping legitimate errors). The resulting bound is warm instances × 6 events/hour/class, against ~3,000/hour unthrottled. Two limits follow from that design and are worth stating plainly. A flood that is _diverse_ rather than repetitive is bounded per class, so the ceiling scales with the number of distinct classes. And a server-side dashboard filter — dropping at ingest, before quota is spent — is the acknowledged follow-up and is not yet built.

Two things would close this further and neither is done: a Sentry alert on the canary's own issue (which fails silently for the same reason everything else did, so it needs an external channel too), and routing error events to a second sink — `system_events` in Postgres already holds the audit row for money paths, and `lib/observability/betterstack-telemetry.ts` already has an out-of-band path that is currently disabled.
