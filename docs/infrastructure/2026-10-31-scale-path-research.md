---
title: "Scale path for jobs and the web tier: research summary"
type: explanation
---

# Scale path for jobs and the web tier: research summary

This page was moved from a GitHub issue into the docs on 2026-10-31. It is research evidence, not a decision. The owner decisions are in [Ticker through launch, the scale path, the phase 2 queue and the database plan](../decisions/2026-10-31-ticker-scale-path-and-queue.md) and in the [architecture at scale review](../decisions/2026-10-30-architecture-at-scale-review.md); where this page disagrees with them, they win. The labels VERIFIED (read on a primary source), UNVERIFIED (no primary source was read) and ESTIMATE (arithmetic from stated assumptions) are kept from the source.

**Measurement note (added 2026-10-31).** Every "95 ms per statement" on this page is the Prisma-level figure from the ticker decision record. A later probe with raw `pg` from Netlify Singapore measured 62–64 ms, and a Vercel `bom1` function measured 1.0–2.1 ms. See [Background-job runtime options](../maintenance/14-background-job-runtime-options.md).

This issue collects the 2026-10-31 research on where background jobs and the web tier should run as Familiarise grows, so the owner can pick a scale path. **Nothing is adopted yet.** It follows #2466 (the ticker and Sentry production readiness work) and replaces the phase-1 "move web + worker to Mumbai" option ($100–440/month), which the owner rejected as too expensive.

The full reports are separate pages:

1. Background jobs and cron: 25 options, what startups do, and the cheapest path per stage.
2. A costed comparison of hosting in Mumbai.
3. A Postgres queue prototype for owed refunds (pg-boss vs a hand-written Prisma `Job` table).

### The main finding

**The scheduler is not the bottleneck; the database path is.**

- The Netlify ticker was measured healthy in #2466: 0.07% failed calls, and the slowest tick took 18.5 s against the 30 s limit. Its real faults are code fixes, now in PR A (#2466).
- What breaks first is the database, at roughly **300–500 concurrent users**. Three causes:
  - Supabase Free and Micro have a 200-client pooler limit.
  - Every serverless instance holds one connection (`PG_POOL_MAX=1`).
  - Each SQL statement costs about **95 ms**, because Netlify runs our functions in Singapore and the database is in Mumbai.
- **No job service fixes the 95 ms.** Inngest, Trigger.dev, QStash, Hatchet and Temporal all call back into our code, which still runs on Netlify in Singapore, and none of them hosts compute in India. Only code running in Mumbai removes it.

### How bad is 95 ms per statement?

- A page that runs its queries one after another pays 95 ms for each one.
- A light page with 5–10 statements costs about **0.5–1 s** in network time alone.
- A heavy dashboard with 30–100 statements costs **3–9 s** warm. This matches what we have measured before.
- In Mumbai the same statement costs about **1–2 ms**. The 3–9 s dashboard would drop to well under 1 s, and nothing else would change.
- Jobs pay the same tax: the three "idle" sweeps spend about 4.3 s doing almost nothing.
- Today the cheap levers are fewer statements per page (batching, `relationLoadStrategy: "join"`) and fast-path reads.

### Does Netlify have an Indian region?

**No.** The self-serve function regions are cmh, dub, fra, gru, iad, lhr, nrt, pdx, sfo, sin, syd and yul. Paris and Milan are available through support, but Mumbai is not listed. Netlify Edge Functions run at Indian points of presence, but they are a Deno runtime that cannot hold a normal Postgres/Prisma connection pool, so they don't help database-heavy pages.

- Docs: https://docs.netlify.com/build/functions/optional-configuration/
- Region-selection blog post: https://www.netlify.com/blog/netlify-functions-region-selection/

### Options at a glance (USD/month; details in the comments)

The table compares each path by extra cost and by whether it removes the 95 ms per statement for jobs and for users.

