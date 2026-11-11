# ADR: Ticker through launch, the scale path, the phase 2 queue and the database plan

- **Status**: Accepted on 2026-10-31. Decision 1 ships in the pull request that adds this record. Decisions 2 to 4 are direction: nothing in them is built yet, and each names what has to be true before it is. Decision 5's refusals are built; its split is not. Decision 6 ships in a separate Sentry-policy pull request.
- **Date**: 2026-10-31
- **Author**: Platform engineering
- **Supersedes**: the phase 1 container option and the "split before launch" timing in [Architecture at scale review](2026-10-30-architecture-at-scale-review.md)
- **Related**: [Job machinery catalog](../maintenance/11-job-machinery-catalog.md), [Deployment and pooling](../deployment/README.md), [The ingest canary](../observability/sentry/06-ingest-canary.md), issues #2466 (ticker and Sentry readiness), #2472 (scale path research), #2460 (runtime assumptions), #2095 (Mumbai host)

## Context: where the system stands on 2026-10-31

- **Jobs.** All 76 registered jobs run from one Netlify scheduled function, `netlify/functions/cron-tick.mts`, which fires every five minutes. On each tick it calls each due job over HTTP (`/api/cleanup/<slug>`), or calls a Netlify background function for the six long Stream and recording jobs. No GitHub Actions workflow schedules a job.
- **Ticker health.** In 36 hours of production logs, 3 of about 4,350 target calls failed (0.07 %). The slowest tick took 18.5 s against Netlify's 30 s limit for a scheduled function.
- **Capacity.** The schedule has 288 ticks a day × 12 slots = 3,456 slots and uses about 2,876 of them. The busiest tick runs 11 targets, and the cadence test keeps every tick at 11 or fewer.
- **The real limit is the database path, not the scheduler.**
  - Netlify runs functions in Singapore (`sin`) and has no Mumbai region. The database is Supabase in Mumbai (`ap-south-1`).
  - Each SQL statement therefore costs about 95 ms of round trip, so a page that runs 30 statements in sequence spends about 3 s waiting on the network.
  - Each function instance holds one database connection (`PG_POOL_MAX=1`), and the Supabase Free pooler admits 200 clients.
  - Together these put the first user-facing ceiling at roughly 300 to 500 concurrent users.
- **Database.** One Supabase project on the Free plan serves production, previews and dev. It holds mock data only; no real customer has paid yet.

## Decision 1. Keep the Netlify ticker through launch, hardened

The ticker stays the only job engine until a trigger in decision 2 fires (AGENTS.md rule 4: one scheduler). The hardening ships with this record:

| Change                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                             | Enforced by                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Cap 12                                 | `MAX_TARGETS_PER_TICK` goes from 10 to 12, with one free slot on every tick                                                                                                                                                                                                                                                                                                                                                                              | `lib/cron/schedule.ts`; the cadence test in `__tests__/maintenance/cron-tick-targets.test.ts` |
| 11 jobs moved                          | The housekeeping, compliance and retention jobs that lived only in the unfunded Actions workflows now run on the ticker at their old cadence (two hourly, six daily, three weekly). The workflows and their wrapper scripts are deleted                                                                                                                                                                                                                  | `TARGETS`, `TARGET_EVERY_MINUTES` and `TARGET_WINDOWS` in `lib/cron/schedule.ts`              |
| Background functions record and return | A failed background run is logged, and recorded as a `FAILED` run row when the route could not record it itself. It is never thrown, so Netlify's automatic retries after one and two minutes do not fire                                                                                                                                                                                                                                                | `runBackgroundWorker` in `lib/cron/background-worker.ts`                                      |
| Background outcomes count              | The ticker treats a 202 as admission only. It reads each background target's newest finished run and counts the target as failed when that run failed                                                                                                                                                                                                                                                                                                    | `failedBackgroundTargets` in `cron-tick.mts`; `lastRunFailed` in `lib/cron/failure-streak.ts` |
| One retry                              | A target whose request never reached the app is retried once while at least 5 s of the tick's budget remain. That means a connection failure (not the ticker's own timeout) or Netlify's own 500 page. A 409 on the retry keeps the first failure                                                                                                                                                                                                        | `isRetryable` and `hitTargetOnceMore` in `cron-tick.mts`                                      |
| Slot de-dupe                           | The tick id is derived from the five-minute slot. The tick claims it by inserting a `SystemJobExecution` row whose primary key is that id (`jobName` `cron-tick`). A second dispatch of the same slot collides and stands down. The claim lives in Postgres, not Redis (AGENTS.md rule 4.4). These claim rows are bookkeeping: the job console, the executions list and `/api/health` leave them out, and the 90-day prune removes them like any run row | `POST /api/health/jobs/tick`; `TICK_CLAIM_JOB` in `lib/cron/schedule.ts`                      |
| Better Stack heartbeat                 | Each completed tick sends one GET to `BETTERSTACK_HEARTBEAT_URL`, with a 2 s timeout, and never fails the tick. Unset means no ping. A missing ping is the "did not run" signal                                                                                                                                                                                                                                                                          | `pingHeartbeat` in `cron-tick.mts`                                                            |
| Production-only dispatch               | The ticker and the background functions stand down on any deploy whose `context.deploy.context` is not `production`. `dispatchBackgroundJob` refuses outside the production environment with a typed 409 (`BACKGROUND_DISPATCH_PRODUCTION_ONLY`) recorded as a `CANCELLED` refused run. The background functions also refuse a request without the `CRON_SECRET` bearer before any work                                                                  | `offProductionDeploy` in `lib/cron/deploy-context.ts`; `lib/cron/dispatch-background.ts`      |

