# ADR: The ticker skips targets that have no work

- **Status**: Accepted on 2026-11-01. Ships in the pull request that adds this record.
- **Date**: 2026-11-01
- **Author**: Platform engineering
- **Related**: [Ticker through launch, the scale path and the queue](2026-10-31-ticker-scale-path-and-queue.md), [Job machinery catalog](../maintenance/11-job-machinery-catalog.md), [Observability system design](../observability/00-system-design.md), [Billing guardrails](../../.claude/skills/billing-guardrails/SKILL.md)

## Context: the Netlify bill is counted in function invocations

- **The receipt (measured).** Netlify's invoice of 2026-10-06 was $44: $19 for the one member seat plus a flat $25 for function invocations. The `familiarise` site made 282,162 invocations between 4 September and 3 October 2026. The legacy Pro tier includes 125,000 invocations per site, and the next tier is a flat step: anything from 125,000 to 2,000,000 costs $25. The earlier periods were below the step: 24,804 in May, 48,552 in June and 75,897 in August.
- **The ticker is a large, avoidable share.** Before this change the ticker made about 94,850 invocations a month on its own: 8,640 ticks (288 a day over 30 days) plus 86,210 target calls (counted by running `dueTargets()` over 30 days). It also made 8,640 slot-claim calls, so the ticker's total was about 103,500 a month.
- **Almost every call found nothing.** In the 7 days before 2026-11-01, 21,327 of the 21,380 `SystemJobExecution` runs processed zero items and raised no error (99.8 %). That is pre-launch behaviour on mock data, but the pattern is structural: an outbox sweep with an empty outbox still costs one invocation.
- **Why not make the sweeps rarer.** A sweep's cadence is its recovery-time promise (a stuck refund is retried within 15 minutes). Lowering the cadence would weaken the promise to save invocations. Skipping the call only when there is provably nothing to do keeps the promise.

## Decision

The ticker still wakes every five minutes, but it dispatches a due target only if that target has work.

