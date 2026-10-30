---
title: Load test plan — 100, 300 and 1,000 virtual users
band: 50-operations
audience: sde3
status: planned-not-executed
type: how-to
---

# Load test plan

> **Run ONLY after the database split; never against the shared database.** Production, previews and dev share one Supabase project today. A load test against it loads production's connection pooler and writes rows next to real data. The split is described in [the database split plan](../../deployment/db-split-plan.md) and is gated on the Supabase Pro upgrade and real customers. Nothing on this page has been run.

This plan sets the stages, routes, pass criteria and abort rules for the first staged load test of the whole site. It is separate from the booking race harness in [the load gate runbook](09-load-gate-runbook.md): that harness proves booking correctness under concurrency (chaos scenarios 6, 14c and 17), while this plan measures whether the database path survives user-shaped read traffic. The reasoning behind the numbers is in [the capacity ladder](08-capacity-ladder.md) and [the ticker scale-path decision](../../decisions/2026-10-31-ticker-scale-path-and-queue.md): each SQL statement costs about 95 ms between Netlify in Singapore and Supabase in Mumbai, each function instance holds one connection (`PG_POOL_MAX=1`), and Supabase Micro admits 200 pooler clients. The first ceiling is expected at roughly 300 to 500 concurrent users.

## Prerequisites

1. The database split is done and verified, so the target deploy reads and writes the dev project only.
2. The target is a Netlify deploy preview or branch deploy, never the production hostname. `.github/workflows/load-test.yml` takes any `base_url`; the stricter host allowlist lives in `.github/workflows/load-gate.yml`.
3. The dev project is seeded with the cast in `prisma/seedFiles/`, so every virtual user signs in as a seeded user and reads a seeded expert.
4. The Supabase plan under test is the plan production will run: Pro with Micro compute. Record the compute size in the results, because Micro admits 200 pooler clients and Small admits 400 (Supabase compute and disk page).
5. The run is scheduled in a quiet window and an owner is watching the dashboards below.
6. Session cookies come from the dev project. The load gate replays production session cookies, which are meaningless after the split, so mint fresh ones as `load-tests/booking/lib/session.js` does.

## The per-IP limiters decide the design

Middleware rate-limits public routes per client IP (`RATE_LIMIT_RULES` in `middleware.ts`): 60 requests a minute on consultant search and recordings browse (`searchLimiter`), 30 on `/api/scheduling/availability/*` (`availabilityLimiter`) and 120 on the availability grid (`availabilityGridLimiter`), all in `lib/rate-limit.ts`. A single k6 runner has one IP, so from the first minute it would measure the limiter's 429 answers rather than the database. The only bypass is localhost outside production (`isBypassableIp`), which does not help against a deployed target.

So the run must either spread the load across several source IPs (k6 Cloud load zones, or several runners), or count 429 answers separately and leave them out of the latency criterion. The rate-limit counters live in Upstash Redis and are shared with production, so a run also writes `rl:*` keys that production reads; this is a second reason to give previews their own Redis database before the run (optional line in the split plan).

## Stages

Each stage ramps up for two minutes, holds for ten, and ramps down for two. Run them in order and stop at the first stage that fails. Do not start the next stage until the previous one's results are recorded.

| Stage | Virtual users | Purpose                                                                                                         |
| ----- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| 1     | 100           | Baseline. Expected to pass. It proves the scripts and the dashboards before load is real.                       |
| 2     | 300           | The lower edge of the expected ceiling. The pooler client count is the number to watch.                         |
| 3     | 1,000         | Past the expected ceiling. It is allowed to fail; what matters is which limit breaks first and how it degrades. |

Use the traffic mix in the next section, not equal weights. Weights are a starting guess and should be replaced with real analytics once there is traffic.

## The ten routes

Every path below exists in `app/`. Public pages are ISR and mostly served from the cache, so they test the cache and the occasional regeneration; the API routes and the signed-in pages test the database path.

| #   | Route                                                             | Why it is on the list                                                                                                                    | Kind           |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | `GET /`                                                           | Every visitor lands here. ISR with `revalidate = 3600`.                                                                                  | Public page    |
| 2   | `GET /explore/experts`                                            | The main discovery listing. ISR with `revalidate = 300`.                                                                                 | Public page    |
| 3   | `GET /explore/experts/[consultantId]`                             | An expert's profile, the page every booking starts from. ISR per expert.                                                                 | Public page    |
| 4   | `GET /api/user/consultants?limit=20&page=1`                       | The search and filter query behind the listing; it is the heaviest public read and sits behind `searchLimiter`.                          | Public API     |
| 5   | `GET /api/scheduling/availability-with-allocation/[consultantId]` | The slot grid the booking page loads; it runs the scheduling engine's reads and sits behind `availabilityGridLimiter`.                   | Public API     |
| 6   | `GET /api/plans/consultations/[consultationPlanId]`               | Plan detail loaded between the profile and checkout.                                                                                     | Public API     |
| 7   | `GET /api/auth/get-session`                                       | Better Auth's session read. Every signed-in page and API route performs the equivalent lookup, so it is the most frequent database read. | Auth           |
| 8   | `GET /api/checkout/context`                                       | The checkout page's tax and credits read, behind `checkoutContextLimiter`. Needs a session.                                              | Signed-in API  |
| 9   | `GET /dashboard/consultee/[consulteeId]`                          | The buyer's dashboard page, a server-rendered page with several statements.                                                              | Signed-in page |
| 10  | `GET /api/dashboard/consultee/[consulteeId]/events`               | The dashboard's appointments feed, which the page and its refreshes poll. The caller must be that consultee.                             | Signed-in API  |

