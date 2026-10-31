# Hosting facts for background-job runtimes

Platform facts measured or read on 2026-10-31. The facts about the queue and scheduler libraries are in `.claude/skills/maintenance/references/job-runtime-options.md`. Depth, diagrams and sources: `docs/maintenance/14-background-job-runtime-options.md`.

## Current decision

Current owner decision (2026-10-31, `docs/decisions/2026-10-31-job-runtime-experiments.md`): launch on option 4, the Netlify ticker plus Background Functions for jobs over 30 s. Decide between option 1 (Vercel Pro `bom1` plus Vercel Workflows) and option 3 (a Mumbai VM with DBOS) after the real-app Vercel `bom1` test and the Mumbai VM test report cost and latency. Revisit when those two tests report, or at about 300 concurrent users, whichever comes first. Do not start either migration before then.

## Real app on Vercel

The real `dev` app did not run on Vercel Hobby without changes: default build OOM; `CI_LEAN_BUILD=true` plus a 6144 MB heap built in 14 min, but every route returned 500 `MIDDLEWARE_INVOCATION_FAILED` (`middleware.js` cannot load as an ES module on Node 26); Node 22 builds hung at static generation (cause unverified). Option 1 therefore needs code and build changes, not a config switch. Report: `docs/maintenance/experiments/2026-10-31-job-runtime/15-real-app-vercel-bom1-attempt.md`.

## Netlify (Singapore, `ap-southeast-1`)

- Raw `pg` to the Mumbai pooler: 62-64 ms per statement, connect 371-405 ms, a 10-round-trip lock hold of 676-707 ms. The earlier 95 ms was measured through the app. Prisma's overhead is below noise (0.1 ms or less per statement in `bom1`), so the gap is unexplained; never attribute it to Prisma.
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
- A v2 default-export handler that throws is never retried; legacy `exports.handler` throws, `process.exit(1)` and timeouts are retried at +1 and +2 minutes (3 attempts, each repeats the side effect). The v2 reason is our inference.
- Ten concurrent runs ran in parallel. A draft deploy worked; a PR Deploy Preview was not tested. Set env vars for all deploy contexts. Logs lag by minutes.
- Async Workloads (measured; team-wide extension, already installed so it also applies to `familiarise`): a CLI deploy lacks its functions, so it needs a build on Netlify's servers from a linked repository. Event latency median 1.21 s warm; retries at +34 s and 5 attempts then a Blobs dead letter; the 60 s scheduler makes delays 50-94 s late; a standard step of 30 s or more fails (background type ran 840 s); steps repeated in a crash run; `send` is not transactional. Fine for warm fire-and-forget work only.

## Cloudflare

- A Worker placed with `region = "aws:ap-south-1"` runs in `remote-BOM` and measured 2-3 ms per statement and a 65-75 ms lock hold (36-39 ms with Hyperdrive in-region). Default placement and Smart Placement stayed at about 98 ms from Marseille.
- Placement applies to `fetch` handlers only. Queue consumers, cron and Workflow steps ran in random colos at 125-266 ms; use a service binding to a pinned Worker (22-31 ms).
- Workers cannot verify Supabase's private-CA certificate with `pg` or `postgres.js`; only Hyperdrive with the Supabase CA and `verify-full` is certificate-verified (4 ms per statement, 60-89 ms lock hold). The 2-3 ms and 65-75 ms figures ran with TLS off. A removed cron kept firing about 4 minutes. Free CPU is 10 ms per request.

## How to rerun

Use a throwaway site or project with the region pinned, a `lab_` schema, and env vars removed afterwards. Scripts: `docs/maintenance/experiments/2026-10-31-job-runtime/source-code.md` and `docs/maintenance/experiments/2026-10-31-job-runtime/07-vercel-bom1-latency.md`. Delete the site or project when done. The kept Netlify site `fw-probe-jobs-9651` is for browsing only until 2026-11-02.
