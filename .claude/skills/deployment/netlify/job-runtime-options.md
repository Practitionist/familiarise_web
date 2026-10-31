# Hosting facts for background-job runtimes

Platform facts measured or read on 2026-10-31. The facts about the queue and scheduler libraries are in `.claude/skills/maintenance/references/job-runtime-options.md`. Depth, diagrams and sources: `docs/maintenance/14-background-job-runtime-options.md`.

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

## Cloudflare

- A Worker placed with `region = "aws:ap-south-1"` runs in `remote-BOM` and measured 2-3 ms per statement and a 65-75 ms lock hold (36-39 ms with Hyperdrive in-region). Default placement and Smart Placement stayed at about 98 ms from Marseille.
- Placement applies to `fetch` handlers only. Queue consumers, cron and Workflow steps ran in random colos at 125-266 ms; use a service binding to a pinned Worker (22-31 ms).
- `pg` over TLS from Workers hung, so the probe ran without TLS. A removed cron kept firing about 4 minutes. Free CPU is 10 ms per request.

## How to rerun

Use a throwaway site or project with the region pinned, a `lab_` schema, and env vars removed afterwards. Scripts: `docs/maintenance/experiments/2026-10-31-job-runtime/source-code.md` and `docs/maintenance/experiments/2026-10-31-job-runtime/vercel-bom1-latency.md`. Delete the site or project when done. The kept Netlify site `fw-probe-jobs-9651` is for browsing only until 2026-11-02.
