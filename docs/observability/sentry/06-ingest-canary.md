# The ingest canary

Everything on this page exists because of one incident, and the incident is the reason to read it.

## What happened

On 2026-09-22 the organisation's error allowance for the billing period was spent. For six days afterwards Sentry answered **`429` to the `error` item of every envelope while answering `200` to its `session` and `transaction` items** — the app was healthy, deploys were green, the cron jobs were quiet, and the error stream was empty. Nothing in the product, in CI, or in the deploy pipeline could tell, because the thing that reports on errors is the thing that had stopped working. The partial nature of the failure is the reason it was invisible: the dashboard kept receiving data, just not errors.

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

| Verdict               | Meaning                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted`            | 2xx with no drop notice. Error events are being taken.                                                                                                                                         |
| `dropped-despite-2xx` | 2xx, but the body says the data was dropped. Sentry does this.                                                                                                                                 |
| `rate-limited`        | 429. Read `x-sentry-rate-limits` to separate a short-window throttle from an exhausted period allowance.                                                                                       |
| `rejected-auth`       | 401/403. Sentry saw the DSN and refused it — wrong project or revoked key.                                                                                                                     |
| `unconfigured`        | No DSN in the runtime, so nothing was ever sent and the SDK never initialised. Distinct from `rejected-auth` on purpose: nothing was rejected, and the fix is configuration rather than a key. |
| `unavailable`         | 5xx, or the request never completed. Sentry is unwell or unreachable.                                                                                                                          |

`isIngestHealthy()` is true for `accepted` and nothing else — in particular a 2xx alone is not sufficient, because `dropped-despite-2xx` exists and is the case that hid this for six days.

### Three decisions, each forced by the incident

**A raw `fetch`, not the SDK.** `Sentry.captureException` followed by `flush()` cannot answer this question. `flush()` returns a boolean, not a reason, and a dropped event is indistinguishable from a delivered one from the caller's side. The ingest response — status, `x-sentry-error`, `x-sentry-rate-limits`, body — is the only evidence available while ingest is broken.

**The endpoint is derived from the DSN, never hardcoded.** `envelopeEndpointFromDsn()` parses `NEXT_PUBLIC_SENTRY_DSN` for the public key, host and project id. The host is used **verbatim**: Sentry Cloud DSNs already carry the collector subdomain (`o<orgId>.ingest.<region>.sentry.io`) and a self-hosted DSN points straight at its collector. An earlier draft prepended `ingest.` when the host did not _start_ with it, which produced a host with the label in the middle, `ingest.o<orgId>.ingest.<region>.sentry.io` — the label sits mid-host, not at the front. That resolves to nothing, and the failure mode is a bare DNS `fetch failed` rather than an HTTP status, so a unit test written against the same wrong logic passed while the probe was broken. Only running it live found it.

**It emails; it never reports to Sentry.** A check that reports its own failure through the failing system is not a check. `lib/observability/ingest-alert.ts` sends through Resend to `OBSERVABILITY_ALERT_EMAIL`, defaulting to the platform support mailbox — a separate quota, a separate provider and a separate failure mode. The message carries the verdict, the status, the event id, the raw rate-limit header, and the remedy, because the reader is looking at a dashboard that looks healthy and cannot derive the fix from what they can see.

The same rule has to hold one level up, and that is what `reportableToSentry()` in `netlify/functions/cron-tick.mts` is for. The canary runs as a target of the ticker, so when it reports a failing run with a `503` the ticker's own failure path would dutifully report "cron failed: sentry-ingest-canary" — to Sentry. The filter drops the canary from that report and from nothing else: it stays in the tick's `failed` list, keeps its own status and body, and is written to the job-execution history, so the tick's visibility is untouched and only the Sentry write is suppressed. Suppression there is the same call as the email alert's, reaching it the other way round: the alert email fails _open_, so this outage can never silence its own alarm.

### Wiring

| Piece         | Path                                            |
| ------------- | ----------------------------------------------- |
| Probe         | `lib/observability/ingest-canary.ts`            |
| Alert         | `lib/observability/ingest-alert.ts`             |
| HTTP twin     | `app/api/cleanup/sentry-ingest-canary/route.ts` |
| Bare-Node job | `jobs/observability/sentry-ingest-canary.ts`    |
| Ticker target | `netlify/functions/cron-tick.mts` → `TARGETS`   |

The HTTP twin uses the shared `cleanupRoute` factory rather than hand-rolling the bearer check, maintenance guard and cron lock, so it inherits the `CRON_SECRET` gate, `withCronLock` and the `CronLockUnavailableError` backstop that every other job has. It sits in `TARGET_EVERY_MINUTES` at **30 minutes**, not on the default five-minute tick, and that is a quota decision rather than an operational one. The canary posts a real _stored_ event every run, so cadence is a direct line item on the error allowance: five minutes is 288/day, 8,640/month, which is **173% of the Developer plan's 5,000 included errors** — the health check alone would exhaust the budget it exists to protect. Thirty minutes is 48/day, 1,440/month (2.9% of Team, 29% of Developer). The 25 minutes of detection latency this gives up is close to free, because the alert email fires on the _failing_ run, and the healthy runs being removed were the ones that could not do anything about anything. The probe itself has no Redis dependency — it posts one HTTPS envelope with an injected `send` — but the path around it does: the cron lock (`withCronLock`) and the alert cooldown (issue 3 below) are both Redis-backed, so it is not lock-free relative to the other targets. It reports `503` when unhealthy, so the ticker's `failed` list separates "the route is broken" from "its subject is broken".

The canary event carries a **fixed fingerprint**, so half-hourly runs collapse into one issue with a count rather than hundreds of near-identical issues, and it carries **no user, org, IP or URL**. It is an infrastructure probe and must never become a record about a person.

## The alert has a cooldown, on purpose

`sendSentryIngestAlert` has no throttle of its own, so without a gate the canary emails the same content on every failing run — **48 identical emails a day** at the 30-minute cadence. An alert nobody reads is the same as no alert, which reintroduces through the front door the exact outcome this canary exists to prevent.

`canaryAlertNeeded` sends **one email per distinct state**, re-armed the moment the state changes, and re-asserted at most once per **24 hours** so a week-long outage does not go silent after its first email. A change from `rate-limited` to `rejected-auth` alerts immediately, because that changes what the operator should do. The route reports `alertSuppressed` alongside `alerted`, because "told them" and "told them recently" are different things to see in a log.

Two decisions in there are forced by the runtime rather than chosen, and both are the opposite of what the rest of this page does:

**The cooldown is armed only by a send that actually landed.** `canaryAlertNeeded` is a pure read; `recordCanaryAlertSent` does the write and the route calls it _after_ `sendSentryIngestAlert` returns true. This separation is the fix for a bug that shipped in the first version, where the read and the write happened together before the send was attempted: one failed delivery — the email provider down — armed a 24-hour suppression for a verdict nobody had been told about, and the canary went quiet about broken ingest for a day. That is the exact failure this mechanism exists to prevent, reached by the alerting itself. Both remaining failure modes cost a duplicate email rather than a missed alert: a send that succeeds and a cooldown write that then fails, and two healthy runs racing.

**The state lives in Redis, not in a module variable.** A 30-minute cron against serverless functions means the process is almost certainly cold, so an in-memory value is reset before the next run and the gate would suppress nothing. The _probe_ still has no Redis dependency — it runs and reports regardless — and only suppression consults it. `lib/redis`'s circuit breaker means a walled-off Redis fails fast rather than adding latency to a check whose job is to be fast.

**It fails open.** If the store is unreachable, the answer is "send". A duplicate email costs a glance; a suppressed one costs an outage nobody was told about. This is the one place in the canary where a skip is the dangerous direction, and it is the same reasoning that makes `notify-ops-failure.sh` refuse to skip its own check: a sink that can silently skip is a dead sink nobody sees. The store's error is logged rather than swallowed, so a gate that has silently degraded to permanently-off is still visible.

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

## Mass events: what each one costs

The question "should we merge or group them" has three different answers depending on which knob is meant, and confusing them is how a reporting mechanism becomes the outage. Measured against the 5,000-error Developer allowance:

| Mechanism                               | Events it costs        | What survives                                                       |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| Report every occurrence                 | N                      | everything, and nothing left in the budget                          |
| Shared `fingerprint` (one issue)        | **N** — still N events | grouping in the UI only; the count is real, the budget is not saved |
| **Throttle** (`INFRA_THROTTLE_MS`)      | ~144/day/class         | one genuine event per window, with a real stack trace               |
| **Aggregate** (a set, not a repetition) | 1 per run              | the count and the ids, in `extra`                                   |
| Raise the plan                          | n/a                    | all of it                                                           |

**Grouping into one issue is not grouping into one event.** A shared fingerprint is the cheapest-looking option and it saves nothing: the canary uses one, and each run still costs a stored event. That is precisely how the canary came to cost 8,640 events a month — 173% of the Developer allowance — before it was moved to a 30-minute slot. Only sending fewer _events_ reduces the bill.

**A repetition is throttled, a set is aggregated.** The rule and the reasoning are on the conventions page (`02`), because it is a decision rule rather than a fact about this deployment. The short version: throttle when one failure is happening again and again, because the evidence is one real stack trace and a count you would have to invent; aggregate when one run found many distinct things, because the set is the fact and the ids are the evidence. Aggregating a repetition is the mistake — it replaces a real trace with a number the code computed by discarding events, and that number under-reports exactly when you are trying to size the incident.

## The standing risk

The canary is wired, but the underlying fragility is unchanged: a 5,000-error monthly allowance is smaller than a single 24-hour dependency outage, and the whole system depends on that allowance never being exhausted. The throttle in `sentry.shared.config.ts` bounds the damage from a _known_ pattern and does so deliberately: `INFRA_THROTTLE_MS` is ten minutes, keyed by error **class** and not by route, and process-local rather than Redis-backed, because Redis _is_ the outage being guarded — a shared limiter needs the downed dependency to answer, and must then either fail open (restoring the firehose) or fail closed (dropping legitimate errors). The resulting bound is warm instances × 6 events/hour/class, against ~3,000/hour unthrottled, and that ~144/day is the **admitted** count, not the number of occurrences: the other 143 may or may not have happened, and the throttle deliberately declines to claim otherwise. Two limits follow from that design and are worth stating plainly. A flood that is _diverse_ rather than repetitive is bounded per class, so the ceiling scales with the number of distinct classes. And a server-side dashboard filter — dropping at ingest, before quota is spent — is the acknowledged follow-up and is not yet built.

Two things would close this further and neither is done: a Sentry alert on the canary's own issue (which fails silently for the same reason everything else did, so it needs an external channel too), and routing error events to a second sink — `system_events` in Postgres already holds the audit row for money paths, and `lib/observability/betterstack-telemetry.ts` already has an out-of-band path that is currently disabled.
