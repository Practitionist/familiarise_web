# Sentry

## 1. Plan and limits

The organisation is on the Developer (free) plan (`docs/observability/sentry/06-ingest-canary.md`, `docs/notifications` notes, issue #2145). VERIFIED 2026-10-17 from [sentry.io/pricing](https://sentry.io/pricing/): Developer includes 5,000 errors, 5M spans, 5 GB logs, 50 session replays and 1 cron monitor, with no spend notifications and no spend cap; Team is $29 a month ($26 annual) with 50,000 errors, spend notifications and a maximum-spend threshold. The billing period renews on the 19th (`quotaPeriodStart` in `lib/observability/quota-alert.ts` defaults to day 19); the current period renews 2026-10-19.

[Quotas](https://docs.sentry.io/pricing/quotas/) (VERIFIED): every accepted error counts; issues themselves do not, so grouping or resolving an issue does not reduce quota. Spike protection drops events above a baseline-derived threshold, enabled per project under Settings, Spike Protection. Per-key rate limits are Business or Enterprise only, and so are custom inbound filters for error messages and releases ([event stream guide](https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/), VERIFIED). Whether spike protection is available on Developer is not stated on the pages read (unknown; check Settings).

## 2. What causes surprise bills or outages

- Quota exhaustion is silent: the error item gets HTTP 429 with `error_usage_exceeded` while sessions and transactions still answer 200, so dashboards look healthy but error issues freeze. The repo was blind from 2026-09-22 until the 2026-10-19 renewal.
- A single outage can spend the whole month: 2,653 `UpstashError` and about 1,350 `CronLockUnavailableError` events in 24 hours.
- Per-row capture inside a sweep, and a standing finding reported on every run (`reconcile-payment-status` sent 1,147 events about the same four payments), are the usual culprits.
- Per-process budgets do not hold on serverless: each cold Lambda starts with an empty budget, so the budget cannot dedupe across invocations.
- Logs (5 GB) are not the risk today: 389,277 items, 164 MB over 30 days, mostly `[Prisma:SLOW_QUERY]` from previews.
- A second cron monitor is not free (+$0.78 each); the `cron-tick` monitor is disabled because `daily-maintenance` holds the single slot.

## 3. Exposure in this repo

- `applyErrorBudget` in `sentry.shared.config.ts` is the `beforeSend` stage: it drops `expected` info events, assigns fingerprint families, throttles each key to one event per `INFRA_THROTTLE_MS` (one hour), and lets at most `BUDGET_BREAKER_MAX` (10) non-fatal events an hour through per process. Fatal events skip the breaker. It is per process only.
- `resolveDefaultTracesSampleRate()` caps `tracesSampleRate` at 0.1 in production and preview (0.2 elsewhere), fixed in code with no env override; `/api/cleanup/` traces sample at 0.02. Never set `1.0` in production or preview.
- Session replay is not configured anywhere (no replay integration or sample rates in `sentry.shared.config.ts` or `instrumentation-client.ts`), so it stays at the SDK default of off. Do not add replay without a budget.
- `instrumentation-client.ts` loads `@sentry/nextjs` lazily and skips synthetic traffic when `navigator.webdriver` is true or the user agent matches `HeadlessChrome|Lighthouse|PTST`.
- The ingest canary (`lib/observability/ingest-canary.ts`, target `sentry-ingest-canary`) runs once a day and costs no error quota: it reads `stats_v2` with `SENTRY_STATS_TOKEN` instead of sending an event (the old six-hourly probe event cost about 120 stored errors a month). Its alert goes by email through Resend and as an error-level Better Stack line, never through Sentry.
- Sentry is escalations only (`docs/decisions/2026-10-31-sentry-escalations-only.md`): one-off ticker failures, config skips, non-money business findings and every preview event stay out of it; money findings (wallet and ledger drift, the dispute deadline, refund reconcile) page once per new id set; Spike Protection is on.
- `lib/observability/quota-alert.ts` emails once per period at 70 percent of the error quota, reading `stats_v2`.
- Open exposure (issue #2145): database-unreachable (`P1001`) and connection-timeout failures have no budget family, so each failing request is limited only by the 10-an-hour breaker.

## 4. Guardrails to set

- Settings, Spike Protection: enable for every project.
- Settings, Inbound Filters: keep browser extensions, crawlers, legacy browsers and localhost on.
- Whether to upgrade to Team for a spend threshold is an owner decision kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend); Developer has no notification at all, so the 70 percent email in `lib/observability/quota-alert.ts` is the only early warning.
- In code: report once per run, collect failures and capture one summary (`AGENTS.md` rule on Sentry discipline); a standing finding needs shared state (Postgres), not process memory. Use `createRunFailureReporter` (`lib/observability/run-failures.ts`) for per-row failures and `reportStandingFinding` (`lib/observability/standing-finding.ts`, ids stored in `SystemEvent`) for findings that recur across runs.
- Choose one cron monitor deliberately (issue #2145, A3).

## 5. Monitor

Sentry MCP `find_dropped_events` for rate-limited and discarded counts. CLI: `sentry api "organizations/<org>/stats_v2/?field=sum(quantity)&category=error&groupBy=outcome&interval=1d&statsPeriod=30d"`. Healthy ingest check: the canary route `/api/cleanup/sentry-ingest-canary` (needs `CRON_SECRET`).