**Worked example.** At 10:40:16 UTC Netlify fires the tick for the 10:40 slot. The tick derives its id from `2026-10-31T10:40:00.000Z` and inserts the claim row, then dispatches 11 targets. Six seconds later Netlify fires the same slot a second time, which happened on 3.5 % of slots in the measured window. The second invocation derives the same id, its insert hits the primary key, and it answers `{duplicate: true}` without calling a single job, sending a second Sentry check-in or pinging Better Stack.

**The free slot binds new jobs (owner decision, 2026-10-31).** Every 15-minute phase already has a tick at 11 targets, so no new 15-minute job fits. A 400-day simulation showed that moving five unrelated hourly and daily jobs still left 800 ticks at 12. The digital products recovery sweep `reconcile-standalone-purchases` therefore runs hourly at :45, the one phase band (:40 to :50) with room. It is the fallback behind the webhook and the buyer's verify route, so only a purchase both of those miss waits up to an hour. Its paging health SLO in `lib/cron/operational-health.ts` is 150 minutes, two intervals plus 30. A future job that needs a 15-minute cadence needs either a new owner decision on the cap or the phase 2 queue.

## Decision 2. The scale path: trial Vercel Pro in Mumbai before about 300 concurrent users

- **What.** Before sustained traffic approaches about 300 concurrent users, trial the web tier on Vercel Pro in `bom1` (Mumbai), with Vercel Cron as the ticker. It calls the same `/api/cleanup/<slug>` routes and the same registry, so no job is rewritten.
- **Background jobs.** The six recording and Stream jobs dispatch to Netlify background functions (`/.netlify/functions/...`), which the cleanup routes do not replace. Before Vercel Cron takes ownership, those six need equivalent Vercel targets; until they exist, Netlify keeps the ticker.
- **Standby.** Netlify stays the hot standby (AGENTS.md §2.5). The fleet switch `ops:active_cron_platform` picks which host's scheduler runs, so the two never both fire.
- **Why Vercel.** Running in Mumbai brings a statement to about 1 to 2 ms. Fluid compute lets one instance serve many requests at once, so connections are shared instead of one per request. That one move removes both causes of the 300 to 500 user ceiling for users and jobs alike.
- **No QStash.** QStash is not adopted unless a job needs per-message delivery (an exact-time send, or a retry per item). It would be a second scheduler and another vendor in the failback path.
- **Rejected on cost.** The always-on container plan for web plus worker in Mumbai (Cloud Run, Fly or Fargate, about $100 to $440 a month) was rejected on cost.
- **To verify during the trial:** the Pro cron limits, the function duration cap and the Fluid CPU pricing in `bom1`, measured at our traffic.

## Decision 3. No hosted job service, because none fixes the latency

Inngest, Trigger.dev, Hatchet, Temporal Cloud and QStash all schedule work by calling back into our own functions. Our functions still run in Singapore, so every statement still pays about 95 ms. None of these services hosts compute in India. A hosted job service would add a vendor and a second scheduler, and leave the database path, which is the actual bottleneck, unchanged. The only remedy for the 95 ms is code that runs in Mumbai, which decision 2 provides.

## Decision 4. The phase 2 queue is a hand-written Prisma `Job` table with `SKIP LOCKED`

- **What.** When jobs move from timed sweeps to enqueue-on-change, the queue is one Prisma model plus a small worker:
  - the job row is written in the same transaction as the state change (for example, "refund owed");
  - the worker claims rows with `SELECT … FOR UPDATE SKIP LOCKED`;
  - retries back off, a dedupe key prevents double work, and a job that exhausts its retries is dead-lettered.
- **Why.** It stays inside Postgres and Prisma, the operations console can read it, and it needs no library that manages its own schema.
- **Why not pg-boss or graphile-worker.** Both do the same job, but pg-boss keeps its own schema outside Prisma and the `db push` flow.
- **Where it runs.** It can run on the ticker first, draining one slice per tick, and in an always-on worker later. The existing sweeps stay as hourly or daily safety nets.
- **Redis.** No Redis queue: Redis pub/sub is fire-and-forget, and Redis Streams would need a dual write and break AGENTS.md's Redis scope.

## Decision 5. Supabase stays Free on the shared database until real customers

