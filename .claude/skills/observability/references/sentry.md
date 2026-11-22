# Sentry: setup, quota posture, conventions, the canary and proof of arrival

Read this before changing what reaches Sentry, how much of it does, or before claiming that an event arrived. The whole-subsystem picture is `docs/observability/00-system-design.md`; the per-topic facts are in `docs/observability/sentry/`.

## Setup

- `sentry.shared.config.ts` holds the single initialiser, `initSentry()`, and every policy hook: `beforeSend`, `beforeBreadcrumb`, `beforeSendTransaction`, `beforeSendSpan`, `beforeSendLog`, the route-aware `tracesSampler` and the error budget (`applyErrorBudget`). `sentry.server.config.ts`, `sentry.edge.config.ts` and `instrumentation-client.ts` each call it for their runtime.
- `instrumentation.ts` registers the server hooks and exports `onRequestError`, which captures and then hands a flush to Next's `after()` so a Netlify function does not freeze with the envelope in flight. `next.config.mjs` wraps the config in `withSentryConfig` for source maps.
- Report through `reportSentryError` and `reportSentryMessage` in `lib/observability/report.ts`, never `Sentry.captureException` directly: they write the structured `observability.fault` log line and the expected/subsystem tags. Delivery does not depend on it: on Netlify, `sentry.server.config.ts` calls `flushAfterEveryServerEvent` (`lib/observability/serverless-flush.ts`), a listener on the SDK client's `preprocessEvent` hook, so every server error or message event, whichever API captured it, schedules a 2 s flush on `after()` (started but not awaited when there is no request scope). The listener must never throw, because the SDK's `emit` does not catch and a throw drops the event. Transactions schedule no flush, and the edge runtime (middleware) installs no listener. Routes that catch an error and answer a 500 are not covered by `onRequestError`, which is why the flush hangs off the client. Bare-Node jobs call `initJobSentry()` and `flushJobSentry()` from `lib/observability/job-sentry.ts`.
- The quota posture is a drop in `beforeSend` or a rule at the capture site, never a Sentry-side setting alone: one report per run (`createRunFailureReporter` in `lib/observability/run-failures.ts`), fixed fingerprints, expected failures to logs, previews report as environment `preview` and only production-scoped alert rules page, config skips never reach Sentry (`reportConfigSkip` in `lib/cron/config-skip.ts` only logs), and the escalations-only policy in `docs/observability/00-system-design.md`. The conventions page `docs/observability/sentry/02-conventions.md` has the reasoning.
- Boot-time configuration warnings go to Sentry Logs with `Sentry.logger.warn` and only in production, never to an issue. The first user of this rule is `AUTH_CAPTCHA_DISABLED` in `lib/auth/captcha.ts` (arrives with #2423).

## Native worker SDK imports

Shared capture, logger and flush helpers used by standalone Node ESM workers import
`@sentry/core`; initialization remains in `sentry.shared.config.ts`. Keep Core and
the Next SDK at matching pinned versions and update them together. The Next SDK's
10.76.0 Node export is CommonJS, and its dynamic generic re-exports do not appear
in a native ESM namespace. Do not add runtime duck-typing or a second telemetry
policy to hide that failure. Run `native-sentry-runtime.test.ts` with the real SDK
and an in-memory transport; a mocked SDK cannot establish export interoperability,
privacy scrubbing or draining. A 202 response and invocation receipt do not prove
either worker completion or a successful telemetry flush.

## Non-negotiables in full

An error must be attributable before it is debuggable, and nothing in this domain is verified until the evidence is named. Concretely, the following are not preferences.

**Name the rung of evidence you reached.** "The code calls `reportSentryError`" proves intent. "The envelope on the wire carried `user.id`" proves the SDK serialised the identity. "The event is queryable in Sentry" proves the lot. These are different claims with very different value, and collapsing them is how six days of dead error ingestion went unnoticed. `references/diagnosing.md` has the ladder and the procedure; `07` has the detail.

**Never hardcode a Sentry coordinate.** Organisation, project, API URL and web URL are read from the environment with a `||` default to the live project. Slugs, not ids — the two project ids in circulation are neither valid slugs. A new literal is a review failure, and a DSN literal in source is a history-rewrite failure. The one exception is the synthetic, unroutable test DSN exported as `SYNTHETIC_DSN` from `__tests__/fixtures/sentry-fake-transport.ts`; tests import it rather than writing their own, and no real coordinate may appear anywhere.

**The org id is in the DSN host; the project id is the DSN's last path segment.** They are both sixteen digits and both in that one string, and the org's appears as `o<orgId>` in the host. A reader has already mistaken the org id for a project id here, and the dead project id from the 2026-09-20 mis-rotation shared its first ten digits with the org id so the two read as siblings. Slugs go in config; ids come out of the DSN; the CI guard's `EXPECTED_SENTRY_PROJECT_ID` is a non-secret repository **variable** for exactly this reason, and it is named the way it is because `LIVE_SENTRY_PROJECT` was ambiguous. `01` has the full four-way taxonomy.

**Unset token is off; empty token is broken on.** Gate token-using paths on presence, not truthiness of a configured-looking string. An empty `SENTRY_API_TOKEN` silently enables authenticated REST calls that fail every time.

**The SDK is not on `window`.** `sentry.shared.config.ts` deliberately keeps it off the global scope, so there is no `window.Sentry` to poke at and never will be. The observable surface is the HTTP layer, and the only reliable place to attach a listener is a `<script>` in the page's own main world — a DevTools-protocol evaluation runs in an isolated world where your injected `error` never reaches the page's listeners, which looks identical to "Sentry is not initialised".

**A 2xx from Sentry is not proof of acceptance, and acceptance is not proof of queryability.** Sentry does 2xx-and-drop, which is why the ingest canary judges the `stats_v2` outcomes rather than any ingest response. And read `x-sentry-rate-limits`: it names the limited categories and omits the healthy ones, so a working session or transaction stream is no evidence at all that errors are being taken. That partial outage is the 2026-09-22 incident.

**A monitor must not be able to silence itself.** The canary runs once a day and pages on every unhealthy run, with no cooldown to fail; a failed stats read is itself an alert, never a pass.

**A check that reports its own failure through the failing system is not a check.** The canary pages by email through Resend and by an error-level Better Stack log line. If the monitor's first stop is the thing it monitors, the monitor is decorative.

**Modelled refusals are warnings.** A full webinar, a credit shortfall, a consent gate — a `BUSINESS_ERROR_CODES`-registered code is `expected: true`, gets re-levelled to warning by `beforeSend`, and must not be an error event. A quota is 5,000 errors a month on Developer; mislabelled business outcomes are how that gets spent in a day, and `INFRA_THROTTLE_MS` in the shared config exists because it happened on 2026-09-21.

**A repetition is throttled; a set is aggregated.** Throttle when one failure recurs (the evidence is one real stack trace; a count would have to be invented, and would under-report exactly when you are sizing an incident). Aggregate when one run found many distinct things (the set is the fact, the ids are the evidence). Never aggregate a repetition. And note that **grouping into one issue is not grouping into one event** — a shared `fingerprint` leaves N events costing N, which is how the old envelope-posting canary came to cost events every run until it was replaced by a stats read.

**Never attach a person to a synthetic event.** Test events are not evidence about anyone, and a stable user cuid is pseudonymous personal data with DPDP obligations attached — the disclosure sign-off is tracked in `05` and is not optional.

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

`sentry.shared.config.ts` applies its limits in the `beforeSend` budget stage. A per-key throttle lets the first event for each key through and then at most one per `INFRA_THROTTLE_MS` (one hour) per process, where the key is the exception type, the message with ids and numbers normalised away, and the top in-app frame. A per-process circuit breaker allows at most 10 events per rolling hour and logs a console warning when it opens; `fatal` events skip the breaker by owner decision, because a `WALLET_BALANCE_DRIFT` page must never lose to noise. The Upstash quota, cron lock (`cron-lock-unavailable`), Prisma pool exhaustion and `SystemEvent` write failures each get a fixed fingerprint family (`upstash-quota`, `prisma-pool-exhaustion`, `system-events-write-failed`), so one outage is one issue however many routes hit it. An `expected` event at level `info` is dropped, and `ignoreErrors` has a few extra entries. The throttle is in memory on purpose, because Redis is often the thing that is down.

Previews report errors like production (since 2026-11-05, reversing 2026-10-31): events carry environment `preview` and the branch tag, and pass the same expected-info drop, per-key throttle and per-process breaker. Every error-paging alert rule must filter to `environment: production`; check that before adding one. Previews upload no source maps, so their frames are minified. `NEXT_PUBLIC_SENTRY_ENVIRONMENT` is read instead of `NODE_ENV` because `NODE_ENV` is `production` on previews too. `instrumentation.ts` exports its own `onRequestError`: it calls `Sentry.captureRequestError` and then hands a 2-second flush to Next's `after()`, because the SDK's own post-capture flush rides Vercel's or Cloudflare's `waitUntil` and does nothing on Netlify, where the function can freeze with the envelope in flight (the `network_error` client discards in the project stats are consistent with that failure). With no request scope it returns the flush so Next awaits it.

Sweeps aggregate once per run in `settle-cancelled-sessions`, `retry-auto-refunds`, `expire-reschedule-proposals` and `reconcile-ledgers`; the freeze behaviour of the reconciler is unchanged, and drift still pages even if the first freeze throws. The cleanup-route catch-all is throttled per job. These guardrails sit next to the span and log scrubbing and the dead-letter alerting added in #1932 and the atomic cron lock added in #1935, and they do not replace either.

The rule for new code is to never capture per row. A loop that can fail on many rows keeps a per-row `console.error` that logs `scrubStringValue(message)` from `lib/observability/sentry-scrubber.ts` rather than the raw error, because console output bypasses Sentry's scrubber. It collects the failures and, after the loop, emits one `reportSentryError` with a stable `fingerprint` and `extra: { failed, sample }` holding the count and the first ten ids. A repetition of one failure is throttled and a set of distinct failures is aggregated, as the non-negotiables above describe.

The ingest canary also warns before the quota is gone, and it runs that check after the urgent rejection alert so that alert still fits inside the roughly 26 second function ceiling. When `SENTRY_STATS_TOKEN` (an Internal Integration token, Organization: Read) is set, each daily canary run reads the accepted error count for the current billing period and emails once per period when it reaches 70% of `SENTRY_ERROR_QUOTA` (default 5000). `SENTRY_QUOTA_PERIOD_START_DAY` (default 19) sets the day the period starts, and an unset token makes the whole canary run a config skip.

### Sentry-side state on 2026-10-02

The high-priority alert workflow 3606037 now filters on `environment: production`; in the new API it is a workflow at `organizations/practitionist/workflows/3606037/`, not an alert rule. Rule 6031144 (`pool_exhaustion`) is unchanged, spike protection is on, and the inbound filters for browser extensions, web crawlers, React hydration errors, chunk-load errors and legacy browsers are on. A DSN key rate limit of 30 per hour was attempted and is silently ignored on the free plan, because the PUT returns 200 while `rateLimit` stays null. Inbound error-message filters for the flood families were deliberately not added, because they would drop the first event as well and blind a real outage like 2026-09-25.

### Still to do (owner)

Ops still has to create an Internal Integration token (Organization: Read) and set it as `SENTRY_STATS_TOKEN` on Netlify production (an organization auth token only carries `org:ci`), with the optional `SENTRY_QUOTA_PERIOD_START_DAY` and `SENTRY_ERROR_QUOTA`. Until then the canary records a config skip every day and alerts nobody. In one to two months the owner plans to upgrade to the Team plan (US$26 a month billed annually, 50,000 errors, pay-as-you-go), and at that point the DSN key rate limit and the dropped preview events should be revisited. Issue #1933 stays open until then.

For the email map, the pre-launch delivery guard and ops alert routing, see [docs/email/README.md](../../../../docs/email/README.md).

## The ingest canary

`sentry-ingest-canary` is a ticker target in `lib/cron/schedule.ts` that runs once a day at 00:50 UTC and is registered in `lib/cron/cleanup-registry.ts`. It sends no event: it reads the last day's error outcomes from `stats_v2` with `SENTRY_STATS_TOKEN` (`lib/observability/ingest-canary.ts`, Zod-parsed), returns `accepted`, `rejecting` or `stats-unreadable`, and on the last two pages by email and an error-level Better Stack line through `lib/observability/ingest-alert.ts`. An unset token is a config skip. The ticker never reports the canary's own failure to Sentry (`reportableToSentry` in `netlify/functions/cron-tick.mts`). The verdict table, the partial-outage trap and the incident are in `docs/observability/sentry/06-ingest-canary.md`.

## Proving an event arrived

Climb the evidence ladder and name the rung you reached: the code calls a reporter, the envelope on the wire carries the field, Sentry accepted it, the event is queryable. Use `references/diagnosing.md` for the branching procedure when an event is missing or wrong, and `docs/observability/sentry/07-verifying-end-to-end.md` for the deploy-preview probe procedure and how to state a verification claim honestly. Quota exhaustion is diagnosed from the stats API first (the section "How to diagnose next time" above).
