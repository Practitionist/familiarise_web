---
title: Job-runtime experiments, 2026-10-31
type: reference
---

# Job-runtime experiments, 2026-10-31

This folder holds the raw reports from five throwaway experiments that tested how background jobs behave on different runtimes. The reading guide and the conclusions are in [Background-job runtime options](../../14-background-job-runtime-options.md). The decision context and the open questions are in [Job-runtime experiments (evidence record)](../../../decisions/2026-10-31-job-runtime-experiments.md).

## The reports

The table lists each file, what it tested and what it contains.

| File                                                       | What it tested                                                                                                                                                                                                  | Contains                                                                                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [inngest-on-serverless.md](./inngest-on-serverless.md)     | Inngest SDK 4.26.2 against the local dev server, behind a proxy that returns 504 after 26 seconds.                                                                                                              | Request counts, timestamps, retry timing and the side-effect log for each of five scenarios.                                                                                  |
| [trigger-dev-latency.md](./trigger-dev-latency.md)         | Trigger.dev Cloud (CLI and SDK 4.8.3) running a probe task against the Supabase Mumbai poolers.                                                                                                                 | Round-trip and connect times by region and machine size, run cost, egress IPs and footguns.                                                                                   |
| [pg-boss-vs-dbos.md](./pg-boss-vs-dbos.md)                 | pg-boss 12.38.0 and DBOS Transact 5.4.0 on local Postgres 16, local PgBouncer, then the Supabase Mumbai poolers.                                                                                                | Cron, delay, transactional enqueue, crash recovery, concurrency, connections, latency and the UI.                                                                             |
| [lock-hold-and-static-ip.md](./lock-hold-and-static-ip.md) | Row-lock hold time and competing-update wait from Frankfurt and a laptop, Serializable conflicts, and a static-egress price and plan matrix with vendor quotes.                                                 | Run tables, the interference table, the matrix with a status per claim, and the cleanup proof.                                                                                |
| [vercel-bom1-latency.md](./vercel-bom1-latency.md)         | A throwaway Vercel Hobby project with functions pinned to `bom1`, probing the Supabase Mumbai pooler with raw `pg`.                                                                                             | Connect, round-trip, query-mix and lock-hold times; the measured duration limit; the cron rejection message and doc citations.                                                |
| [netlify-inngest-qstash.md](./netlify-inngest-qstash.md)   | A throwaway Netlify site with functions pinned to Singapore: a raw latency and lock probe, Inngest serve mode driven by the dev server, and QStash plus Upstash Workflow driven by the local QStash dev server. | Round-trip, lock-hold and query-mix tables; 504 timing on the real edge; retry and side-effect counts; schedule and delay accuracy; the dual-write demo; the dashboard links. |
| [source-code.md](./source-code.md)                         | Not an experiment. It is the throwaway scripts behind the three reports, kept as text.                                                                                                                          | The scripts, stored as markdown so lint, typecheck and the build ignore them.                                                                                                 |

## Method

- Each experiment ran in its own scratch directory outside the repository, with credentials supplied through environment variables only.
- The Inngest experiment used the local dev server, so it says nothing about Inngest Cloud's behaviour or limits.
- The Trigger.dev runs used the Free plan in the production environment of a scratch project, with the database credentials deleted afterwards.
- The pg-boss and DBOS runs used schemas named `lab_*` on the shared Supabase project, dropped at the end. The shared project holds mock data only.
- Every report records the exact library versions. Version numbers matter: both queue libraries and the Inngest SDK change defaults between releases.

## Honesty labels

- **Laptop numbers are best-case.** The local and laptop-to-Supabase figures have almost no network distance (about 40 ms to Mumbai from an Indian residential line). They are not a prediction for any production host. The only latencies measured from real cloud regions are the Trigger.dev ones.
- **Netlify's Singapore round trip (about 95 ms) is not re-measured here.** It is quoted from the ticker decision record.
- **Dollar figures are from vendor pages read on 2026-10-31** and may have changed. Plan-tier questions that the pages left unclear are marked UNVERIFIED.
- **Redactions.** Tokens, connection strings, project identifiers and the laptop address were removed from these reports. Keep it that way when appending.

## Deprecated & Superseded Approaches

None yet. The first superseded report will be listed here with the reason it was replaced.
