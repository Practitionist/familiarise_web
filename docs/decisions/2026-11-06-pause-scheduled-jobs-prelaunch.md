# ADR: Pause the scheduled job fleet until launch

- **Status:** accepted by the owner on 2026-11-06. **In force since 2026-11-05 22:41 UTC.**
- **Related:** #2546 (jobs that stopped silently), #2547 (detectors), #2613 (invocation residuals), the Netlify invoice CFJUKK-00022.

## Context

Before launch, the production database holds only seeded and QA data, so the 5-minute ticker and its jobs process mock rows. The Netlify invoices show the site's function invocations crossed the 125,000 free tier in both the September and October cycles, which bills a flat $25 step on legacy Pro. The ticker accounts for about 57,000 invocations a month, and the two monitors that poll `/api/health/jobs` add about 17,000 more. Jobs can still be run by hand: System Jobs, Run now, or `POST /api/cleanup/<registry-key>` with `CRON_SECRET`.

## Decision

The production ticker stands down through the existing fleet switch rather than a code change. The Upstash key `ops:active_cron_platform` (database `Familiarise`, `warm-hookworm-24098`) is set to `paused-prelaunch`. `otherActivePlatform` in `netlify/functions/cron-tick.mts` treats any value other than `netlify` as "another host is active", so each tick returns before claiming a slot or calling any job. The tick no longer pings its heartbeats while paused, so the monitors that would page are paused with it:

| Monitor                                                                  | Vendor       | State    |
| ------------------------------------------------------------------------ | ------------ | -------- |
| `familiarise cron-tick (prod)` heartbeat (521597)                        | Better Stack | paused   |
| `familiarise ops digest (prod)` heartbeat (523773)                       | Better Stack | paused   |
| `familiarise job fleet probe (prod)` (5189236)                           | Better Stack | paused   |
| `cron-tick` cron monitor                                                 | Sentry       | disabled |
| `familiarise job fleet probe (second watcher)` uptime detector (7689936) | Sentry       | disabled |

The homepage and `/api/health` monitors stay on, so an outage of the site itself still pages.

**Verified 2026-11-05:** the 22:45 UTC tick wrote no `SystemJobExecution` row; the 22:40 tick had already started when the key was set.

## Alternatives considered

- **Keep the jobs running.** Rejected for the pre-launch phase: it spends invocations on mock data, and nobody acts on its findings yet.
- **Remove the schedule in code** (`netlify/functions/cron-tick.mts`). Rejected: it needs a deploy each way, and AGENTS.md section 1.4 already provides the switch.
- **Slow the ticker to 15 minutes.** Rejected: it saves only about 18,000 invocations, and it changes the schedule, the slot width and the freshness budgets.
- **A new environment flag.** Rejected: AGENTS.md section 1.2 forbids speculative flags, and the fleet switch already exists.

## Consequences

- **Savings are partial.** About 45,000 job invocations a month go away, plus about 17,000 from the paused probe monitors. The scheduled function itself still fires about 11,000 times a month to read the key and exit. Deploy previews (about 71,000 a month) keep the site above the 125,000 tier unless they also fall, so the $25 step may still apply on legacy Pro. On credit-based Pro, the pause lowers credit use instead.
- **The switch fails open.** If Upstash is unreachable or answers after more than 1 s, that tick runs the jobs. That is intended: a Redis outage must never stop production silently.
- **Normally no job runs on schedule,** including retention, auth-token cleanup and the Sentry canary. The fail-open exception above means an occasional tick can still run the fleet, with its monitors paused. Most of the backlog drains in bounded slices once the fleet resumes. Some items may not drain by themselves and need operator review after resuming; for example, `expire-stale-requests` can leave retired or foreign-owned refund obligations. Read the Stuck work page and the first digest after resuming.
- **This pause is the deliberate version of #2546.** It is safe only because it is recorded here and resumed from the go-live checklist.

## How to resume (go-live, or any time)

1. In Upstash, delete the key, or set `ops:active_cron_platform` to `netlify`: `DEL ops:active_cron_platform` in the `Familiarise` database.
2. After the next 5-minute tick, confirm a new production `cron-tick` row exists in `SystemJobExecution`.
3. Unpause the three Better Stack items (`PATCH https://uptime.betterstack.com/api/v2/heartbeats/<id>` and `/monitors/<id>` with `{"paused": false}`). Re-enable the Sentry cron monitor (`sentry api /organizations/practitionist/monitors/cron-tick/ -X PUT -d '{"status":"active"}'`) and the uptime detector (`sentry api /organizations/practitionist/detectors/7689936/ -X PUT -d '{"enabled":true}'`).
4. Run the weekly and quarterly windowed jobs once by hand, if the probe lists them overdue. Run `ops-digest` once, and confirm `/api/health/jobs` answers 200.

## Deprecated & Superseded Approaches

- The 2026-11-03 to 11-05 state, with the fleet running and all five monitors live on mock data, is superseded by this pause until launch.
