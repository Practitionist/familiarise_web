---
name: maintenance
description: Operational plumbing for this repo's Next.js-on-Netlify deployment — the state-as-outbox cron architecture and the five-minute Netlify scheduled ticker, every job's CRON_SECRET-gated HTTP twin under app/api/cleanup/*, how Next.js App Router routes render/cache/revalidate on Netlify (static vs ISR vs dynamic, the traps that make a route silently dynamic), syncing environment variables between .env and the Netlify production deployment, keeping the modular Prisma seed suite in sync with the schema, and hard-won serverless-only failure modes (the react-pdf two-React clash, the PG_POOL_MAX=1 deadlock, after() as best-effort, CodeRabbit review mechanics, strict-protection PR trains). Use when the user says "cron", "scheduled job", "Netlify env", "ISR", "revalidate", "seed data", "500 only on the deployed build", or is touching netlify/functions/, app/api/cleanup/, jobs/, lib/cron/, or prisma/seed.ts.
---

# Maintenance

This is the index for operational and deployment plumbing that is not specific to any product domain — crons, environment sync, caching, seeds, and the Netlify/serverless failure modes that only show up on a deployed build.

| Reference                              | Purpose                                                                                                                                                                                                                                                              | Read it when                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `references/cron-ticker.md`            | State-as-outbox (ADR 27), why every job has an HTTP twin, the Netlify scheduled ticker, `?limit=` semantics, workflow concurrency groups, the checklist for adding a scheduled job.                                                                                  | Adding, changing, or debugging a scheduled job or a `/api/cleanup/*` route.                              |
| `references/netlify-env-sync.md`       | Auditing and synchronizing environment variables between the local `.env` and the Netlify production deployment.                                                                                                                                                     | Asked to sync env vars to Netlify, or after adding a new service key.                                    |
| `references/nextjs-netlify-caching.md` | Deciding and verifying how an App Router route renders and caches on Netlify — static vs ISR vs dynamic, revalidate windows, the traps that make a route silently dynamic.                                                                                           | Adding or changing `dynamic`/`revalidate`/`generateStaticParams`, or a page is slow or SSR looks empty.  |
| `references/prisma-seed-sync.md`       | Bringing the modular seed suite back in sync with the Prisma schema after a schema change.                                                                                                                                                                           | Seeds fail to compile, a schema change needs coverage, or seed data needs updating.                      |
| `references/serverless-gotchas.md`     | Hard-won runtime facts specific to Next.js on Netlify with Prisma/Postgres — the react-pdf two-React failure, the single-connection pool deadlock, `after()` as best-effort, Netlify scheduling and log facts, CodeRabbit mechanics, strict-protection merge chains. | Debugging a 500 that only happens on the deployed build, wiring server-side PDFs, or running a PR train. |
| `references/job-runtime-options.md`    | Measured job-runtime numbers, the per-runtime footguns (DBOS pool, pg-boss first-minute cron, Upstash Workflow re-runs, QStash 504 retries, Inngest manual sync) and how to rerun each probe.                                                                        | Someone proposes Inngest, QStash, Trigger.dev, pg-boss, DBOS or Vercel `bom1` for jobs.                  |
| `docs/maintenance/11-*`                | Job machinery catalog: how jobs run, record and report, the gaps, the dashboard spec.                                                                                                                                                                                | Debugging a job that did not run, or building on `SystemJobExecution`.                                   |

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

Recording transfer is ticker-owned every 15 minutes through its existing background adapter. Keep 202 admission separate from successful core completion. Its requested fail-closed 15-minute lease is capped on Netlify at 90 seconds, renewed every 30 seconds; renewal loss does not cancel the core, so preserve domain claim and publication fencing. The recording's stale-claim threshold remains 15 minutes. Session recovery runs via HTTP at :10/:40. The five daily lifecycle targets queue the narrow `stream-maintenance-background` worker in staggered daily windows; their Actions steps are removed. All six migrated cores fail closed, and each daily lifecycle job has a 28.5-hour freshness budget. See `docs/stream/09-background-sync.md` for slice bounds and continuation.

Appointment reminders require a Postgres lease before staging email. If lease
acquisition fails, the run fails without delivery; the next ticker run retries
within the existing reminder window. Staged email reads prevent sequential
replay, but do not provide atomic deduplication for overlapping unlocked runs.

Cron leases are Postgres-backed. Closed jobs never run when acquisition fails,
including Prisma import failures. Completion is conditional on the same execution
still being RUNNING; only successful owned completion advances freshness. Typed
outcomes and `X-Job-Outcome` distinguish partial failure and intentional holds.
Different jobs can still touch the same row: preserve CAS, transactional staging
and vendor idempotency, and test cross-job races and sequential replay.

Support attachment cleanup shares the existing row with upload finalisation.
Only already grace-eligible objects enter its at-most-100-path ownership batches:
conditionally tombstone expired pending rows, reread live references, then remove
unprotected objects outside a transaction. Never delete from an orphan snapshot
alone or revive a tombstone after an ambiguous storage failure. A later sweep
retries grace-eligible bytes; fresh rejected objects retain their seven-day grace.
Process ownership and removal batches sequentially to bound vendor pressure.
Keep finalisation's in-transaction evidence-response recheck even when preflight
validation is extracted into a helper; transaction reads must use its tx client.
This fence does not bound whole-bucket listing; see
[attachment ownership](../../../docs/support/04-evidence-and-attachments.md#finalisation-and-cleanup-ownership)
for the current flow.

The scheduled ticker has a 30-second budget, distinct from its HTTP workers.
A timeout or expired lease does not cancel vendor effects. Fleet selection fails
open on absent/unreadable `ops:active_cron_platform`, so it is not an exactly-once
guarantee. Verify accepted Sentry check-ins and independent per-capability absence
alerts; the shared heartbeat and HTTP200 alone do not prove complete health.

For shared storage deletion, preserve `removeObjects()`'s receipt-or-`NoSuchKey`
metadata contract. The installed SDK can return `exists().data=false` for an
ambiguous HTTP 400; this deployment also uses 400 for a genuine missing key.
HTTP status or that boolean alone is insufficient. Preserve caller retry/error
handling when confirmation fails. Plan-material removal commits its row first,
so unresolved vendor cleanup remains a separate obligation; see
`docs/storage/management-strategy.md`.

Maintenance bypass cookies remain short-lived HMAC-SHA256 tokens verified via Web
Crypto. Follow the active maintenance implementation and recovery instructions;
never infer that a cached phase quiesces work already in flight. See the linked
references for transaction-client, deployed-runtime and environment constraints.

The infrastructure orientation at `docs/start-here/09-infra-and-maintenance-sre-orientation.md` is the onboarding and portability guide. Keep its guarantees, failure limits and pending-versus-active scheduler ownership synchronized with source; the generated inventory owns counts, and GitHub comments alone are not architecture documentation. Keep the Stream-owned worker runbooks linked for active-host, execution-envelope and deployment verification constraints.

PATCH updates require a validated non-empty reason, including ETA-only changes; use that value for incident and audit text. Maintenance retries preserve the active window's configuration and repeat OFFLINE setup until its completion stamp exists. Recovery checks database, Redis and chat before incident resolution and phase change. Preserve sequential session and channel-batch admission checks, paced vendor batches, transaction-client writes and ordered sidecar statements; a loop await is required when the next step depends on its predecessor or remaining budget.

Mocks of `maintenance-cron` must provide both exported error constructors: cleanup error mapping uses `instanceof` to distinguish unreadable state from planned holds.

Tests that mock `with-cron-lock` for recording retention must also provide `readJobCheckpoint` (usually resolving `null`); the retention core reads its saved cursor before scanning.

Capture assertions that mock `@sentry/nextjs` must alias `@sentry/core` to the same mock, so native-worker helpers and Next.js routes share the asserted capture functions. Partial mocks spread the actual Core module, avoiding a circular import through the actual Next.js SDK.

Revalidate a confirmed booking’s live overlap inside the cancellation transaction before loading its full graph. Bootstrap missing maintenance edge state from the durable platform state before deploying fail-closed readers; never overwrite an active window with OFF. The release owner applies the exact reviewed SQL and performs the conditional no-TTL edge bootstrap immediately before merge; coding agents do not perform either operation. Unreadable-state GET protection on checkout verify applies only to `sync=true`, because the plain status poll is read-only.

The 48-hour paid-unallocated arm of `expire-stale-requests` commits EXPIRED,
history, `sub-unalloc:<paymentId>` full-refund markers and its bell together.
It stages new obligations only in a winning current expiry transaction; it
never stamps already-expired unmarked rows. Keep existing markers/attempts, hold an oversized payment envelope
without partially expiring its liabilities, and preserve visible backlog on
errors or deadline truncation. Exhausting only the remaining invocation allowance
is a deferral, not an envelope error; stop the ordered page for the next run. Its shared 16-second admission budget covers
only this family; earlier expiry arms and nudge fairness remain separate work.
Do not describe the entire worker as deadline-bounded or its backlog as drained. `unallocatedHasMore` includes retired/foreign-owned obligations needing operator review; it is not a signal to keep automatically driving retries.
When extracting these phases, retain the same deadline closure and ordered fresh
payment allowance; keep earlier staged markers available for the delivery phase.

Raw SQL must follow Prisma's physical `@map`/`@@map` identifiers; the subscription
status column is `requestStatus`. Derive disposable SQL fixture identifiers from
the generated schema metadata, and verify query planning read-only before making
production capacity claims.

## Running a job by hand, secrets and vendor monitors

Reasons and alternatives: `docs/decisions/2026-11-05-detector-rollout-and-redundancy.md`.

- **Run a job from a terminal:** `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://familiarisenow.com/api/cleanup/<registry-key>`. It prints the job's JSON result and records a production-tagged run. Use the registry key in the URL; the run row's `jobName` can differ (`tds-return-draft` writes `tds-26q-draft-export`; `jobNameFor` in `lib/cron/schedule.ts` maps them). System Jobs "Run now" is the in-process alternative with less detail.
- **A windowed job's first-ever slot holds the probe red.** If `/api/health/jobs` answers 503 `JOB_OVERDUE` for a weekly or quarterly job that never ran under a production-tagged row, run it once by hand, then poll the probe.
- **`CRON_SECRET` is a write-only Netlify secret.** The CLI, API and dashboard show `****`; GitHub secrets are write-only too. Never try to retrieve it: rotate it, keep one copy in the owner's password manager, and never paste it into a doc, ticket, chat or persisted command line. Rotation updates three places (Netlify production, the Better Stack probe monitor, the Sentry uptime detector). Both vendors store the header value, so a leak there means rotate.
- **Create vendor monitors with each vendor's API or CLI, never by clicking.** Better Stack: `https://uptime.betterstack.com/api/v2/monitors` and `/heartbeats` with `BETTERSTACK_API_KEY`. Sentry: `sentry api /organizations/<org>/detectors/<id>/ -X PUT --input -`, body on stdin. No Terraform (AGENTS.md §1.2). The app never creates vendor monitors.
- **A monitor is done when it reads `up`, not when it exists.** A created-paused heartbeat detects nothing. Read it back and require `paused: false` and status `up`.
- **Gotchas.** macOS has no `timeout`, so a `timeout 40 cmd` loop silently fails and looks like "unset". `netlify env:get` prints secrets as `***`. Netlify env changes apply only at the next deploy. Better Stack `paused` is settable on create and by PATCH.

## Worktree verification

Every infrastructure, maintenance or observability PR updates its applicable
domain docs and skill in the same change. Document triggers, ownership/leases,
failure and recovery behavior, operational prerequisites, verification and
rollback where developers will find them. Keep the current index and links
accurate; GitHub comments supplement the runbook rather than replacing it.

Worktrees share the generated Prisma client through canonical `node_modules`.
Before typechecking a branch with different models, regenerate from that branch’s
schema and coordinate with other compilers. Generation does not apply DDL; a
missing generated model and a missing live table are different failures.

The Jest configuration keeps an explicit `@/` source mapping while retaining Next.js’s default mocks and transforms. Run targeted suites through the repository config. A CLI `--moduleNameMapper` replaces the entire map and can discard `server-only`, asset and Redis-edge mocks; do not use it as a shortcut for alias resolution.

Pure server-job suites use `@jest-environment node`, matching their deployed runtime. Transitive Next.js request imports require Node's web globals; do not hide an import failure by adding browser polyfills to backend tests.

When merging a worker migration, port its roster, limit, timeout and ledger-yield changes into the shared catalog; do not restore the adapter’s former inline schedule. Check generated output against the same inputs before and after generator refactors. Keep blank workflow names within their own source block and preserve escaped Markdown pipes. See `references/cron-ticker.md` for the current document-purge schedule and mocked verification boundary.

Stream background adapters currently target Netlify function URLs. Automatic
execution requires Netlify as active cron host; a host switch needs an equivalent
execution target. Keep lifecycle worker imports free of request authentication
and check actual native packaging, including CLI guards, before scheduling.

## Worker recovery contracts

Credit-note and bank-receipt adjustments retain invoice checkout references for
gateway inspection, including bank-paid invoices. Retire only the exact inspected
PAID pointer with its audit after captured liability commits or an empty/unpaid
order is confirmed. Provider reads stay outside transactions and within the
existing budget. An empty read does not revoke an old checkout; audit history is
for operators, not an automatic recovery queue.

Read [worker recovery](../../../docs/maintenance/12-worker-recovery.md) before changing export claims, artifact expiry or booking-expiry refunds. Export attempts use the exact `startedAt` token for claim and finalization CAS, an independently retained exact storage owner before upload, and immutable paths. Preserve READY with its audit and existing notification outboxes; never let postcommit delivery write FAILED or expose raw errors. Its logs carry only operation/export identifiers, never provider exceptions or transport payloads. Expiry requires successful exact remote absence evidence before retiring the owner. The operator applies only the reviewed additive schema before deploying the new reader. The cutover resets mock data; never adopt old artifact pointers or retrospectively stage old expiry rows.

Pending-consultation and approved-unallocated expiry commit full-remaining owed-refund markers in the same transaction as the winning EXPIRED transition. Reuse existing arm keys and refund retry ownership. Unpaid pending-subscriptions still exclude successful payments; do not broaden money eligibility. Completion freshness for these workers is not proof of backlog drain or actual alert receipt.

Keep a short marker-count race local to its request: roll back its transition and
history, preserve the competing writer's marker/retry state, and continue later
requests. Existing partial markers also hold only their own request; retain
their fields and exhausted retries, and report the aggregate hold as unsuccessful
completion while later requests proceed. Exclude these holds before the oldest
page limit, checking their presence after selection and rechecking each request
transactionally for races.
Do not turn unrelated staging failures
into successful skips. Preserve retry of already-persisted obligations without
creating retrospective markers from old expiry history. Export
expiry requires exact metadata `NoSuchKey` after removal; a generic 404 or an
`exists()` false value with an error is insufficient. Download lifetimes use a
fresh post-lookup clock and must be rechecked after signing and audit latency.

Invoice capture recovery runs through the registered `reconcile-org-invoice-payments` core, its fail-closed Postgres lease and execution-result checkpoint. It rotates at most five retained order references per four-hour slot, with ten-second row admission and five-second provider waits. Existing settlement stages durable notices; relays deliver them. Preserve the six spare calendar slots and test every tick across 400 days when changing this schedule. Twelve-hour completion health is execution evidence, not a per-invoice recovery SLO; lost order references and cohort capacity remain separate gates. See `docs/maintenance/12-worker-recovery.md` and `13-readiness-and-operating-gates.md`.

Destructive retention must be bounded for every caller, repeat eligibility in the final write, and preserve active obligations and retention timestamps. See [job history and messaging retention](../../../docs/maintenance/messaging-retention.md): a page per table per call, at most 500 rows per page (run history drains in 1,000-row batches within the budget), a shared 16-second caller start budget across driver slices and lease admission, and explicit `hasMore`. A missing heartbeat is not proof that an old process has stopped. Verify concurrency with the guarded disposable database tier; never run it against the shared database.

Auth tokens/invitations, webhook archive, onboarding drafts and audit retention have bounded canonical defaults and a shared 16-second admission budget per invocation. Every destructive write repeats current age/status eligibility. Read `docs/maintenance/housekeeping-bounds.md` for per-phase versus global limits, continuation and the existing bounded audit CLI. Keep deadline checks before continuation probes and process organisation transactions sequentially so the next admission check includes prior commit time. Preserve category retention and expiry policy; a work bound is not permission to shorten retention. The windows are in the compliance skill's `references/retention-windows.md`; fold a new prune into `prune-audit-logs` or `prune-system-job-executions` instead of adding a ticker target, and never prune a live booking's `BookingStatusHistory` rows. Failures or time-budget holds retain `hasMore`; a failed oldest page needs repair rather than silent skipping.

Auth-token Verification and IdempotencyRecord pages and the audit pages share `deleteBoundedPage`: preserve the shared start budget, caller-owned eligibility predicates and committed counts when the continuation probe fails. The auth-token Session and SessionAccessLog phases drain 100-row pages until one is short, one fails or the budget is spent (no probe; `hasMore` only on a budget stop or failure), and a Session page is deleted and its removed rows stamped in one transaction, which a failed stamp rolls back. `archive-webhook-events` instead repeats 2,000-row `DELETE ... WHERE id IN (SELECT ... LIMIT n)` batches until one is short or the budget is spent, like run history.

## Support auto-close progress

Preserve support refusal, payout-release and chat-ending transactions. Rotate admitted auto-close attempts with the nullable `SupportCase.autoCloseLastAttemptAt` eligibility/prior-attempt CAS stamp; never change business clocks to poll. Expected recommendation/maintenance holds have bounded samples, while unreadable maintenance remains failure. The 16-second start budget covers only auto-close. The owner applies the exact additive SQL before readers; use read-only catalog verification and the current [sweep runbook](../../../docs/support/07-sla-sweep.md#auto-close-schema-rollout).

## Direct upload commit retries

For plan-material commits, check session, rate limit, current plan-management access and payload/file policy before replaying by plan type, plan ID and storage path. Return committed rows before storage probes. Pre-verification policy rejection preserves the upload: a corrected concurrent retry may commit it, and a reference count cannot fence external deletion. Keep the committed-row lookup outside cleanup catches so database errors preserve the upload too. First-attach verification stays outside the transaction, inside its existing refusal-cleanup try/catch; the locked transaction repeats replay before the material cap and insert. Run the full document suites and direct mock dependants with `--maxWorkers=2`; see `docs/documents/README.md` for the replay and orphan-cleanup limits.

## Ticker capacity, state ownership and the scale path

- **Capacity.** The ticker has 288 ticks a day × `MAX_TARGETS_PER_TICK` (12) = 3,456 slots. All 80 registered jobs now run on it and use about 2,900 starts on a typical weekday (about 85 %); the busiest tick has 11 targets and the cadence test pins that at 11 or fewer, so every tick keeps one free slot. Before adding a job, check that a slot exists in its window, or bundle it. The growth limit is database connections (one per function instance), not the tick's 30 seconds. The trigger for leaving the Netlify ticker is a tick that would need a 13th slot, p99 ticks above 24 s, or pooler pressure; the decided path is the Vercel `bom1` trial below.
- **Jobs are slices, not long runs.** Each run takes a `?limit=`, a 16-second deadline, a saved cursor and a 90-second lease. Long work goes to a background function. A crashed run's lease expires and the next run takes over.
- **State ownership.** Jobs may touch the same rows. Correctness comes from the database, not from job order: CAS status writes, Serializable retry, constraints and triggers, and gateway idempotency keys. A new writer of a status column must appear in the state ownership matrix (#2466), and `result.counters.casMiss` is the live signal for contention.
- **Off production, jobs refuse.** `cleanupRoute` calls `jobsMayRunHere()` (`lib/cron/dispatch-refusal.ts`) after the bearer check and before the maintenance guard, for the `/api/cleanup/[job]` door and the admin Run door (`POST /api/admin/system-jobs/run`, which calls `handlers.invoke`). A preview or branch deploy answers 409 `JOB_RUN_PRODUCTION_ONLY` (`JobRunRefusedError`, run-row reason `job-run-production-only`) with `X-Run-Outcome: refused`, one zero-duration `CANCELLED` row and no Sentry event; the System Jobs panel shows a non-error toast. The money console's batch doors (`/api/admin/reconcile/[job]`, `/api/admin/reconcile-ledgers`) answer the same code through `OpsRefusal`. Background dispatch still refuses with `BACKGROUND_DISPATCH_PRODUCTION_ONLY`; both extend `ProductionOnlyRefusal`. The admin door's `manualRun: "after"` path (payout jobs) is used only when `jobsMayRunHere()`, so a refusal answers inline instead of 202. Local `next dev` and jest still run jobs.
- **Production-only shared state.** Gate any new write to state another deploy would flip (maintenance, the heartbeat, discount snapshots) with `mayWriteProductionState(key)` (`lib/production-state.ts`). It already guards `setMaintenanceState`, `pauseDiscountCodes`/`restoreDiscountCodes` and `touchRedisHeartbeat` (`cron:heartbeat:last`); keys such as `rl:*`, slot locks and payout mutexes stay shared on purpose.
- **The job console filters by environment.** `readJobRunMetrics(environment, now)` (`lib/backoffice/job-run-metrics.ts`) filters counts, percentiles, IST daily buckets and the last success by `result.environment`; the page takes `?env=production|preview|development` and the executions list takes `?environment=`. `withCronLock` stamps `result.environment` when it opens the `RUNNING` row. Netlify's `deploy_context` is a Sentry tag only, so `branch-deploy` and `deploy-preview` both record `preview`.
- **The scale path** is decided in `docs/decisions/2026-10-31-ticker-scale-path-and-queue.md`: the Netlify ticker stays through launch; before about 300 concurrent users the web tier is trialled on Vercel Pro in `bom1` with Vercel Cron as the ticker and Netlify as hot standby (the fleet switch picks one); no hosted job service (none runs compute in India, so none removes the per-statement cost: ~95 ms measured through the app earlier, 62-64 ms raw `pg`; Prisma itself adds 0.1 ms or less); phase 2 is a hand-written Prisma `Job` table claimed with `SKIP LOCKED`. Never add a second scheduler beside the ticker, and no QStash unless a job needs per-message delivery.
- **Issue triage (owner decision, 2026-10-31, `docs/decisions/2026-10-31-gpt-issue-triage.md`):** the org invoice rail is not live at launch and the dunning fix (stage the overdue notice inside the winning OVERDUE transaction) gates enabling it; no QStash or second-scheduler pilot before launch; fix order PR A (dunning, #2489) then PR B (#2490: a full durable `AdminRunRequest`-style table, REQUESTED to CLAIMED to DONE or FAILED, claimed by the ticker with CAS-in-WHERE, status CHECK and any one-open-request-per-job index in a `prisma/sql/` sidecar, schema change via the human-run `db:push` preflight), then after launch #2492 (job backlog starvation: recording-transfer throughput, retention-safe checkpoints, per-job throughput and poison-row audit).
- **Admin run requests (owner decision, 2026-11-01, `docs/decisions/2026-11-01-admin-run-requests.md`):** a `manualRun: "after"` run commits an `AdminRunRequest` row (`REQUESTED`, with the click's `idempotencyKey`, unique per job; a retry with the same key returns its request in any status and never re-dispatches) and its `OpsActionLog` row in one transaction before the 202, then `scheduleAfter` claims and runs it (`lib/cron/admin-run-requests.ts`). Every transition is CAS on `status` plus `attempts`, so a stale claimant cannot settle; the run executes in-process as `admin:<requestedBy>` with the admitted `windowStart`, and settles from `X-Run-Outcome` with `runId` found by `result.opsActionLogId`; a settling write also moves the same-id audit row to the run's status in that transaction. `drain-admin-run-requests` (hourly at :40, idle-probed; no shorter cadence fits the cap) reclaims rows `REQUESTED` over 2 minutes or `CLAIMED` over 15, settles a stale claim from its finished run without re-running it, and fails a request after 3 attempts. One open request per job and the state CHECK live in `prisma/sql/check-constraints.sql`; settled rows are pruned after 30 days by `prune-system-job-executions`. Never return a 202 for a deferred admin run before the row commits.
- **Retention windows (owner decision, 2026-11-01, `docs/decisions/2026-11-01-data-retention-windows.md`):** every log-like and audit table has a window and a prune folded into `prune-audit-logs` (audit class) or `prune-system-job-executions` (telemetry and secondary tables); there is no new ticker target because the busiest tick holds 11 of `MAX_TARGETS_PER_TICK` = 12. `prune-system-events` keeps the newest state-bearing event per key. `auth-tokens` deletes each expired `Session` at expiry and stamps the removed rows into `SessionAccessLog` in the same transaction, and prunes access-log rows 180 days after the session ended (amended 2026-11-02, section 7). `ActivityLog` is gone.
- **Launch job runtime (owner decision, 2026-10-31, `docs/decisions/2026-10-31-job-runtime-experiments.md`):** launch on the Netlify ticker plus Background Functions for jobs over 30 s. This governs the job runtime only, not the web tier: the web-tier scale path below (a Vercel Pro `bom1` trial before about 300 concurrent users) is separate and rejects only the always-on Mumbai container plan for web plus worker, not a Mumbai VM for jobs. After launch, choose the job runtime between Vercel Pro `bom1` plus Workflows and a Mumbai VM with DBOS once the real-app `bom1` test and the Mumbai VM test report cost and latency; revisit then, or at about 300 concurrent users. Moving the real app to Vercel needs code and build changes.
- **Measured job-runtime facts (2026-10-31)** are evidence, not decisions: no runtime other than code in Mumbai removes the per-statement cost, side effects stay at-least-once, and DBOS, pg-boss, QStash and Inngest each have a footgun. Read `references/job-runtime-options.md` before proposing a hosted job service or a queue library.
