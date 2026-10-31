# Netlify and Vercel product map

This page lists the products each host offers, layer by layer, and maps the two catalogues onto each other. It exists because the background-job research of 2026-10-31 kept mixing up product names (a "cron ticker" is a pattern this repo built, not a product), and a side-by-side map makes the options easier to reason about.

> **Verification status.** The product lists come from general knowledge and were not re-checked against each vendor's pages on 2026-10-31. Rows marked **MEASURED** were observed in the 2026-10-31 experiments; everything else should be checked on the vendor's current docs and pricing before a decision relies on it. Measured evidence lives in [the experiments folder](../maintenance/experiments/2026-10-31-job-runtime/README.md), and the job-runtime comparison is in [page 14](../maintenance/14-background-job-runtime-options.md) and [page 15](../maintenance/15-job-runtime-layer-matrix.md).

## What "the cron ticker" is

Netlify has no product called a ticker. Netlify provides Scheduled Functions, which run on a cron schedule with a 30-second limit. This repo uses one of them, `netlify/functions/cron-tick.mts`, which fires every five minutes, decides which jobs in `lib/cron/schedule.ts` are due, and POSTs to their `/api/cleanup/<job>` routes in parallel (six Stream and recording targets go to Background Functions instead). Vercel's equivalent building block is Cron Jobs, and the same ticker could be built on it.

## Netlify

The table lists Netlify's products by layer and notes how this repository uses each one.

| Layer              | Product                                                                                              | Notes                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build              | Build system (CI that runs `next build`) and Deploy Previews for every PR                            | Previews are used for QA.                                                                                                                                                       |
| Frameworks         | Next.js Runtime / adapter (`@netlify/plugin-nextjs`)                                                 | Translates Next.js into Netlify primitives. The repo's cold-start fix (#1972) lives here.                                                                                       |
| CDN / edge         | Global CDN, cache headers, `Netlify-Vary`, on-demand revalidation                                    | Serves static assets and ISR pages.                                                                                                                                             |
| Edge compute       | Edge Functions (Deno, at the CDN edge)                                                               | Short, lightweight, middleware-style logic.                                                                                                                                     |
| Serverless compute | Functions (AWS Lambda underneath)                                                                    | Synchronous functions are cut off at the edge after about 26–30 s (MEASURED: about 26 s on the production site, 29–31 s on a throwaway site). This site runs them in Singapore. |
|                    | Background Functions (`-background` suffix)                                                          | Run up to 15 minutes; the caller only gets a 202. The repo's Stream jobs use them. Measurements are in progress in the experiments folder.                                      |
|                    | Scheduled Functions (cron)                                                                           | 30 s limit. `cron-tick.mts` is one.                                                                                                                                             |
| Async / events     | Async Workloads (an extension)                                                                       | Event-driven functions with retries and delays. It installs team-wide and was not installed during the experiments; see the experiments folder for the docs research.           |
| Data / storage     | Netlify Blobs (key-value and object store), Netlify DB (managed Postgres via Neon), Image CDN        | The repo uses Supabase instead of Netlify DB.                                                                                                                                   |
| Networking         | Netlify DNS, domains, TLS, Private Connectivity (static IPs, Enterprise only)                        | `familiarisenow.com` DNS is on Netlify.                                                                                                                                         |
| Forms / identity   | Netlify Forms, Netlify Identity (legacy)                                                             | Not used.                                                                                                                                                                       |
| Config / ops       | Environment variables per deploy context, Split Testing, Logs, Observability, Extensions marketplace |                                                                                                                                                                                 |
| Tooling            | Netlify CLI, Netlify MCP, REST API                                                                   | Both the CLI and the MCP were used in the 2026-10-31 session.                                                                                                                   |

## Vercel

The table lists Vercel's products by layer, with the measured facts from the 2026-10-31 experiments where one exists.

