---
name: observability
description: Work on this repo's error-tracking and telemetry subsystem — the Sentry wiring, the request-scoped user/org identity that makes an error attributable, the back-office issue lookup, the 30-minute ingest canary and its out-of-band alert, source-map upload, the action/job failure sink, and how to actually prove an event arrives (deploy-preview browser probes, raw envelope reads, the evidence ladder). Use when the user says "the error isn't showing up in Sentry", "Sentry isn't working", "which user hit this error", "no events in Sentry", "we lost that error", "error tracking", "observability", "telemetry", "triage an issue", "Sentry quota", "ingest", "canary", "alert on errors", "source maps", "user id on the event", or is touching sentry.shared.config.ts, lib/observability/, lib/backoffice/user-360.ts, jobs/observability/, app/api/cleanup/sentry-ingest-canary/, instrumentation.ts, netlify/functions/cron-tick.mts, or next.config.mjs's withSentryConfig block.
---

# Observability

The index for the error-tracking domain: how an event leaves a route, how it comes to name a person and an organisation, and how any of that is proven rather than assumed. The facts live in `docs/observability/sentry/`; this skill holds the doctrine and the decision procedure, and the money-adjacent consequences live under `/finance`.

| Reference                                                 | Purpose                                                                                                                                                                                                                                                | Read it when                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `references/diagnosing.md`                                | The branching procedure for "this event is wrong or missing" — is the code even reporting, is the SDK initialised, is Sentry accepting, is the identity attached — with the response that ends each branch.                                            | First, for any report of a missing, duplicated, unattributed or unverifiable error.           |
| `docs/observability/sentry/01-setup-and-configuration.md` | The DSNs, where the code lives, source maps and the `SENTRY_*` coordinates, and what does and does not reach Sentry today.                                                                                                                             | Before changing configuration, or when asked what is actually instrumented.                   |
| `docs/observability/sentry/02-conventions.md`             | Why a modelled refusal is a warning and not an error, which tags carry meaning, why `SystemEvent` is the row and Sentry the pager, why transient platform failures are breadcrumbs.                                                                    | Before adding a `throw`, a `reportSentry*` call, or a new tag.                                |
| `docs/observability/sentry/04-triage-runbook.md`          | The working routine for clearing an issue list.                                                                                                                                                                                                        | When asked to triage, prioritise or burn down the Sentry issue queue.                         |
| `docs/observability/sentry/05-identity-and-triage.md`     | Request-scoped user/org stamping and its DPDP obligations, the back-office lookup by `user.id`, the `dataCollection` allowlist, and why the identity is a stable cuid rather than an email.                                                            | Before changing what is attached to an event, or when adding a surface that reports errors.   |
| `docs/observability/sentry/06-ingest-canary.md`           | The canary and the 2026-09-22 quota outage that forced it: the six verdicts and the two that hide an outage, the two-header partial-outage trap, why it emails rather than reports, and why an upgrade clears the quota without waiting for the month. | When Sentry looks broken or empty, before concluding it is quiet, or when wiring any monitor. |
| `docs/observability/sentry/07-verifying-end-to-end.md`    | The evidence ladder, the deploy-preview probe procedure, the isolated-world trap, and how to state a verification claim honestly.                                                                                                                      | Before claiming an observability change is verified.                                          |

## Non-negotiables

An error must be attributable before it is debuggable, and nothing in this domain is verified until the evidence is named. Concretely, the following are not preferences.

**Name the rung of evidence you reached.** "The code calls `reportSentryError`" proves intent. "The envelope on the wire carried `user.id`" proves the SDK serialised the identity. "The event is queryable in Sentry" proves the lot. These are different claims with very different value, and collapsing them is how six days of dead error ingestion went unnoticed. `references/diagnosing.md` has the ladder and the procedure; `07` has the detail.

**Never hardcode a Sentry coordinate.** Organisation, project, API URL and web URL are read from the environment with a `||` default to the live project. Slugs, not ids — the two project ids in circulation are neither valid slugs. A new literal is a review failure, and a DSN literal in source is a history-rewrite failure.

**The org id is in the DSN host; the project id is the DSN's last path segment.** They are both sixteen digits and both in that one string, and the org's appears as `o<orgId>` in the host. A reader has already mistaken the org id for a project id here, and the dead project id from the 2026-09-20 mis-rotation shared its first ten digits with the org id so the two read as siblings. Slugs go in config; ids come out of the DSN; the CI guard's `EXPECTED_SENTRY_PROJECT_ID` is a non-secret repository **variable** for exactly this reason, and it is named the way it is because `LIVE_SENTRY_PROJECT` was ambiguous. `01` has the full four-way taxonomy.

**Unset token is off; empty token is broken on.** Gate token-using paths on presence, not truthiness of a configured-looking string. An empty `SENTRY_API_TOKEN` silently enables authenticated REST calls that fail every time.

