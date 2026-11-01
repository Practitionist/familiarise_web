# Job-runtime options: measured facts, footguns and reruns

Evidence from 2026-10-31 to 2026-11-01, not decisions. Depth, diagrams and sources: `docs/maintenance/14-background-job-runtime-options.md`. Raw logs: `docs/maintenance/experiments/2026-10-31-job-runtime/`. The decisions are in `docs/decisions/2026-10-31-ticker-scale-path-and-queue.md`: keep the ticker through launch, trial Vercel `bom1`, adopt no hosted third-party scheduler or engine for launch (Vercel Workflows, option 1, is a later candidate), and a hand-written Prisma `Job` table for phase 2. Do not add a second scheduler beside the ticker (`AGENTS.md` rule 4).

## Current decision

Current owner decision (2026-10-31, `docs/decisions/2026-10-31-job-runtime-experiments.md`): launch on option 4, the Netlify ticker plus Background Functions for jobs over 30 s. Decide between option 1 (Vercel Pro `bom1` plus Vercel Workflows) and option 3 (a Mumbai VM with DBOS) after the real-app Vercel `bom1` test and the Mumbai VM test report cost and latency. Revisit when those two tests report, or at about 300 concurrent users, whichever comes first. Do not start either migration before then.

Option 1 is not a config switch: the real `dev` app failed on Vercel (Node 26 middleware ESM load, Node 22 static-generation hang), see `docs/maintenance/experiments/2026-10-31-job-runtime/15-real-app-vercel-bom1-attempt.md`.

## Decision-relevant facts

- Only code that runs in Mumbai removes the per-statement cost. Netlify Singapore is 62-64 ms per statement with raw `pg` (about 95 ms measured through the app earlier; a bare Prisma client on raw queries adds 0.1 ms or less per statement in `bom1`, which does not cover the app client on Netlify, so the gap is unexplained), Trigger.dev Frankfurt 125 ms, `bom1` 1.0-2.1 ms.
- Hosted schedulers (Inngest, QStash, Upstash Workflow) call our route. The compute stays on Netlify and keeps its limits. Trigger.dev runs the code itself, but only in `eu-central-1`, `us-east-1` or `us-west-2`.
- pg-boss and DBOS keep the queue in Postgres and enqueue in the caller's transaction (rollback leaves 0 jobs). DBOS needs a long-lived worker. pg-boss can be drained from short functions (below).
- Vendor side effects are at-least-once on every runtime. Idempotency keys, CAS-in-WHERE and the reconcilers stay.
- Running on a remote host does not make the transaction distributed. It holds locks longer: a 10-round-trip hold is about 690 ms on Netlify, 1,258 ms from Frankfurt, 395 ms from the laptop, 10.6-19.6 ms on `bom1`.
- Static egress for RazorpayX is solved on Netlify by `RAZORPAYX_EGRESS_PROXY_URL` (`apiRequest` in `lib/payments/payouts/razorpay-payouts.ts`).

## Measured numbers

| Runtime                                          | Round trip                                     | 10-trip lock hold    | Notes                                |
| ------------------------------------------------ | ---------------------------------------------- | -------------------- | ------------------------------------ |
| Netlify Singapore, raw `pg`                      | 62-64 ms                                       | 676-707 ms           | connect 371-405 ms                   |
| Trigger.dev eu-central-1 / us-east-1 / us-west-2 | 125 / 185 / 232 ms                             | 1,258 ms (Frankfurt) | no region given lands in us-east-1   |
| Vercel `bom1`, raw `pg`                          | 1.0-2.1 ms                                     | 10.6-19.6 ms         | Hobby cap 300 s, `*/5` cron rejected |
| Laptop India                                     | 39.5 ms                                        | 395 ms               | best case only                       |
| QStash EU to Netlify                             | publish-to-receive median 1,366 ms (p95 2,115) | n/a                  | 30 s function: 504, 3 side effects   |

With Fluid compute ON, warm bursts of 20 and 50 requests used 7 and 13 instances where OFF used 20 and 50 (one request per instance), at the same latency. Vercel Workflows steps run in our `bom1` functions at 2.3-3.2 ms per query. QStash EU to `bom1`: publish-ack to handler about 350 ms.

