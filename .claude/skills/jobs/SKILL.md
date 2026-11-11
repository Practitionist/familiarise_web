---
name: jobs
description: Operational plumbing for this repo's background jobs — the five-minute Netlify scheduled ticker, the cleanup registry and its CRON_SECRET-gated HTTP twins, Postgres execution leases, worker recovery contracts, job-runtime options, maintenance-mode job admission, and the job telemetry pointers (health probe, run metrics, System Jobs). Use when the user says "cron", "scheduled job", "ticker", "registry", "lease", "worker recovery", "run a job by hand", "paused fleet", or is touching netlify/functions/cron-tick.mts, app/api/cleanup/, jobs/, lib/cron/ or the System Jobs admin page. Renamed from `maintenance`; its Next.js caching, Netlify env-sync and serverless-gotcha references now live in the `nextjs` and `deployment` skills.
---

# Jobs

This is the index for how this repo schedules, runs, records and recovers background work. Read the reference that matches the task; the rules that apply to every job are under "Non-negotiables" below.

**Status.** The production job fleet is PAUSED before launch (since 2026-11-05 22:41 UTC). `ops:active_cron_platform` is `paused-prelaunch`, so `cron-tick` stands down on every tick where Upstash answers within 1 s, and the five monitors that would page are paused. The switch fails open, so a tick that cannot read the key still runs the fleet, with its monitors paused. A job that does not run is expected; run one by hand to test it. Resume steps are in `docs/decisions/2026-11-06-pause-scheduled-jobs-prelaunch.md` and the go-live skill.

| Reference                                 | Purpose                                                                                                                                                                       | Read it when                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `references/cron-ticker.md`               | State-as-outbox (ADR 27), why every job has an HTTP twin, the Netlify scheduled ticker, `?limit=` semantics, the checklist for adding a scheduled job.                        | Adding, changing, or debugging a scheduled job or a `/api/cleanup/*` route.              |
| `references/ticker-capacity-and-scale.md` | Tick capacity, state ownership, production-only refusal, the job console, the decided scale path and the owner decisions on job runtime, retention and admin run requests.    | Adding a job, asking whether the ticker has room, or proposing a new scheduler or queue. |
| `references/worker-contracts.md`          | Per-worker recovery, retention, expiry, storage-deletion and maintenance contracts (recording transfer, reminders, expiry arms, invoice capture, exports, retention pruning). | Changing a worker's claim, lease, budget, retention or refund-marker behaviour.          |
| `references/running-by-hand.md`           | Running a job from a terminal, the first-slot trap, `CRON_SECRET`, creating vendor monitors, gotchas.                                                                         | Testing a job, rotating the secret or creating a monitor.                                |
| `references/verification.md`              | Worktree, Prisma client, Jest mapping and mock rules for job tests.                                                                                                           | Writing or running job tests, or typechecking a branch with different models.            |
| `references/job-runtime-options.md`       | Measured job-runtime numbers and the per-runtime footguns (DBOS, pg-boss, Upstash Workflow, QStash, Inngest) and how to rerun each probe.                                     | Someone proposes Inngest, QStash, Trigger.dev, pg-boss, DBOS or Vercel `bom1` for jobs.  |
| `references/prisma-seed-sync.md`          | Bringing the modular seed suite back in sync with the Prisma schema. It stays here until the schema skill is free to take it.                                                 | Seeds fail to compile or a schema change needs seed coverage.                            |
| `docs/maintenance/11-*`                   | Job machinery catalog: how jobs run, record and report, the gaps, the dashboard spec.                                                                                         | Debugging a job that did not run, or building on `SystemJobExecution`.                   |

Moved out: `nextjs-netlify-caching` is in the `nextjs` skill (`references/nextjs-netlify-caching.md`); `netlify-env-sync` and `serverless-gotchas` are in the `deployment` skill (`references/`). Hosting facts for job runtimes are in `.claude/skills/deployment/netlify/job-runtime-options.md`. Booking, support and finance contracts that touch jobs live in those skills.

## Non-negotiables

Use one registered implementation per job and keep the required Netlify standby.
`lib/cron/schedule.ts` owns configured cadence, windows and HTTP request bounds;
the registry does not define phase or timeout fields. Regenerate the AST-derived
inventory with `npm run cron:reference` and verify `npm run cron:reference:check`.
The catalog has no worker, database or environment imports. Every target's
freshness budget for `/api/health/jobs` is derived from it
(`lib/cron/operational-health.ts`), so a new target is absence-monitored the
moment it is scheduled; never hand-list a budget. Every target writes a run row
(`jobNameFor` never returns `null`), and `checkJobCoverage` (`lib/cron/job-coverage.ts`)
fails `npm run build` when a registry job has no target or `MANUAL_ONLY` reason, or a
target has no requirement. The daily `ops-digest` target (03:50 UTC) emails the
operations digest and feeds the release-lag and standing-skip verdicts of that probe
(`docs/decisions/2026-11-02-reliable-jobs-digest-and-release-lag.md`). Its twelve-target figure
(`MAX_TARGETS_PER_TICK`) is a tested design bound; at runtime `capToTick` applies it to the targets left after idle
skips, and the busiest tick holds 11. No Actions workflow schedules a registry job, so a job with
no ticker target runs nowhere.

Every registry entry carries a required `idle` field: either `{ hasWork(db, now, outOfTime) }`, a probe exported from the job's own core module that reuses the job's claim predicate, or `{ alwaysRun: "<reason>" }`. The ticker's slot-claim call (`POST /api/health/jobs/tick?due=...`) runs the probes, then the queue gauges, through `probeTick` (`lib/cron/idle-probe.ts`: one transaction on the single connection with a 750 ms `SET LOCAL statement_timeout`, no statement started after the 2 s budget, and every probe checks `outOfTime()` before each statement and answers "has work" once it is true) and the ticker dispatches only the due targets that were not idle. A throwing probe, a cancelled statement, a probe cut short by the budget, an always-run job and a target the budget never reached are dispatched (fail open). The skip writes no `SystemJobExecution` row: the claim row lists it under `result.idle`, and the health readers (`lib/cron/idle-skips.ts`) count it as a finished run that found nothing. `__tests__/maintenance/idle-probe-drift.test.ts` enforces that a probe shares the `...Where` builders with the claim query.

Cron leases are Postgres-backed. Closed jobs never run when acquisition fails,
including Prisma import failures. Completion is conditional on the same execution
still being RUNNING; only successful owned completion advances freshness. Typed
outcomes and `X-Job-Outcome` distinguish partial failure and intentional holds.
Different jobs can still touch the same row: preserve CAS, transactional staging
and vendor idempotency, and test cross-job races and sequential replay.

The scheduled ticker has a 30-second budget, distinct from its HTTP workers.
A timeout or expired lease does not cancel vendor effects. Fleet selection fails
open on absent/unreadable `ops:active_cron_platform`, so it is not an exactly-once
guarantee. Verify accepted Sentry check-ins and independent per-capability absence
alerts; the shared heartbeat and HTTP200 alone do not prove complete health.

The infrastructure orientation at `docs/start-here/09-infra-and-maintenance-sre-orientation.md` is the onboarding and portability guide. Keep its guarantees, failure limits and pending-versus-active scheduler ownership synchronized with source; the generated inventory owns counts, and GitHub comments alone are not architecture documentation. Keep the Stream-owned worker runbooks linked for active-host, execution-envelope and deployment verification constraints.

Detail for each worker is in `references/worker-contracts.md`; the testing rules for jobs are in `references/verification.md`.