- **Plan.** The single Supabase project stays on the Free plan while it holds mock data, and moves to Pro before the first real customer pays. Pro adds daily backups, no pausing and more disk.
- **Compute.** Small compute (400 pooler clients) is the next step, at about 150 sustained concurrent users.
- **Split deferred.** The split into separate production and preview databases is deferred until after launch. This reverses the 2026-10-30 timing of "split before launch".
- **Load test.** The load test waits for the split, because a load test against the shared database would load production too.
- **Owner decision (2026-10-31).** The shared database stays until customers arrive and Supabase moves to Pro. The split is planned in [the database split plan](../deployment/db-split-plan.md) (a second project, not branching), and the load test in [the load test plan](../enterprise/50-operations/11-load-test-plan.md) waits for it.
- **Mitigation until then (built).** Four pieces keep a preview from acting on production through the shared database:
  - **Job refusal.** Every preview and branch deploy refuses every job, money or not, with 409 `JOB_RUN_PRODUCTION_ONLY`. `cleanupRoute` (`lib/cron/cleanup-route.ts`) checks `jobsMayRunHere()` (`lib/cron/dispatch-refusal.ts`) after the bearer check, so the CRON_SECRET door and the admin Run door (`POST /api/admin/system-jobs/run`) both refuse. The refusal writes one `CANCELLED` run row with outcome `refused` and sends nothing to Sentry. The money console's batch doors (`POST /api/admin/reconcile/[job]` and `POST /api/admin/reconcile-ledgers`) refuse with the same code through `OpsRefusal`, before any runner starts. Production runs jobs, and so does a local `next dev` or jest process, which is not a deploy; each preview and branch deploy also holds its own `CRON_SECRET`.
  - **Production-only shared writes.** `mayWriteProductionState()` (`lib/production-state.ts`) gates the maintenance window and its Redis mirror, the discount-code pause and its snapshot, and the `cron:heartbeat:last` key that `/api/health` reads as production's dead-man signal. The admin maintenance route answers 409 `MAINTENANCE_PRODUCTION_ONLY` off production. Local development is off production here too.
  - **Environment filter on the job console.** `readJobRunMetrics()` (`lib/backoffice/job-run-metrics.ts`) filters counts, percentiles, daily buckets and the last success by `result.environment`, the System Jobs page takes `?env=`, and the Recent Executions list filters the same way. No schema change was needed.
  - **Release schema gate.** `scripts/ci/check-db-schema-required.ts --live` fails a release when the schema declares a table, column, enum type or enum value that the live database lacks. It is read-only and ignores sidecar objects and objects only the database has. It runs as the "Release schema gate" job in `.github/workflows/db-live-drift.yml` on pull requests into `prod`.

  Shared keys left deliberately shared: rate-limit buckets, slot locks, the payout and checkout mutexes, account-throttle locks, reminder dedupe and the meeting Q&A keys. `ops:active_cron_platform` is only read.

## Decision 6. Sentry: escalations only, and a canary that does not spend the error quota

The Sentry-policy pull request will make Sentry carry escalations only. The ingest canary stops storing an error event every six hours, which spends about 120 of the 5,000 monthly errors. In its place:

- the Sentry `stats_v2` API reports rejected events (`error_usage_exceeded`);
- a Resend email alerts out of band, so a Sentry outage cannot silence the alert;
- the Better Stack heartbeat and summary line carry "the tick ran".

Until that pull request merges, the canary in `docs/observability/sentry/06-ingest-canary.md` is current.

## Consequences

- Jobs keep paying about 95 ms per statement until decision 2's trial. The idle fast paths added with decision 1 cut the waste in the busiest sweeps, but they do not remove it.
- A job added to the schedule must fit under the 11-per-tick pin, or shift existing offsets until it does.
- The shared database remains the main safety risk until the split. Previews can no longer run jobs or flip production's maintenance and heartbeat state, but an ordinary request on a preview still reads and writes production tables (a booking, a profile edit), and rate-limit and lock keys are shared.
- A job cannot be exercised on a preview any more, so job changes are checked locally with `next dev` or on production after release.
- **Superseded in part (2026-11-11).** Decision 5's timing of Supabase Pro is now a trigger kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend) rather than a calendar date. One constraint stays here because it is about data safety, not price: the project moves to a plan with backups before the first real customer data (a real-money booking on the platform) is stored, so the Free plan holds mock data only. See [the 2026-11-11 levers record](2026-11-11-cfo-csmo-levers.md).

## Deprecated & Superseded Approaches

- **GitHub Actions cron fleet.** The three cron fleet workflows and their wrapper scripts were deleted; the GitHub Actions minutes budget is exhausted and those workflows had stopped running.
- **Phase 1 "web plus worker in a Mumbai container"** from the 2026-10-30 review. Superseded by decision 2 on cost.
- **"Split the database before launch"** from the 2026-10-30 decisions. Superseded by decision 5.