A user update to a row locked from Frankfurt waited about 1.1 s against 37.6 ms with no job. SERIALIZABLE lost one of every concurrent pair (40001) in both places, so keep `withSerializableRetry` (`lib/db/serializable-retry.ts`).

## The eight layers and the stacks that fit together

Layers: 1 Trigger, 2 Dispatch, 3 Durability, 4 Compute, 5 DB access, 6 Correctness, 7 Egress, 8 Observe. Full matrix, HLD and decision flowchart: `docs/maintenance/15-job-runtime-layer-matrix.md`.

Compatibility rules:

1. A layer-3 engine is tied to its compute: managed Vercel Workflows to Vercel Functions, Cloudflare Workflows to Workers, Trigger.dev to its own machines. The Workflow SDK's self-hosted Postgres World (graphile-worker on a long-running server, a reference implementation) is DOCS only, untested here, and does not carry managed run history, timers or queue state across. Inngest and Upstash Workflow work with any HTTP compute.
2. In-process engines and schedules (Inngest `connect`, DBOS, pg-boss cron) need long-lived compute; hosted durable steps (Vercel and Cloudflare Workflows) do not. Without it you only get drain mode.
3. Any queue can be drained by a periodic trigger, at the cost of tick latency.
4. Only a Postgres-native queue (pg-boss, DBOS) avoids the enqueue dual write. Everything else needs an outbox row in the same transaction.
5. Layer 6 never changes: CAS-in-WHERE, idempotency keys, ledger triggers and reconcilers stay on every stack.

Stacks (S1 ticker today, S2 Prisma `Job` table, S3 Netlify Background Functions, S4 Async Workloads (measured), S5 QStash or Inngest on Netlify, S6 Vercel Cron in `bom1`, S7 Vercel Workflows in `bom1`, S8 Cloudflare, S9 Trigger.dev, S10 DBOS on a Mumbai VM, S11 Restate Cloud EU calling `bom1`):

| Stack | DB per round trip                                            | Time cap                                 | Double-write safe                                         | Status                              |
| ----- | ------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------- | ----------------------------------- |
| S1    | 62-64 ms                                                     | ~26 s edge                               | yes                                                       | current                             |
| S2    | as S1                                                        | as S1                                    | yes                                                       | decided, not built                  |
| S5    | 62-64 ms                                                     | ~30 s                                    | no, outbox                                                | measured                            |
| S6    | 1.0-2.3 ms                                                   | 300 s Hobby, 800 s Pro                   | yes                                                       | decided trial                       |
| S7    | 2.3-3.2 ms                                                   | step 300 s Hobby                         | no, `start()` not transactional                           | measured                            |
| S9    | 125 ms                                                       | none stated                              | no, outbox                                                | measured                            |
| S10   | 1-2 ms ESTIMATE                                              | none                                     | yes                                                       | unmeasured on a VM                  |
| S3    | 63.9 ms                                                      | 900 s (840 s completed, 960 s killed)    | no, outbox; caller gets only a 202                        | measured                            |
| S4    | 63 ms                                                        | 30 s per step standard, 840 s background | no (`send` then rollback still delivered)                 | measured; warm fire-and-forget only |
| S8    | 2-3 ms via a pinned Worker; 125-266 ms direct from consumers | consumer 15 min wall                     | no (Queue send and Workflow `create()` not transactional) | measured                            |

Corrections: pg-boss can be drained from short functions (drain mode, MEASURED); DBOS drain mode was not run. Only their own cron, maintenance and fast crash recovery need a long-running process. "Mumbai worker at 1-2 ms" is an estimate; only Vercel `bom1` and a region-pinned Cloudflare Worker were measured. A Background Function avoids the ~30 s cap but the caller gets only a 202.

## How the jobs avoid corrupting each other

A conflict costs wasted work and waiting, not corruption. Engine concurrency controls (Inngest keys, QStash flow control, DBOS limits) are a convenience; the Postgres layers are the guarantee. Full picture: `docs/maintenance/14-background-job-runtime-options.md` section 9.6.