| Layer              | Product                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build              | Builds and Preview Deployments, Git integration                                                                           | The same idea as Netlify.                                                                                                                                                                                                                                                                                                            |
| Frameworks         | First-class Next.js support (Vercel maintains Next.js)                                                                    | No adapter is needed.                                                                                                                                                                                                                                                                                                                |
| CDN / edge         | Edge Network / CDN, ISR, cache, Image Optimization                                                                        |                                                                                                                                                                                                                                                                                                                                      |
| Edge compute       | Routing Middleware and Edge Functions                                                                                     |                                                                                                                                                                                                                                                                                                                                      |
| Serverless compute | Vercel Functions (Node, Python and others)                                                                                | MEASURED: the Hobby maximum is 300 s (a 310 s call returned 504 at 300.2 s, and `maxDuration: 800` was rejected at deploy). DOCS: Pro and Enterprise default to 300 s with an 800 s maximum, and 1,800 s is in beta. The region is selectable; MEASURED: `bom1` (Mumbai) reaches the Supabase Mumbai pooler in 1–2 ms per statement. |
|                    | Fluid compute                                                                                                             | One instance serves many concurrent requests; on by default. MEASURED: with Fluid off a 50-request burst used 50 instances; with Fluid on, warm bursts packed 20 requests onto 7 instances and 50 onto 13, at about the same latency. `vercel.json` `"fluid": false` did not take effect; only the project settings API changed it.  |
| Scheduling         | Cron Jobs (`crons` in `vercel.json`)                                                                                      | MEASURED: Hobby rejected a `*/5` cron ("limited to daily cron jobs"). DOCS: Pro allows once a minute.                                                                                                                                                                                                                                |
| Durable execution  | Vercel Workflows (Workflow DevKit, `"use workflow"` / `"use step"`)                                                       | Generally available since about April 2026; billed by Events, Data Written and Data Retained. MEASURED in `bom1`: steps ran in the project's own functions at 2.3–3.2 ms per query, a 3-step run used one invocation, completed steps did not re-run after a crash, and `start()` is not transactional with a database write.        |
| Queues             | Vercel Queues                                                                                                             | The orchestration layer under Workflows.                                                                                                                                                                                                                                                                                             |
| Data / storage     | Blob, Edge Config, and Marketplace databases (Neon Postgres, Upstash Redis, Supabase and others)                          | Vercel Postgres and KV moved to Marketplace partners.                                                                                                                                                                                                                                                                                |
| AI                 | AI SDK, AI Gateway, v0, Sandbox                                                                                           |                                                                                                                                                                                                                                                                                                                                      |
| Security           | Firewall / WAF, BotID, Deployment Protection, Static IPs ($100 per project per month on Pro), Secure Compute (Enterprise) | Whether Static IPs can be pinned to `bom1` is unverified.                                                                                                                                                                                                                                                                            |
| Observability      | Logs, Observability, Web Analytics, Speed Insights, Drains                                                                |                                                                                                                                                                                                                                                                                                                                      |
| Tooling            | Vercel CLI, Vercel MCP, Vercel plugin for agents                                                                          | All three were installed on 2026-10-31.                                                                                                                                                                                                                                                                                              |

## How the two map onto each other

The table pairs each concern with the product that covers it on each host.

| Concern                  | Netlify                           | Vercel                                  |
| ------------------------ | --------------------------------- | --------------------------------------- |
| Short serverless         | Functions                         | Vercel Functions                        |
| Cron                     | Scheduled Functions               | Cron Jobs                               |
| Long-running             | Background Functions (15 min)     | Longer functions (800 s on Pro)         |
| Durable multi-step       | Async Workloads (unverified)      | Vercel Workflows (+ Queues)             |
| Edge logic               | Edge Functions                    | Middleware / Edge Functions             |
| KV / blobs               | Netlify Blobs                     | Blob, Edge Config                       |
| Postgres                 | Netlify DB (Neon)                 | Marketplace (Neon, Supabase and others) |
| Static egress IP         | Private Connectivity (Enterprise) | Static IPs (Pro, $100 per month)        |
| Region for this database | Singapore (no Mumbai)             | `bom1` Mumbai available                 |

The last row explains most of the measured latency difference: about 62 ms per statement from Netlify Singapore against 1–2 ms from Vercel `bom1`, both MEASURED with raw `pg` against the Supabase Mumbai transaction pooler.

```
             Supabase Postgres (Mumbai, ap-south-1)
                  ▲                        ▲
     ~62 ms/stmt  │                        │  ~1–2 ms/stmt
                  │                        │
   Netlify Functions (Singapore)     Vercel Functions (bom1, Mumbai)
   Scheduled · Background · Sync     Cron Jobs · Functions · Workflows
```

## Deprecated & Superseded Approaches

- Earlier notes attributed the whole Singapore figure of about 95 ms per statement to the region. Raw `pg` measured 62–64 ms, and Prisma added about 0.1 ms or less per statement in `bom1`, so the remaining gap is unexplained rather than a Prisma cost.