`GET /api/health` is also polled once a second by the harness as a probe, outside the ten. It reports database reachability and the maintenance phase, so a failing probe is the first sign the pooler is saturated. Checkout writes (`POST /api/checkout`) are deliberately not in the ten: they are covered by the load gate, and on a preview a purchase stops at a tentative hold against the real gateway (see the load gate runbook).

## Pass criteria

All four must hold at the stage under test. A stage that fails any of them fails.

1. **Pooler clients under 150.** The Supabase pooler client count, read from the Supabase dashboard's reports for the project, stays below 150 throughout the hold. Micro admits 200, so 150 leaves 25 percent headroom.
2. **p95 under 5 seconds on each of the ten routes.** Measured per route with a k6 tag, so one slow route cannot hide behind fast ones.
3. **At least 95 % of each route's requests answer without a 429.** Report the 429 rate per route; a stage whose limiters refused more than that measured the limiter, not the database, and is re-run from more source IPs before it counts.
4. **Zero `CRON_LOCK_UNAVAILABLE` answers.** This is the 503 a job returns when the database cannot grant its lease (`CronLockUnavailableError`, `lib/cron/cron-lock-errors.ts`). It shows that user traffic starved the job path of connections.

Criterion 4 is measured against the production-context deploy of the split database, the one deploy whose ticker and job doors run jobs; a preview refuses every job (`JOB_RUN_PRODUCTION_ONLY`) before any lease is requested, so it can never show the lock failing. Count the ticker's 503 answers whose body has `code: "CRON_LOCK_UNAVAILABLE"` during each hold.

## Tooling

Use **k6**, the tool already in the repository.

- `.github/workflows/load-test.yml` is a manual workflow that installs k6 and runs `load-tests/smoke.js` against a `base_url`, with seeded credentials from the `LOAD_TEST_EMAIL` and `LOAD_TEST_PASSWORD` secrets.
- `load-tests/smoke.js` is the starting point for the scripts. Its sign-in step, its structure and its availability request (route 5 above, one week ahead) carry over. Its ramp (to 100 virtual users) matches stage 1 only.
- `load-tests/booking/lib/` (`config.js`, `http.js`, `metrics.js`, `report.js`, `session.js`, `thresholds.js`, `window.js`) holds the shared helpers the load gate uses. Reuse them rather than writing new ones.
- `.github/workflows/load-gate.yml` and [the load gate runbook](09-load-gate-runbook.md) cover the booking write storms (checkout, cancel, reschedule, allocate). Run the load gate after this plan's stage 2 passes, on the same isolated database, because the two together exercise reads and writes.

The GitHub Actions budget is exhausted, so a dispatched workflow may refuse to start. Run k6 from a laptop or a rented runner until the budget returns.

Write the k6 thresholds so a stage fails automatically: `http_req_duration{route:<name>}: ["p(95)<5000"]` for each of the ten routes.

## What to watch while it runs

| Where                                       | What to read                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Supabase dashboard (the dev project)        | Pooler client count and the database's active connections, CPU, memory and disk IO, and slow queries.                             |
| Netlify function logs for the target deploy | Function duration, cold starts, 502 and 504 answers, and the edge's roughly 37 second receive timeout (see the deployment skill). |
| Netlify function concurrency                | The site's default of 125 concurrent invocations from the capacity ladder, which can bite before the database does.               |
| Sentry (the preview environment)            | Error rate by route, filtered to the `preview` environment so the run's errors are not confused with production's.                |
| k6 output                                   | Per-route p95, the 429 count, the 5xx count and the probe's failures.                                                             |

## Abort rules

Stop the run at once, by ramping down, if any of these happens:

1. The pooler client count passes 180, which is 90 percent of Micro's 200.
2. The `/api/health` probe fails three times in a row.
3. The 5xx rate on any route stays above 10 percent for one minute.
4. Any request reaches production: a production row changed, or the production deploy's logs show the run's traffic. This means the split is not what it was believed to be. Stop, then revert nothing and investigate the environment variables first.
5. The owner calls it.

After an abort, wait for the pooler client count to return to its idle value before the next attempt, and record the abort reason in the results.

## Results table

Fill one row per stage and keep the table with the run's date, the compute size, the commit and the Netlify deploy id.

| Stage | Date (IST) | Compute | Pooler clients, peak | Slowest route p95 | 5xx rate | 429 count | `CRON_LOCK_UNAVAILABLE` | Verdict |
| ----- | ---------- | ------- | -------------------- | ----------------- | -------- | --------- | ----------------------- | ------- |
| 100   |            |         |                      |                   |          |           |                         |         |
| 300   |            |         |                      |                   |          |           |                         |         |
| 1,000 |            |         |                      |                   |          |           |                         |         |

## Related

Issues #2466 and #2460.

## Deprecated & Superseded Approaches

- **Load testing the shared database.** The smoke workflow's older wording allowed a run against "a staging clone" that was in practice the shared project. Superseded: no run happens before the split.
