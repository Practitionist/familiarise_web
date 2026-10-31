# Vercel bom1: Fluid compute, Prisma overhead, QStash/Upstash Workflow, Vercel Workflows (2026-10-31)

Labels: MEASURED = observed in this lab. DOCS = from the cited official page.

Setup: Vercel CLI 65.9.0, Hobby scope `kaustav-ghoshs-projects`, region `bom1`, Node 26.x. Prisma 7.10.0 with `@prisma/adapter-pg`; `@upstash/qstash` 2.12.1; `@upstash/workflow` 1.5.0; Vercel `workflow` 5.2.3 on Next.js 16. QStash EU user (shared with a concurrent Netlify experiment, so account-level counters mix both). Raw evidence and code lived in the job's scratch folder `lab-vercel2/` (`fluid-on`, `fluid-off`, `qs`, `wf-d`, `tools`, `results/`).

## A. Fluid compute on vs off

Toggle: MEASURED: `vercel.json` `"fluid": false` did not change the project setting; both projects came up with `resourceConfig.fluid: true`. The off project was switched with `PATCH /v9/projects/fw-lab-fluid-off {"resourceConfig":{"fluid":false}}`, re-read (on = true, off = false) and redeployed. Behavioural proof: the off project never put two requests on one instance (`maxInflightOnInstance` = 1 across 140 requests); the on project reached 5 to 6 in flight per instance.

Workload per request: module-level `pg.Pool({max: 5})`, 10 sequential small queries plus `pg_sleep(0.3)`.

| Project | Case          | p50 ms | p95 ms | max ms | Instances | Cold | Errors | Client pool conns |
| ------- | ------------- | ------ | ------ | ------ | --------- | ---- | ------ | ----------------- |
| ON      | burst 20 r1   | 1193   | 1539   | 1554   | 17        | 17   | 0      | 20                |
| ON      | burst 20 r2   | 538    | 830    | 860    | 7         | 0    | 0      | 20                |
| ON      | burst 50 r1   | 850    | 1191   | 1427   | 43        | 26   | 0      | 50                |
| ON      | burst 50 r2   | 889    | 1220   | 1490   | 13        | 0    | 0      | 46                |
| ON      | sequential 20 | 388    | 415    | 520    | 1         | 0    | 0      | 1                 |
| OFF     | burst 20 r1   | 1214   | 1487   | 1976   | 20        | 20   | 0      | 20                |
| OFF     | burst 20 r2   | 516    | 810    | 814    | 20        | 0    | 0      | 20                |
| OFF     | burst 50 r1   | 944    | 1270   | 1419   | 50        | 30   | 0      | 50                |
| OFF     | burst 50 r2   | 938    | 1289   | 1475   | 50        | 0    | 0      | 50                |
| OFF     | sequential 20 | 372    | 399    | 502    | 1         | 0    | 0      | 1                 |

Findings (MEASURED):

- Fluid OFF is strictly one request per instance: a 50-request burst used 50 instances and 50 client DB connections.
- Fluid ON packed warm repeat bursts onto 7 instances (20 requests) and 13 instances (50 requests). A first burst on a cold project barely benefits (17 of 20 and 43 of 50 instances were new).
- Warm latency is about the same on and off; the floor is the 300 ms `pg_sleep` plus about 12 statements.
- The Supabase pooler (Supavisor) overwrites `application_name` to `Supavisor`, so per-project connection counting by name returned 0. Total pooled backends stayed flat at 15 to 16 through every burst: the pooler absorbed 50 client connections. Sampling was every ~250 ms.
- Vercel function duration/CPU usage was not captured.

## B. Prisma overhead (Prisma 7.10 + adapter-pg vs raw `pg`, same project, alternating 6 times)

- Per-statement latency through the pooler is bimodal (about 0.7–1.0 ms or about 2.3 ms) and the mode changes between invocations, so only same-mode runs compare.
- Same-mode runs: `SELECT 1` median 2.26 / 2.33 ms (Prisma) vs 2.35 / 2.32 ms (raw); 10-round-trip lock hold median 22.2 / 22.3 ms vs 22.1 / 21.7 ms. Prisma's per-statement overhead is below noise, about 0.1 ms or less. MEASURED.
- One-time Prisma costs: client construction 1.9 ms; first query on a cold instance 180–221 ms; the very first call after deploy took 4.7 s for the 20-query mix and did not recur (cause not isolated). MEASURED.

## C. QStash and Upstash Workflow (EU) to Vercel bom1