**The SDK is not on `window`.** `sentry.shared.config.ts` deliberately keeps it off the global scope, so there is no `window.Sentry` to poke at and never will be. The observable surface is the HTTP layer, and the only reliable place to attach a listener is a `<script>` in the page's own main world — a DevTools-protocol evaluation runs in an isolated world where your injected `error` never reaches the page's listeners, which looks identical to "Sentry is not initialised".

**A 2xx from Sentry is not proof of acceptance, and acceptance is not proof of queryability.** The ingest canary treats `200` plus a drop notice as a distinct `dropped-despite-2xx` verdict precisely because Sentry does 2xx-and-drop. And read `x-sentry-rate-limits`: it names the limited categories and omits the healthy ones, so a working session or transaction stream is no evidence at all that errors are being taken. That partial outage is the 2026-09-22 incident.

**A monitor that cannot silence itself must fail open, and one that repeats must be gated.** The canary emails, because a check reporting through the failing system is not a check — which means it must also _cooldown_: one email per distinct state, re-armed on change, re-asserted daily. An alert nobody reads is the same as no alert. And its Redis-backed state fails **open**: a duplicate email costs a glance, a suppressed one costs an outage nobody was told about.

**A check that reports its own failure through the failing system is not a check.** The canary emails through Resend. If the monitor's first stop is the thing it monitors, the monitor is decorative.

**Modelled refusals are warnings.** A full webinar, a credit shortfall, a consent gate — a `BUSINESS_ERROR_CODES`-registered code is `expected: true`, gets re-levelled to warning by `beforeSend`, and must not be an error event. A quota is 5,000 errors a month on Developer; mislabelled business outcomes are how that gets spent in a day, and `INFRA_THROTTLE_MS` in the shared config exists because it happened on 2026-09-21.

**A repetition is throttled; a set is aggregated.** Throttle when one failure recurs (the evidence is one real stack trace; a count would have to be invented, and would under-report exactly when you are sizing an incident). Aggregate when one run found many distinct things (the set is the fact, the ids are the evidence). Never aggregate a repetition. And note that **grouping into one issue is not grouping into one event** — a shared `fingerprint` leaves N events costing N, which is how the ingest canary came to cost 8,640 events a month before its cadence was cut to 30.

**Never attach a person to a synthetic event.** The canary carries a fixed fingerprint so runs collapse into one issue, and carries no user, org, IP or URL. Test events are not evidence about anyone, and a stable user cuid is pseudonymous personal data with DPDP obligations attached — the disclosure sign-off is tracked in `05` and is not optional.

**The identity disclosure is opt-in and currently off.** `SENTRY_IDENTITY_ENABLED` must be exactly `on`; everything else, including `true`, `1`, `yes` and `ON`, is off, and the default is off. The code and all six call sites are in place and inert, so `Users: 0` is the expected state, not a bug. Do not "fix" a context that looks configured — verify the value is literally `on`. Turning it on is blocked on a DPDP determination, not on engineering: consent justifies the processing, and a cross-border transfer to a US region is a separate gate that only a legal answer closes.

**`SystemEvent` is the row; Sentry is the pager.** For money paths the database row is the truth and survives in `SystemEvent`; Sentry is the notification of it. When they disagree, believe the row. See `/finance`.

**Spans, metrics, and logs go through the shared PII scrubber.** In addition to `beforeSend` and `beforeSendTransaction`, `sentry.shared.config.ts` wires `beforeSendSpan` and `beforeSendLog` through `lib/observability/sentry-scrubber.ts` so span descriptions/attributes and structured `Sentry.logger.*` entries never leak raw PII (emails, phones, tokens, PAN/GSTIN, or gateway secrets). Money/booking/cron critical paths instrument latency and throughput via `Sentry.startSpan` and `Sentry.metrics` (`lib/observability/`). Server-side `console.error`/`console.warn` reach Netlify function logs outside Sentry's scrubber (`#1127`), so never log raw payloads or full Prisma error objects to `console.*`.

## Error budget guardrails (#1933)

### The incident (2026-09-23 to 2026-10-02)

Sentry ingested zero errors from 2026-09-23 until 2026-10-02 because the free Developer plan (`am3_f`) allows 5,000 errors per billing month and 5,428 had been used by 2026-09-22, mostly from the 2026-09-21 and 2026-09-22 Upstash incident flood. The billing period starts on the 19th, so the current one runs 2026-09-19 to 2026-10-18. Sentry answered every error envelope with HTTP 429 and the header `x-sentry-rate-limits: 60:default;error;security;attachment:organization:error_usage_exceeded`, while transactions, spans and logs kept being accepted, which is why the dashboards looked alive. A real production 500 in the Requests inbox left no Sentry trace at all, and only the Netlify function logs showed it. The diagnosis is the comment on issue #1933.

The ingest canary did not alert during the outage because it moved into `lib/cron/cleanup-registry.ts` in #1920 (it was not removed) and first reached production on 2026-10-02 through release #1925.

### How to diagnose next time