1. **Every registry entry declares an idle rule.** `CleanupJobEntry` in `lib/cron/cleanup-registry.ts` has a required `idle` field. It is either `{ hasWork(db, now, outOfTime) }`, which lazily imports an exported `has...Work` probe from the job's own core module, or `{ alwaysRun: "<one-line reason>" }`. Today 40 jobs are probed and 36 always run.
2. **A probe asks the job's own question.** The `where` builders (identifiers ending in `Where` or `WHERE`) are shared by the job's claim query and its probe, so the probe cannot drift into answering a different question. `__tests__/maintenance/idle-probe-drift.test.ts` enforces it statically: every target declares a probe or a reason, a probe's `where` only combines builders, every builder a probe reads is also read by the claim query, and the probe lives in the module the entry's `build` imports.
3. **The probe runs inside the existing slot-claim call.** `claimTickSlot` in `netlify/functions/cron-tick.mts` sends `due=<comma list>` to `POST /api/health/jobs/tick`. The route calls `probeTick()` (`lib/cron/idle-probe.ts`; it also reads the queue gauges of the [gaps decision](2026-11-01-observability-gaps-and-launch-posture.md) after the probes), writes the claim row with `result.idle` (the skipped target names) and `result.idleCount` in the same insert, and answers `{claimed: true, idle}`. A duplicate dispatch of the same slot still gets `{claimed: false}`. The idle list is on the claim row before the ticker skips anything, so a crash between the claim and the dispatch loses no evidence.
4. **The ticker dispatches the rest.** It computes `scheduledTargets(tickDate)`, and dispatches `capToTick(scheduled minus idle)`. The twelve-target cap (`MAX_TARGETS_PER_TICK`, where `reconcile-ledgers` yields) now applies to what is dispatched. Windows, offsets, cadences and leases are unchanged. The console JSON line and the tick body gain `skippedIdle`, and the Better Stack summary gains `skippedIdleCount`.
5. **Probing is bounded, and the claim timeout rises from 2.5 s to 5 s** (`TICK_CLAIM_TIMEOUT_MS`). Probes run in one transaction with `SET LOCAL statement_timeout` of 750 ms (`IDLE_PROBE_STATEMENT_TIMEOUT_MS`; `SET LOCAL` holds through the transaction pooler, unlike the connection's startup parameter). No statement starts after the 2 s budget (`IDLE_PROBE_BUDGET_MS`): every probe checks `outOfTime()` before each statement and answers "has work" once it is true, so an unfinished probe never marks its target idle. Probing ends by 2.75 s, and with the commit and the claim insert the reply leaves about 2 s of the 5 s timeout for a cold start.

Why the probe is folded into the claim call and not a separate `_due` route: a separate call would add 8,640 invocations a month on its own, and an `app/api/cleanup/_due` folder is a private folder in the App Router and would not route.

### Fail open

Every doubt dispatches the target, exactly as a failed claim did before. The cost of a wrong skip is a job that does not run; the cost of a wrong dispatch is one invocation.

| Situation                                                             | What the ticker does                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| A probe throws                                                        | Dispatches that target; one `idle-probe-failed` log line |
| The job is registered `alwaysRun`                                     | Dispatches it                                            |
| The 2 s probe budget ends before or during the target's probe         | Dispatches the unprobed or unfinished targets            |
| Postgres cancels a probe statement after 750 ms                       | Dispatches that target and every target not yet probed   |
| The probe module cannot load                                          | The route claims the slot with `idle: []`                |
| The claim reply is unreachable, non-2xx, unreadable or later than 5 s | Dispatches every scheduled target                        |

Probe failures are one log line per tick and never a Sentry event, because they would otherwise be one event per probe per tick against a 5,000-a-month quota.

### The always-run rule and the low-frequency rule

A job is `alwaysRun` only for one of these reasons, and the entry states which:

- **Vendor state or no row marks the work (9 jobs).** `reconcile-document-storage`, `reconcile-gateway-settlements`, `reconcile-ledgers`, `reconcile-occurrence-availability`, `reconcile-orphaned-recordings`, `reconcile-stream-memberships`, `sentry-ingest-canary`, `stream-control-plane-drift` and `stream-sync` compare us with a vendor or recompute from every row, so no database predicate says whether there is work. This is the AGENTS.md rule that reconciliation belongs at vendor boundaries. _Superseded in part by [2026-11-02-reliable-jobs-digest-and-release-lag.md](2026-11-02-reliable-jobs-digest-and-release-lag.md): `sentry-ingest-canary` and `stream-control-plane-drift` still always run, but each run now writes a run row, so the freshness probe judges them._
- **The window is the work (2 jobs).** `gst-outward-register-export` and `tds-return-draft` are statutory exports that must run in their calendar window.
- **An idle skip would hide a configuration fault (3 jobs).** `irp-uploader` records a config skip on every run when the GSP is not configured. `process-payouts` surfaces a broken payout lock (Redis) or payout config within the hour, and `generate-subscription-invoices` surfaces a bad supplier GSTIN on every slot of its daily window (owner decision, 2026-11-01). The rule admits such a job only when it adds 720 calls a month or fewer, so `retry-failed-emails` (2,880 a month), which is the job that surfaces a missing `RESEND_API_KEY`, stays probed and shows that fault only when an email is waiting.
- **Low frequency (22 jobs).** A job due once a week, once a day or a few times a day saves too little to justify a probe. The largest saving is `prune-system-job-executions` at 210 calls a month; the entries state each figure.

Together these 36 jobs account for about 5,170 dispatches a month. The low-frequency rule is a cost rule, not a safety rule: when a probe is cheap and the saving grows, move the job to `hasWork`.

## Consequences

- **Invocations.** Probed jobs account for about 81,030 of the 86,210 target calls. In the idle state the ticker makes about 8,640 ticks + 8,640 claim-and-probe calls + 5,170 always-run dispatches ≈ 22,450 invocations a month, plus one call for every due tick on which a probed job has real work. This is an estimate from the schedule, not a measurement; verify against Netlify's usage page after a week. The ticker was about a third of the 282,162 total, so this change alone removes roughly 81,000 invocations; whether the site then falls below the 125,000 free tier depends on user traffic, which this record does not claim.
- **Stale outbox gauges on skipped ticks.** Some jobs publish backlog gauges only when they run (`drain-notification-outbox` sets the Sentry metric `notifications.outbox.pending`). While the job is skipped the gauge keeps its last value. The skip means the probe saw nothing waiting, so a stale non-zero value can linger on a dashboard until the next real run; read the claim row's `idle` list before trusting a flat gauge.
- **Hidden missing-configuration errors.** A job that would record a config skip or a missing-secret failure only when it runs will not show it until work arrives. Jobs where the fault is itself the signal are `alwaysRun` (`irp-uploader`, `process-payouts`, `generate-subscription-invoices`). For the rest, the error appears with the first piece of work, not before.
- **Probes that stay true while rows linger.** A probe answers true for as long as a claimable row exists, so a row that the job cannot resolve (waiting for an external retry window, or an unresolvable dead letter) keeps its job dispatching every tick. That costs the same as before, never more, and it is the right signal: the work is still there.
- **No run row for a skip.** A skipped target writes no `SystemJobExecution` row. `readIdleCompletions` (`lib/cron/idle-skips.ts`) reads the claim rows' `idle` arrays (one `$queryRaw` using `jsonb_array_elements_text`, filtered by environment) and maps targets to job names. These readers count a skip as a healthy finished run:
  - `app/api/health/jobs/route.ts`, the paging completion SLOs (48 h);
  - `app/api/health/jobs/streaks/route.ts`, where an idle skip ends a failure streak and sets `seenRecently`;
  - `lib/backoffice/job-run-metrics.ts`, last success and missed window, plus a 7-day `idleSkips` count shown as the "Idle skips" column in `components/dashboard/backoffice/JobRunMetrics.tsx`;
  - `app/api/health/route.ts`, where `readLatestCompletedCronExecutionAt` counts a claim row with `idleCount > 0` as liveness, because a bare claim proves only that the ticker fired.
- **Generated reference.** `scripts/maintenance/generate-cron-reference.ts` adds an "Idle probe" column to `docs/maintenance/04-cron-jobs-reference.md`.
- **Adding a job** now means writing the probe from the claim predicate, or stating why it always runs. See `.claude/skills/jobs/references/cron-ticker.md`.

## Billing rationale

This section records why invocations are the number to push down, and what the plan change would and would not fix. Figures marked measured come from Netlify receipts (team `teetangh`, invoices CFJUKK-00015 to CFJUKK-00020) or the Netlify API. Figures marked docs come from Netlify's pricing pages or from Netlify support (ticket #1112198, 17 September 2026).

- **The step is the cost (measured).** On the legacy Pro plan the invocation meter is a cliff, not a slope: 125,000 invocations per site are included, and crossing that line adds a flat $25 up to 2,000,000 ([legacy plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/legacy-pricing-plans/)). The site was at 75,897 in August and 282,162 in the September 4 to October 3 period, which is why the October 6 bill was $44 and not $19.
- **The next bill (measured, projected).** A second member (a Developer) was added on 5 October and billed $18.39 prorated. If invocations stay above 125,000, the next bill is about $63: two seats at $19 plus the $25 step.
- **Nothing else is near a limit (measured).** Bandwidth was 1.29, 1.60, 8.26 and 8.36 GB against 1 TB included. Edge function invocations rose from 52,000 to 284,000 against 2,000,000 free. Build minutes peaked at 9,777 of 25,000. Invocations are the only meter that has crossed a line.
- **What we cannot cap (docs).** Legacy Pro has no hard spend cap, only usage alerts at 50, 75, 90 and 100 percent. Invocation overage above 2,000,000 is billed per 500,000. Netlify bills keep-warm pings like real invocations (about 26,000 a month for three pings every five minutes) and bills a cold-start stall as duration (a 28 second stall at 1,024 MB is about 28 GB-seconds against the 1,000 GB-hour allowance). The keep-warm function was retired on 3 October, so the ticker was the largest controllable source left.
- **Other sources that remain.** Better Stack checks `familiarisenow.com` and `/api/health` every 3 minutes (`docs/maintenance/00-betterstack-setup.md`). The homepage is ISR (`revalidate = 3600` in `app/page.tsx`) and served from the CDN, so its check is not a function invocation; the `/api/health` check is, at about 14,400 a month per checking region. The owner decided on 2026-11-01 to keep both monitors unchanged.
- **The credit-based plan is not a substitute (docs; pending, not decided).** A move to a credit-based plan is being weighed separately and does not change this decision. Pro there is $20 flat with 3,000 credits and unlimited members, compute costs 10 credits per GB-hour and web requests 2 credits per 10,000, so fewer ticker calls still lower the bill, only through a different meter. Our usage is estimated at 1,000 to 1,300 credits a month. The switch is permanent ("You cannot revert to a Legacy plan from a Credit-based plan"; see [how credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/) and [pricing](https://www.netlify.com/pricing/)), so an email asking Netlify support to confirm region pinning, Background Functions and seats first was drafted on 2026-11-01 and is not yet sent. The full facts are in `.claude/skills/billing-guardrails/references/netlify.md`.
- **Expected effect (estimate).** In the idle state the ticker falls from about 103,500 calls a month (94,850 plus 8,640 slot claims) to about 22,450: 8,640 ticks, 8,640 claim-and-probe calls and about 5,170 always-run dispatches. Each due tick that has work adds a call. This removes about 81,000 calls a month of overhead. Whether that brings the site under the 125,000 line depends on user traffic and monitor checks, which this record does not measure.
- **Measured outcome (2026-11-03/04).** The ticker runs at about 57,000 a month, not 22,450. Eight probed jobs almost never report idle (about 16,000 zero-item calls a month), and Netlify fires about 29 percent of slots twice (about 5,000 a month). The site as a whole ran at about 195,000 and paid one $25 step on the 2026-11-04 invoice. The residuals are tracked in #2613.

## Worked example: the 10:55 UTC tick

Take the tick for the slot `2026-11-01T10:55:00Z` (16:25 IST). Among its scheduled targets are `drain-notification-outbox` (every 10 minutes, offset 5, so it is due) and `reconcile-gateway-settlements` (hourly at offset 55, inside its 06:30 to 12:30 UTC window, so it is due). Other due targets are left out for brevity.

1. Netlify fires `cron-tick.mts`. The fleet switch says this host is active.
2. The ticker computes the scheduled list and POSTs the claim with `due=drain-notification-outbox,reconcile-gateway-settlements,...`.
3. The route probes `drain-notification-outbox`. Its probe asks whether any notification outbox row is claimable; Every earlier notification has been delivered, so there are none. The target is idle. `reconcile-gateway-settlements` is `alwaysRun`, so it is not probed.
4. The route inserts the claim row with `idle: ["drain-notification-outbox"]` and `idleCount: 1`, and answers `{claimed: true, idle: [...]}` in well under the 5 s timeout.
5. The ticker dispatches `reconcile-gateway-settlements` and the other non-idle targets, and logs `skippedIdle: ["drain-notification-outbox"]`. It makes one fewer invocation than it would have.
6. Ten minutes later, at 11:05 UTC, a booking confirmation has put one row in the outbox. The probe answers true, the target is not in `idle`, and the ticker dispatches it as before.
7. If the claim call had timed out at 5 s, the ticker would have dispatched every scheduled target, including `drain-notification-outbox`.

## Deprecated & Superseded Approaches

| Approach                                                           | Why it was superseded                                                                                                                     | What to delete if you find it                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Dispatching every due target on every tick, unconditionally        | 99.8 % of runs found nothing, and each dispatch is a billable function invocation. Cadence is kept; only provably empty runs are skipped. | Any registry entry without an `idle` field, or code that assumes one run row per due target. |
| A slot claim that only inserts the claim row, with a 2.5 s timeout | The same call now probes, so it needs a cold start plus up to 2.75 s of probes.                                                           | A `2.5`-second claim timeout in the ticker, docs or tests.                                   |
| A separate `_due` route for the probe                              | It would add 8,640 invocations a month and a private `_due` folder does not route.                                                        | Any `app/api/cleanup/_due` folder or a second pre-dispatch call.                             |
| Freshness read only from job run rows                              | An idle skip leaves no run row, so a healthy idle job would look missed.                                                                  | Any new health or console reader that ignores `readIdleCompletions`.                         |