- C1 delivery, 20 messages: laptop send to handler median 537 ms, p95 1137 ms (min 307, max 1158). The publish call alone has a median of 191 ms, so publish-ack to handler is about 350 ms including the QStash EU to `bom1` hop. All 20 delivered first time. MEASURED.
- C2 beyond the duration cap (`Upstash-Retries: 2`):
  - `long?s=30`: HTTP 200, no retries, one start and one end row. MEASURED.
  - `long?s=310`: each attempt got 504 `FUNCTION_INVOCATION_TIMEOUT` at ~300.2 s; retries 11 s after the first 504 and ~141 s after the second; after 3 attempts the message went to the DLQ. Side-effect rows: 3 starts, 0 ends. MEASURED.
  - DOCS: QStash max HTTP response duration is 2 h on Pay-as-you-go (https://upstash.com/pricing/qstash), so Vercel's 300 s cap is what bites.
  - Zombie execution, MEASURED: a function that returned 504 at 300 s still wrote its end row at 400 s (the `s=400` call). Handlers must be idempotent.
- C3: a 30 s delayed message arrived ~0.55 s late (after the 191 ms publish call). A per-minute schedule fired exactly once per minute (11:36:00, 11:37:01, 11:38:00, 11:39:00 UTC), no duplicates; deleted (DELETE 200, GET 404, list `[]`). MEASURED.
- C4 Upstash Workflow, function HTTP requests per run (MEASURED):
  - 3 steps: 4 requests (N+1), step gaps ~0.5–0.7 s, whole run 1.9 s.
  - 30 s step: 2 requests; the step ran 30.02 s inside one invocation.
  - `context.sleep("10s")`: 4 requests; the function was not running during the sleep.
  - `context.call` to `long?s=290`: 5 requests; returned 200; run completed in ~294 s. Upstash held the wait, not the function.
  - `context.call` to `long?s=400`: 5 requests; the callee's gateway returned 504 at 300 s; the step still ended `STEP_SUCCESS` with `status: 504` and the run reached `RUN_SUCCESS`. `context.call` does not fail a run on 4xx/5xx: code must check `res.status`.
  - Not proven: a successful call above 300 s (Hobby cannot host a 400 s endpoint).
  - DOCS: `context.call` supports responses up to 12 h executed by Upstash, and each call is two messages (bundled `@upstash/workflow` docs `steps/call.mdx`, `pricing.mdx`).
  - The Workflow logs API exposes `workflowState` and per-step `stepType` / `state` / `callResponseStatus`.
- C5 dual write: insert `dw-fail` (committed), throw before publish → row exists, no message. Control `dw-ok`: row plus one delivered message. MEASURED.

## D. Vercel Workflows (Workflow DevKit)

DOCS:

- Available on Hobby with 50,000 events/month and 1 GB written included; Data Retained not available on Hobby. On-demand: $0.02 per 1K events, $0.50 per GB written, $0.50 per GB-month retained. One step is 3 events. https://vercel.com/docs/workflows/pricing
- Limits: 25,000 events and 10,000 steps per run, 50 MB payload, 240 s max replay, unlimited run and sleep duration, Hobby rate limit 50,000 requests/min, Hobby payload retention 1 day. Pricing page and https://vercel.com/docs/workflows/retention
- Steps execute in your own project's Vercel Functions, dispatched by Vercel Queues. https://vercel.com/docs/workflows
- Each run is pinned to one region, by default the region of the function that called `start()`; payloads and run records stay there; hook records default to `iad1`; Queues messages expire within 7 days. Retention page and the multi-region section of /docs/workflows.
- Per-step cap follows Vercel Functions limits (300 s on Hobby).

MEASURED:

- Steps reported `bom1`.
- `start()` call: 599 ms cold, 57–63 ms warm (one 227 ms outlier). Start to first step: 1.08 s cold, 0.31–0.36 s warm.
- Per-step DB latency 2.3–3.2 ms per query; first query on a cold instance 32–92 ms. Step-to-step gap 71–326 ms.
- A 3-step run used exactly 1 function invocation (steps ran inline in one `/.well-known/workflow/v1/flow` POST). A 30 s step completed in the same invocation.
- Durable `sleep("10s")` woke after 10.69 s and cost 1 extra invocation (2 total).
- Crash on first attempt: retry ~1.44 s later, 1 extra invocation; completed steps did not re-run (steps 1 and 3 side-effect rows once each; the flaky step has 2 attempt rows).
- Dual write: `start()` is not transactional with the Postgres write. Commit then fail before `start()` → row, no run. `start()` then `ROLLBACK` → the run executed all 3 steps for an order that does not exist. Outbox discipline is required; the docs promise no atomicity with a user database.
- Run viewer: https://vercel.com/kaustav-ghoshs-projects/fw-lab-vwf/observability/workflows (the `npx workflow inspect runs` CLI printed only version/debug output).

## UI URLs (kept 48 h from 2026-10-31)

- https://vercel.com/kaustav-ghoshs-projects/fw-lab-fluid-on
- https://vercel.com/kaustav-ghoshs-projects/fw-lab-fluid-off
- https://vercel.com/kaustav-ghoshs-projects/fw-lab-qs
- https://vercel.com/kaustav-ghoshs-projects/fw-lab-vwf
- Each has `/deployments`, `/logs` and `/observability`.
- Upstash (EU region): https://console.upstash.com/qstash (Logs, Schedules, DLQ) and https://console.upstash.com/workflow (runs).
- The endpoints no longer work because their env vars were removed; dashboards, logs and past deployments remain.

## Cost

The QStash stats API showed 107 messages that day for the whole EU user (including the Netlify experiment). Billed total 0.001 USD; the $20 cap untouched. Vercel usage not pulled.

## Cleanup proof

- `drop schema lab_v2lock cascade`; `select nspname from pg_namespace where nspname like 'lab_v2%'` returned 0 rows.
- `qstash_list_schedules` (EU) returned `[]`.
- Removed `DATABASE_URL`, `QSTASH_TOKEN`, both signing keys, `QSTASH_URL`, `LAB_APP` and `WF_BASE` from all 4 projects; `vercel env ls` shows none; each redeployed.
- Older deployments were built with the env vars and may hold them in their snapshots: delete the projects after 48 h.
- Local secrets files deleted; no lab processes left; no repo changes; no existing Vercel project touched.
- Left for browsing: 1 QStash DLQ message and 5 Workflow DLQ messages.