```text
 job A            job B            user request
   | 1 lease: admission control, one holder per job (withCronLock, lib/cron/with-cron-lock.ts).
   |   Not a fence: after a takeover the old fn() keeps running; layers 2-4 make the overlap safe
   v                v                v
 UPDATE ... SET status='REFUNDED' WHERE id=7 AND status='PAID'   <- 2 CAS: one match, loser updates 0 rows
 3 row lock: the second writer WAITS (~700 ms Singapore, ~20 ms Mumbai estimate)
 4 CHECK / triggers / unique indexes (prisma/sql/*.sql): an invalid state cannot COMMIT
   (deadlock: Postgres aborts one side, the job retries next tick)
```

## Queue throughput rule of thumb

Load cannot corrupt a Postgres queue: claims use `FOR UPDATE SKIP LOCKED` inside transactions, so overload means slowness and backlog, not double-claims (0 duplicates across 600 jobs and 3 drainers). Throughput is database capacity (writes, WAL, vacuum and bloat, connections, compute size). Measured: one `bom1` drainer processed 2,000 jobs in 3.8 s (about 500 per second); our need is about 0.035 per second. Kafka or SQS only pay off at sustained thousands per second. Prune and archive job tables; the retention audit for log-like tables is issue #2496.

## Rankings (judgement from the evidence, not a decision)

With latency (distance from the Mumbai database counts): 1 Vercel Workflows `bom1`, 2 Vercel Cron plus Functions `bom1`, 3 DBOS on a Mumbai VM (estimate), 4 pg-boss drain from `bom1`, 5 Cloudflare pinned plus Hyperdrive, 6 Restate Cloud EU calling `bom1`, 7 Netlify ticker plus Background Functions, 8 QStash or Upstash Workflow on Netlify, 9 Inngest on Netlify, 10 Async Workloads, 11 Trigger.dev.

Without latency (correctness, limits, ops, cost, migration effort): 1 DBOS, 2 Vercel Workflows, 3 Restate, 4 Netlify ticker plus Background Functions, 5 pg-boss drain, 6 Upstash Workflow, 7 Trigger.dev, 8 Inngest, 9 Cloudflare Workflows and Queues (also last on overall fit: OpenNext is the largest migration of any option and every job step pays a hop), 10 QStash alone, 11 Async Workloads.

Without latency, today's ticker and DBOS rank near the top because their outbox and idempotency machinery already exists or comes with the engine. Two persistence gaps hold on every option: dunning commits OVERDUE before staging the notice (#2489) and the admin manual run returns 202 before persisting the request (#2490). With latency, every option that keeps code outside Mumbai drops below the Mumbai options. Restate Cloud (EU) calling `bom1` ranks 6th with latency (the EU hop is 92-178 ms per invocation and step) and 3rd without latency, just below Vercel Workflows (completed, durably journaled step results replay rather than re-run, but failed `ctx.run` steps retry and an effect can land before its checkpoint, so keep provider idempotency; idempotency keys, accurate sleep, self-hostable). Detail: `docs/maintenance/14-background-job-runtime-options.md` section 12.2.

## What a host move removes

Machinery (`wc -l`): `lib/cron/cleanup-registry.ts` 2,410 (keep), `netlify/functions/cron-tick.mts` 881 and `lib/cron/schedule.ts` 655 (exist for the single 30 s ticker; mostly removed on a move), 12 lease and run-record files 1,656 (keep), deadline and background adapters 324 (Netlify time limits). A Vercel move removes about 1,500-2,000 lines (ESTIMATE); leases, CAS, run records, the registry and the outbox stay. Portable core: registry, handler invocation, leases, CAS, outbox, HTTP route per job. Thin per platform: trigger, `lib/runtime-host.ts`, `next.config.mjs` flags, cache headers. Vercel and Cloudflare Workflows are not portable; use DBOS, pg-boss or the planned Prisma `Job` table. Handle limits, regions and egress through config. Detail: `docs/maintenance/16-job-machinery-and-portability.md`.

## Clock versus engine, and the target design (proposal)