Climb the evidence ladder in this order. First, read the stats API, which separates `rate_limited`, `filtered` and `client_discard` from `accepted`: `/api/0/organizations/practitionist/stats_v2/?field=sum(quantity)&groupBy=outcome&groupBy=category&interval=1d&statsPeriod=14d`. Second, send one labelled probe envelope to the DSN endpoint and read the rate-limit header on the response. Third, read the quota from the organisation subscription. Fourth, confirm that only the error category stopped, because transactions and logs continuing to arrive is the signature of quota exhaustion rather than a broken DSN.

### Volume profile before the outage

The following table shows where the errors of the 30 days before the outage came from, and it is the reason the guardrails target floods rather than individual bugs.

| Source                            | Share of errors |
| --------------------------------- | --------------- |
| Upstash and CronLock floods       | 54%             |
| Prisma pool and connection errors | 10%             |
| Per-row repeats inside sweeps     | 29%             |
| Real bugs                         | about 5%        |
| Browser                           | 2%              |

The preview environment produced 15% of all errors, and a quiet month sits at roughly 1,500 errors.

### The guardrails shipped in #1938

The guardrails below keep real errors inside the allowance, and every one of them is a drop in `beforeSend` or a rule at the capture site, so a dropped event never counts against quota.

`sentry.shared.config.ts` applies its limits in the `beforeSend` budget stage. A per-key throttle lets the first event for each key through and then at most one per `INFRA_THROTTLE_MS` (ten minutes) per process, where the key is the exception type, the message with ids and numbers normalised away, and the top in-app frame. A per-process circuit breaker allows at most 30 events per rolling hour and logs a console warning when it opens; `fatal` events skip the breaker by owner decision, because a `WALLET_BALANCE_DRIFT` page must never lose to noise. The Upstash quota, cron lock (`cron-lock-unavailable`), Prisma pool exhaustion and `SystemEvent` write failures each get a fixed fingerprint family (`upstash-quota`, `prisma-pool-exhaustion`, `system-events-write-failed`), so one outage is one issue however many routes hit it. An `expected` event at level `info` is dropped, and `ignoreErrors` has a few extra entries. The throttle is in memory on purpose, because Redis is often the thing that is down.

The `sampleRate` is `NEXT_PUBLIC_SENTRY_ENVIRONMENT === "preview" ? 0.1 : 1`, so previews sample errors at 10% and every other environment, including one where the variable is unset (a bare job runner or a test), samples at 100%. An earlier version keyed on "not production" and silently dropped 90% of errors wherever the variable was unset. The variable is read instead of `NODE_ENV` because `NODE_ENV` is `production` on previews too.

Sweeps aggregate once per run in `settle-cancelled-sessions`, `retry-auto-refunds`, `expire-reschedule-proposals` and `reconcile-ledgers`; the freeze behaviour of the reconciler is unchanged, and drift still pages even if the first freeze throws. The cleanup-route catch-all is throttled per job. These guardrails sit next to the span and log scrubbing and the dead-letter alerting added in #1932 and the atomic cron lock added in #1935, and they do not replace either.

The rule for new code is to never capture per row. A loop that can fail on many rows keeps a per-row `console.error` that logs `scrubStringValue(message)` from `lib/observability/sentry-scrubber.ts` rather than the raw error, because console output bypasses Sentry's scrubber. It collects the failures and, after the loop, emits one `reportSentryError` with a stable `fingerprint` and `extra: { failed, sample }` holding the count and the first ten ids. A repetition of one failure is throttled and a set of distinct failures is aggregated, as the non-negotiables above describe.

The ingest canary also warns before the quota is gone, and it runs that check after the urgent ingest-down alert so that alert still fits inside the roughly 26 second function ceiling. When `SENTRY_STATS_TOKEN` (an `org:read` token) is set, each canary run reads the accepted error count for the current billing period and emails once per period when it reaches 70% of `SENTRY_ERROR_QUOTA` (default 5000). `SENTRY_QUOTA_PERIOD_START_DAY` (default 19) sets the day the period starts, and an unset token skips the check silently.

### Sentry-side state on 2026-10-02

The high-priority alert workflow 3606037 now filters on `environment: production`; in the new API it is a workflow at `organizations/practitionist/workflows/3606037/`, not an alert rule. Rule 6031144 (`pool_exhaustion`) is unchanged, spike protection is on, and the inbound filters for browser extensions, web crawlers, React hydration errors, chunk-load errors and legacy browsers are on. A DSN key rate limit of 30 per hour was attempted and is silently ignored on the free plan, because the PUT returns 200 while `rateLimit` stays null. Inbound error-message filters for the flood families were deliberately not added, because they would drop the first event as well and blind a real outage like 2026-09-25.

### Still to do (owner)

The owner still has to create an `org:read` Sentry token and set `SENTRY_STATS_TOKEN` on Netlify production, with the optional `SENTRY_QUOTA_PERIOD_START_DAY` and `SENTRY_ERROR_QUOTA`. In one to two months the owner plans to upgrade to the Team plan (US$26 a month billed annually, 50,000 errors, pay-as-you-go), and at that point the DSN key rate limit and the 10% preview sample should be revisited. Issue #1933 stays open until then.

For the email map, the pre-launch delivery guard and ops alert routing, see [docs/email/README.md](../../../docs/email/README.md).
