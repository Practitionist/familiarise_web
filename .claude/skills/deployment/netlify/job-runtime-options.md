# Hosting facts for background-job runtimes

Platform facts measured or read on 2026-10-31 to 2026-11-01. The facts about the queue and scheduler libraries are in `.claude/skills/maintenance/references/job-runtime-options.md`. Depth, diagrams and sources: `docs/maintenance/14-background-job-runtime-options.md`.

## Current decision

Current owner decision (2026-10-31, `docs/decisions/2026-10-31-job-runtime-experiments.md`): launch on option 4, the Netlify ticker plus Background Functions for jobs over 30 s. Decide between option 1 (Vercel Pro `bom1` plus Vercel Workflows) and option 3 (a Mumbai VM with DBOS) after the real-app Vercel `bom1` test and the Mumbai VM test report cost and latency. Revisit when those two tests report, or at about 300 concurrent users, whichever comes first. Do not start either migration before then.

## Review of 2026-11-13 (research, not a decision)

A first-principles review agrees with launching on the ticker and concludes that no job engine is needed: the jobs are short, repeatable sweeps, and correctness comes from row state, the lease, compare-and-swap writes and constraints. The job runtime follows the web tier, so the open question is the app and database layout (#2751), not the engine (#2491). Full text: `docs/infrastructure/08-jobs-runtime-and-cold-start-review.md`.

Reopen the engine question only on one of these, observed and not predicted: a flow with three or more external, non-repeatable steps that an idempotency key cannot make safe; waits of hours or days per item in volume; or a backlog whose oldest item keeps ageing between ticks. A job that needs more than 25 s is not enough, because a Background Function runs for up to 15 minutes. If a backlog needs a queue, first add a next-attempt column to the existing sweep. `pg_cron` with `pg_net` is the reserve clock, not a current proposal.

## Real app on Vercel

The real `dev` app did not run on Vercel Hobby without changes: default build OOM; `CI_LEAN_BUILD=true` plus a 6144 MB heap built in 14 min, but every route returned 500 `MIDDLEWARE_INVOCATION_FAILED` (`middleware.js` cannot load as an ES module on Node 26); Node 22 builds hung at static generation (cause unverified). Option 1 therefore needs code and build changes, not a config switch. Report: `docs/maintenance/experiments/2026-10-31-job-runtime/15-real-app-vercel-bom1-attempt.md`.

## Clock versus engine, and the target design (proposal)

An external scheduler used only as a clock that calls our endpoint is viable; as an engine it keeps the host latency. Keep the Netlify ticker through launch; a `_due` route and thin triggers are planned (issue #2491). The greenfield target (Mumbai web tier plus a long-lived DBOS or pg-boss worker, enqueue in the same transaction, the worker's own static IP) is a proposal, not a decision: `docs/maintenance/17-target-architecture-and-roadmap.md`. Netlify credit-plan and seat details land with the skip-idle PR in `docs/deployment/netlify.md`; status: credit plan PENDING Netlify's confirmation, Developer seat pending the owner.

## Netlify (Singapore, `ap-southeast-1`)

- Raw `pg` to the Mumbai pooler: 62-64 ms per statement, connect 371-405 ms, a 10-round-trip lock hold of 676-707 ms. The earlier 95 ms was measured through the app. A bare Prisma client running raw queries added 0.1 ms or less per statement in `bom1`; that did not exercise the app's client or the Netlify cold path, so the gap is unexplained.
- Edge cut: 504 `Inactivity Timeout` after about 30.1 s on a throwaway site (real QStash, 3 attempts), against about 26 s measured on prod. The function keeps running and finishes its side effect after the 504. Design for 26 s. Docs: synchronous 60 s, scheduled 30 s, background 15 min.
- A hosted scheduler that calls a route here (Inngest, QStash, Upstash Workflow) cannot extend it. `context.call` offloads the caller's wait but not the callee's limit.
- No static egress outside an Enterprise add-on in `cmh`, `fra`, `lhr` (docs). RazorpayX uses the F1 proxy.

## Vercel

- `bom1` function to the Mumbai pooler: connect 12-18 ms warm (36 ms cold), `SELECT 1` 1.0-2.1 ms, 20-query mix 305-507 ms, 10-round-trip lock hold 10.6-19.6 ms.
- Hobby: function cap 300 s (310 s returned `FUNCTION_INVOCATION_TIMEOUT`; `maxDuration: 800` was rejected at deploy), cron daily only (a `*/5` cron was rejected at deploy). Pro: 800 s, 1,800 s beta, per-minute cron (docs).
- Fluid compute is default for new projects since 2025-04-23 (docs). Measured: with Fluid OFF each instance serves one request (50 requests, 50 instances); ON packed warm bursts onto 7 (of 20) and 13 (of 50) instances at the same latency. `"fluid": false` in `vercel.json` did not take effect; use the project API.
- Prisma 7.10 with `@prisma/adapter-pg` adds 0.1 ms or less per statement in `bom1`. Pooler latency is bimodal, about 1 ms or 2.3 ms.
- Vercel Workflows: steps run in our functions at 2.3-3.2 ms per query; Hobby includes 50k events a month (one step is 3 events, $0.02 per 1k beyond); `start()` is not transactional with Postgres.
- QStash to `bom1`: a 310 s target gets a 504 at 300 s, then the DLQ after 3 attempts.
- Static IPs: Pro and Enterprise, $100 a month per project plus Private Data Transfer, one IP pair per region (docs). Whether `bom1` can be chosen is UNVERIFIED.

## Netlify Background Functions

- Caller gets a 202 in 0.65-0.85 s. Runs of 60, 300 and 840 s completed; 960 s was killed at exactly 900 s. Database: 63.9 ms per statement, 704 ms lock hold.
- In our probe, a v2 default-export handler that threw was not retried (Netlify's docs say a failed invocation is retried after 1 and 2 minutes and do not exclude v2, so treat this as measured on one site, with the cause an inference); legacy `exports.handler` throws, `process.exit(1)` and timeouts are retried at +1 and +2 minutes (3 attempts, each repeats the side effect). The v2 reason is our inference.
- Ten concurrent runs ran in parallel. A draft deploy worked; a PR Deploy Preview was not tested. A variable scoped only to `production` is absent from a draft deploy; give a lab site scratch values in the context it uses, never production secrets in every context. Logs lag by minutes.
- Async Workloads (measured; team-wide extension, already installed so it also applies to `familiarise`): a CLI deploy lacks its functions, so it needs a build on Netlify's servers from a linked repository. Event latency median 1.21 s warm; retries at +34 s and 5 attempts then a Blobs dead letter; the 60 s scheduler makes delays 50-94 s late; a standard step of 30 s or more fails (background type ran 840 s); steps repeated in a crash run; `send` is not transactional. Fine for warm fire-and-forget work only.

## Cloudflare

- A Worker placed with `region = "aws:ap-south-1"` runs in `remote-BOM` and measured 2-3 ms per statement and a 65-75 ms lock hold (36-39 ms with Hyperdrive in-region). Default placement and Smart Placement stayed at about 98 ms from Marseille.
- Placement applies to `fetch` handlers only. Queue consumers, cron and Workflow steps ran in random colocation sites (colos) at 125-266 ms; use a service binding to a pinned Worker over `fetch` (connect plus 5 queries: 22-31 ms in the first round, 22-109 ms with a median of about 29 ms in the Workflows round). RPC through a service binding is NOT pinned (167-264 ms per query), and each Workflow step pays a hop of about 180 ms. Running the whole app on Cloudflare (OpenNext) is the largest migration of any option; the ranking is Vercel `bom1` or a Mumbai DBOS worker, then Netlify, then Cloudflare. Report: `docs/maintenance/experiments/2026-10-31-job-runtime/16-cloudflare-workflows-pinned-hyperdrive.md`.
- Workers cannot verify Supabase's private-CA certificate with `pg` or `postgres.js`; only Hyperdrive with the Supabase CA and `verify-full` is certificate-verified (4 ms per statement, 60-89 ms lock hold). The 2-3 ms and 65-75 ms figures ran with TLS off. A removed cron kept firing about 4 minutes. Free CPU is 10 ms per request.
- A removed Cloudflare cron kept firing for about 4 minutes in one round and about 9 in another; delete the Worker to stop it for sure.
- Cloudflare Workflows step writes are at-least-once (a write in the failing step ran twice), and `create()` is not transactional with Postgres, so keep the outbox.

## How to rerun

Use a throwaway site or project with the region pinned, a `lab_` schema, and env vars removed afterwards. Scripts: `docs/maintenance/experiments/2026-10-31-job-runtime/source-code.md` and `docs/maintenance/experiments/2026-10-31-job-runtime/07-vercel-bom1-latency.md`. Delete the site or project when done. The kept Netlify site `fw-probe-jobs-9651` is for browsing only until 2026-11-02.