Rule: an external scheduler used as a clock (it only calls our endpoint) is viable; used as an engine (it runs the job) it keeps the latency and adds a second programming model. `AGENTS.md` rule 4 bans a second scheduler, not replacing the ticker. Correctness holds if the DB guards stay (leases, CAS, constraints, outbox) and exactly one scheduler runs; the planned `_due` route must always return 200 to a clock (QStash retries any non-2xx). The current `cron-tick.mts` is different: windowed money targets can return 207 and a positive `remaining` is normal. A `_due` route is planned (issue #2491), not present. Keep the Netlify ticker through launch.

Target design (a proposal, not a decision): Mumbai web tier plus one long-lived worker (2 replicas, DBOS or pg-boss), enqueue in the same transaction as the business write, correctness unchanged in Postgres, the worker's own static IP, heartbeat to Better Stack and errors to Sentry. Deleted: the fan-out ticker, packing in `schedule.ts`, `run-deadline` slicing, background adapters, the fleet switch, the `PG_POOL_MAX=1` workarounds and the proxy. Kept: the registry, leases, CAS, ledger triggers, idempotency keys, run records. Path: launch on the ticker, issue #2491 portable `runJob` and thin triggers, the Mumbai VM probe, move jobs first, then the web tier after a spike. Detail: `docs/maintenance/17-target-architecture-and-roadmap.md`.

Better Stack roles: uptime monitors, the ticker heartbeat (`pingHeartbeat()` in `cron-tick.mts`), telemetry log events from `recordSystemEvent` (gated by `ENABLE_BETTERSTACK_TELEMETRY`), maintenance incidents (`app/api/admin/maintenance/route.ts`), and the health and canary reads. Sentry answers what broke.

## Monitoring and tracing a failure to a user

Four layers (full page: `docs/maintenance/18-monitoring-and-tracing-failures.md`): (1) the ticker summary line and `pingHeartbeat()` to Better Stack in `netlify/functions/cron-tick.mts`; (2) a `SystemJobExecution` row per run (status, outcome, `itemsProcessed`, `errorCount`, `result`, `errorLog`, `durationMs`) written by `withCronLock`, read by `readJobRunMetrics`; (3) the Entity trace at `/dashboard/<tree>/trace` (`lib/backoffice/entity-trace.ts`); (4) escalation-only Sentry with a `job_run_id` tag. One user or a group: a 207 partial run lists sample ids (open each in the trace); a 500 or a failure streak (`lib/cron/failure-streak.ts`) means the whole job; an ageing owed marker is a single poison row. `statusFor` tests failure before 207. `startDeadline` (`lib/cron/run-deadline.ts`) stops a slice at about 16 s. Built: a read-only Stuck work page, oldest-pending-age gauges on the tick summary, and per-run `result.telemetry` and `result.failures` (ids only, at most 50) as the per-item history until traction; batched per-item Better Stack events are deferred (no Postgres per-item table; `docs/decisions/2026-11-01-observability-gaps-and-launch-posture.md`).

## Engine use cases, and why pg-boss and DBOS are libraries

Inngest: event-driven waits and fan-out. Trigger.dev: long heavy compute (regions too far for DB-heavy work). QStash: reliable HTTP delivery and a serverless clock. Upstash Workflow: cheap step workflows and long `context.call` waits. Cloudflare and Vercel Workflows: only if the app lives there. DBOS and pg-boss: jobs on your own Postgres with a long-running worker (the target design). They are libraries that own their tables and the hard code (SKIP LOCKED claiming, visibility timeouts, backoff, dead letters, deduplicated cron, delays, global concurrency in DBOS, archiving; DBOS adds a step journal), in the `pgboss` and `dbos` schemas, not Prisma. A hand-written Prisma `Job` table means writing all of that ourselves.

## Footguns

- DBOS needs a pool of about 10 or more. With `systemDatabasePoolSize: 2` its advisory-lock connection hits the 5 s idle-in-transaction timeout and the process crashes. It cannot run under `PG_POOL_MAX=1`. Pin `DBOS__APPVERSION`, or a non-latest worker stops dequeuing.
- pg-boss drain mode: start with `supervise:false`, `schedule:false`, `registerInstance:false`, then each tick runs `start()`, `boss.supervise()`, `fetch`/`complete` batches, `stop()`. 3 concurrent drainers processed 600 jobs with 0 duplicates; on `bom1` a job cost 0.8-1.9 ms. A plain `fetch()` never redelivers an abandoned job: only `supervise()` does (18.7 s with `monitorIntervalSeconds=5`; `expireInSeconds` defaults to 15 min, so set it just above the handler budget). Drain mode loses pg-boss's own cron, automatic expiry and archiving unless `supervise()` runs, and its monitoring. `send` with the `db` option is transactional.
- pg-boss can fire a duplicate cron job in the first minute after `schedule()` (2 of 2 Supabase runs). Recovery after `kill -9` takes about 65 s (60 s monitor floor); its concurrency limit is per process; LISTEN/NOTIFY needs both the instance flag and `notify: true` per queue.
- The Upstash Workflow handler re-runs from the top on every request (4 requests, 8 handler executions for a 3-step run), while each `context.run` body runs once. Keep everything with side effects inside `context.run`.
- QStash retries a 504 even though the function keeps running. One 30 s message wrote 3 side effects, retries at about 12 s, 160 s and 33 min. QStash treats any 2xx (202 and 207 included) as delivered, so verify the signature, then either finish the bounded work before answering or commit an idempotent durable work record or claim, with a defined consumer that recovers it, before returning 2xx. Never return 202 and rely on `after()`, and never forward a cleanup route's 207 as success. A native Background Function's 202 is different: it is platform admission, and its outcome is read from our run rows in Postgres.
- Inngest remote sync needs a manual PUT with `x-inngest-sync-kind: in_band` against a dev server. The dev server polls the site every 5 s, and each poll is a billed invocation. Checkpointing `maxRuntime` is checked between steps only; set it below the host limit minus the longest step.
- Inngest `connect` is unsupported on serverless runtimes (official docs).
- The Netlify real edge cut is about 30 s on a throwaway site but about 26 s measured on prod. Design for 26 s.
- Trigger.dev Free uses dynamic egress IPs. Static IPs are paid-only; the plan tier is UNVERIFIED.
- Vercel `"fluid": false` in `vercel.json` did not take effect; only `PATCH /v9/projects/<name>` with `resourceConfig.fluid` flipped it.
- Upstash Workflow `context.call` to an endpoint that returns 504 still ends the step `STEP_SUCCESS` and the run `RUN_SUCCESS`. Always check `res.status`.
- QStash to Vercel: a 310 s target gets a 504 at 300 s, retries after 11 s and about 141 s, then the DLQ. A function that already returned 504 still finishes its write (zombie), so handlers must be idempotent.
- Vercel Workflows `start()` is not part of our Postgres transaction: `start()` then `ROLLBACK` ran a workflow for a missing order. Use an outbox.
- Cloudflare placement applies to `fetch` handlers only. Queue consumers, cron handlers and Workflow steps run in random colocation sites (colos) at 125-266 ms per statement. Call a Worker pinned with `region = "aws:ap-south-1"` over a service binding with `fetch` (connect plus 5 queries: 22-31 ms in the first round, 22-109 ms with a median of about 29 ms in the Workflows round). An RPC call (`WorkerEntrypoint` method) through the same binding is NOT pinned: it runs beside the caller at 167-264 ms per query. Each Workflow step pays a flat hop of 144-289 ms (median about 180 ms) to reach the pinned Worker, so batch 2 or more statements, or a whole transaction, into one `fetch` call (180 + 5n ms versus 170n ms unpinned) (a 13-statement lock transaction took 67-70 ms). Report: `docs/maintenance/experiments/2026-10-31-job-runtime/16-cloudflare-workflows-pinned-hyperdrive.md`.
- Cloudflare needs the explicit region hint (2-3 ms). Smart Placement never moved (still about 98 ms after 600 requests) because it needs traffic from multiple locations. Hyperdrive without the hint is worse than direct.
- Cloudflare Workers cannot verify Supabase's private-CA certificate with `pg` or `postgres.js` (the old hang and error 1101). Only Hyperdrive with the Supabase CA uploaded and `verify-full` is certificate-verified: 4 ms per statement, 60-89 ms lock hold. The TLS-off 2-3 ms figures are not production-safe.
- Netlify Async Workloads (measured): a CLI deploy ships without the extension's router, scheduler and API functions; only a build on Netlify's servers from a linked repository adds them (a deploy key with `provider: manual` worked, every build via `createSiteBuild`). Event latency median 1.21 s warm. The 60 s scheduler makes delays 50-94 s late, retry gaps 31/58/121/120 s (not the documented 5 s), and each step a 25-60 s hop. Steps were repeated in a crash run (misuse of the 0.0.106 API not ruled out). A standard step of 30 s or more fails; use the background type. `send` is not transactional. Fine for warm fire-and-forget only. The extension is already installed team-wide.
- Cloudflare Workflows: completed steps do not re-run, a failed step retried after 2.23 s, but a write inside the failing step ran twice, so key step writes by instance id plus step. `create()` is not transactional with Postgres; keep the outbox. Free allows 3,000 steps a day; Paid is 500k a month then $0.80 per 100k (DOCS, ESTIMATE for our volume).
- A removed Cloudflare cron keeps firing for about 4 minutes (about 9 in the Workflows round); deleting the Worker is the sure stop. A Queue retry after a throw writes the side effect twice (3 runs then the DLQ at `max_retries = 2`). Free CPU is 10 ms per request; real jobs need Paid.
- Netlify Background Functions: in our probe a v2 default-export handler that threw was not retried (Netlify's docs do not exclude v2; the cause is an inference), while a legacy `exports.handler` throw, `process.exit(1)` or a 900 s kill is retried at about +1 min and +2 min (3 attempts, each repeats the side effect). Catch errors and record failure in our own run row, and stay idempotent. The v2 reason is an inference.
- Variables scoped only to `production` left a draft deploy with no database address. Give a lab site scratch values in the context it uses; never copy production secrets into every context.
- Background function logs arrive minutes late and show one `Duration` line per invocation; status lives only in our run rows. The caller gets only a 202.
- Restate Cloud (measured): only US and EU regions, so every invocation and step pays a 92-178 ms EU hop. The handler replays from the top on each `ctx.run`, so code outside steps re-runs. A step that exceeds the host cap (310 s on Vercel) is killed and retried about every 300 s without limit, so long steps must be idempotent. There is no native cron (self-rescheduling delayed sends drift about 1 s per tick). Triggering a call is not transactional with Postgres; use an outbox. Ingress needs a Full-role API key (Admin gets 403). Request-identity verification needs the environment public key, available only in the UI. The Vercel catch-all route needs a rewrite, and per-deployment URLs are behind Vercel SSO, so register the alias.
- A publish after commit is a dual write. Use state as the outbox or an in-database enqueue.

## How to rerun a probe

Scripts live outside the repo; all of them (Inngest, pg-boss, DBOS, Supabase, Trigger.dev, lock-hold, Netlify, QStash, Vercel, Cloudflare) are stored as redacted text in `docs/maintenance/experiments/2026-10-31-job-runtime/source-code.md`. The second Vercel round is in `docs/maintenance/experiments/2026-10-31-job-runtime/08-vercel-fluid-prisma-qstash-workflows.md` (code under `lab-vercel2/` in `source-code.md`). The first Vercel probe is described in `docs/maintenance/experiments/2026-10-31-job-runtime/07-vercel-bom1-latency.md`.

1. Make a scratch directory outside the repo and copy the script out of the markdown.
2. Pass the database address through an environment variable only. Default to a local disposable Postgres, or a separate disposable project with scoped credentials. The probes run DDL (`CREATE TABLE`, pg-boss and DBOS schema bootstrap, `DROP SCHEMA ... CASCADE`), and `AGENTS.md` §2.3 forbids autonomous DDL on the shared dev and production database; a `lab_` schema there still shares its connections, CPU, locks and credentials. The 2026-10-31 `lab_` runs on the shared project were owner-authorised; a future shared-project run is a separately reviewed exception the owner must authorise.
3. For Vercel, pin `regions: ["bom1"]`; for Netlify, set the site `functions_region` to `ap-southeast-1` and confirm it inside the function. Check `VERCEL_REGION` or `AWS_REGION`.
4. Run, then drop the database or schema, delete env vars and delete the throwaway site or project. Record versions and the cleanup proof in the report.
5. Never print or commit a connection string, token or the laptop address.