| Path                                                 | Extra cost                                    | Fixes 95 ms for jobs | Fixes 95 ms for users | Notes                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------- | -------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Keep the Netlify ticker (with PR A)                  | $0                                            | no                   | no                    | Measured healthy; the default through launch                                                                                        |
| Jobs-only AWS Lightsail box in Mumbai                | $7–12                                         | **yes**              | no                    | Same code and routes. Takes over through `ops:active_cron_platform`, with one-key failback to Netlify. Free static IP for RazorpayX |
| Vercel Pro project, jobs only, Mumbai                | ~$20                                          | yes                  | no                    | Managed. A static IP costs $100/mo                                                                                                  |
| **Move the web tier to Vercel (bom1) + Vercel Cron** | ~$20/seat + usage (UNVERIFIED at our traffic) | yes                  | **yes**               | Fluid compute shares one instance across many requests (a pool > 1). Netlify stays the hot standby (AGENTS §2.5)                    |
| QStash dispatcher instead of the ticker              | ~$1–9                                         | no                   | no                    | Per-message retries and delays, but a new vendor in the failback path                                                               |
| Cloud Run / Fly / Fargate (web + worker) in Mumbai   | $46–440                                       | yes                  | yes                   | Rejected on cost for now                                                                                                            |
| Inngest / Trigger.dev / Temporal / Hatchet           | $0–99+                                        | no                   | no                    | Their compute isn't in India; Inngest's free tier pauses at its quota                                                               |
| RabbitMQ / Kafka / BullMQ / Kubernetes               | —                                             | —                    | —                     | Overkill at our size. Upstash Kafka shut down on 2025-03-11                                                                         |

Not job runners: Blacksmith (CI runners, relevant only to PR D #2471). "Ranos" matched no product; Render and Railway have no India region.

### Serverless vs serverful, in plain words

- **Serverless (today):** Netlify starts a short-lived function for each request. You pay per use and there is nothing to maintain. But each instance holds its own database connection, can't stay running, and is capped at 30 s per scheduled run.
- **Serverful:** one or more always-on processes. They keep a warm pool of database connections and can loop forever (a queue worker). The cost is a fixed monthly bill and some upkeep.
- **Middle ground:** Vercel Fluid compute is still serverless, but one instance serves many requests at once, so connections are shared.
- **Recommendation shape:** keep the web tier serverless. Only the jobs need an always-on process, and only once the triggers below fire.

### Triggers for moving the jobs off the Netlify ticker

Move when any of these holds:

- a job's backlog grows for a week;
- ticks run above 24 s at p99;
- pooler usage stays above 60%.

Before real customers, upgrade Supabase to Pro ($25: backups, no pausing). Move to Small compute ($15, 400 pooler clients) near about 150 sustained concurrent users.

### Decisions recorded

The owner recorded these decisions on 2026-10-31. They are repeated in the ADR above.

- Launch on the Netlify ticker ($0, with the #2466 PR A fixes).
- Before ~300 concurrent users, trial the web tier on Vercel Pro in bom1, with Vercel Cron as the ticker. Netlify stays the hot standby. No QStash unless a per-message retry or delay need appears.
- Next step: a cheap Vercel spike after PRs A–D, preview env only. It measures the Mumbai→Supabase query latency, the real cron limits and duration cap, and the expected monthly bill.
- Queue design for phase 2: a hand-written Prisma `Job` table.

### Open questions and unverified facts

- Vercel: the current cron limits on Pro (40 vs 100 per project), the function duration cap, and the Fluid active-CPU pricing in bom1.
- Whether Netlify support would enable ap-south-1 on request.
- Cloud Run asia-south1 price tier; Vultr, Linode and E2E Mumbai prices.
- An RTT measurement from a Mumbai box to Supabase (expected 1–2 ms).

Related: #2466, #2460, #2095, #1010, #2424.

The three full reports are separate pages: [background jobs and cron options](./2026-10-31-background-jobs-and-cron-options.md), [Mumbai hosting comparison](./2026-10-31-mumbai-hosting-comparison.md) and [queue prototype on owed refunds](./2026-10-31-queue-prototype-owed-refunds.md). The follow-on review is [runtime strategy review](./2026-10-31-runtime-strategy-review.md), and the runtime pictures are in [job runtime system designs](./2026-10-31-job-runtime-system-designs.md).

## Deprecated & Superseded Approaches

The phase 1 option of moving web and worker into an always-on Mumbai container ($100 to $440 a month) was rejected on cost and replaced by the Netlify ticker through launch and a Vercel `bom1` trial. Hosted job services were rejected because none removes the 95 ms per statement.
