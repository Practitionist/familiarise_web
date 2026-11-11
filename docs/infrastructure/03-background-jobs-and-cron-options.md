---
title: "Background jobs and cron: options and the cheapest credible path"
type: explanation
---

# Background jobs and cron: options and the cheapest credible path

This page was moved from a GitHub issue into the docs on 2026-10-31. It is research evidence, not a decision. The owner decisions are in [Ticker through launch, the scale path, the phase 2 queue and the database plan](../decisions/2026-10-31-ticker-scale-path-and-queue.md) and in the [architecture at scale review](../decisions/2026-10-30-architecture-at-scale-review.md); where this page disagrees with them, they win. The labels VERIFIED (read on a primary source), UNVERIFIED (no primary source was read) and ESTIMATE (arithmetic from stated assumptions) are kept from the source.

**Measurement note (added 2026-10-31).** Every "95 ms per statement" on this page is the figure in the ticker decision record, measured through the app earlier. A later probe with raw `pg` from Netlify Singapore measured 62–64 ms, and a bare Prisma client running raw queries measured below noise in `bom1`. That probe did not exercise the app's extended client, model queries or the Netlify cold path, so the gap is unexplained. A Vercel `bom1` function measured 1.0–2.1 ms. See [Background-job runtime options](../maintenance/14-background-job-runtime-options.md).

Research only, dated 2026-10-31. Nothing was signed up for, changed or deployed. Prices come from vendor pricing pages fetched on 2026-10-31 unless a row is marked **UNVERIFIED** (no primary source could be read today) or **ESTIMATE** (my arithmetic from stated assumptions).

Inputs read: `AGENTS.md` rules 1–4, `docs/decisions/2026-10-30-architecture-at-scale-review.md` (origin/dev), issue #2466 (report §3 capacity, §4.2 item 6 scheduler shape), `netlify/functions/cron-tick.mts` (origin/dev), memory note on RazorpayX static-IP allowlisting.

---

## 0. The answer in eight lines

1. **The Netlify ticker is not the problem at pre-launch volume.** It was measured healthy: 446 ticks in 36 h, 0.07% blips, p99 15 s against the 30 s cap, no lock contention (#2466 §0). It costs $0.
2. **What breaks first is the database path, and user traffic breaks it, not jobs.** The break comes at roughly 300–500 concurrent active users, from the 200 pooler clients on Nano/Micro, one connection per Lambda and about 95 ms per statement. The ticker adds 9–10 clients for a few seconds every 5 minutes, which is about 5% of the cap (#2466 §3.2, §3.4).
3. **Job count does not scale with users.** About 2,850 runs/day is set by cadence (every registered job runs on a fixed interval). More users make each slice heavier but do not add runs. "10×" only happens if you go event-driven (one job per state change) or tighten cadences.
4. **No job SaaS (Inngest, Trigger.dev, QStash, Hatchet, Temporal) fixes the 95 ms.** They all call back into your code. Your code still runs on Netlify in Singapore unless you also move it to Mumbai compute, and none of them hosts compute in Mumbai.
5. **The only thing that fixes job latency is running job code in Mumbai.** For jobs alone that costs **$7–20 a month**, not $100–440: one small always-on box, or one managed jobs-only deployment in Mumbai, wired into the existing `ops:active_cron_platform` switch. Netlify stays as the failback, which is what AGENTS rule 4 already describes.
6. **Nothing short of moving the web tier fixes user-facing latency.** What raises the user ceiling cheaply is the database, not the scheduler: Supabase Pro plus the right compute size (Small doubles pooler clients to 400 for about $15) and fewer statements per route.
7. **Kafka, RabbitMQ, BullMQ and Kubernetes are overkill here.** Each needs a worker anyway, and Postgres is already the queue and the lock.
8. **"Ranos" does not exist as a hosting or job product that I can find.** The owner most likely means **Render** or **Railway**. Neither has an India region; both stop at Singapore, which is where Netlify runs today. **Blacksmith** is a GitHub Actions CI runner, not a job runner.

---

## 1. Plain-English explainer: four different things people call "background jobs"

The table defines the four concepts and gives an analogy and example products for each.

| Concept               | What it is                                                                                                                                                                                            | Analogy                                                | Who decides when work runs          | Example products                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cron (scheduler)**  | A clock that fires "run X at 02:00" or "every 15 minutes". It does not remember whether X succeeded, does not retry, and does not hold work.                                                          | An alarm clock.                                        | The clock.                          | Netlify scheduled functions, Vercel Cron, Cloudflare Cron Triggers, `pg_cron`, GitHub Actions `schedule`, EventBridge Scheduler, Cloud Scheduler, `node-cron` |
| **Queue**             | A list of to-do items ("refund #123 is owed"). Producers add items and workers take them one at a time. Good queues retry, delay, de-duplicate and dead-letter failures.                              | A ticket rail in a kitchen.                            | The arrival of work (event-driven). | Postgres `SKIP LOCKED` tables (pg-boss, graphile-worker, Supabase Queues/pgmq), QStash, SQS, Vercel Queues, Cloudflare Queues, BullMQ                         |
| **Durable execution** | A queue plus a memory of progress inside a multi-step function. If step 3 of 5 crashes, it resumes at step 3 and does not redo steps 1–2. It also gives "sleep 3 days, then continue" without a cron. | A recipe card where every finished step is ticked off. | The engine, step by step.           | Inngest, Trigger.dev, Temporal, Hatchet, Upstash Workflow, Vercel Workflow                                                                                    |
| **Broker**            | A high-throughput message bus between many services. It routes, fans out and buffers messages but has no idea of "jobs", "cron" or "retries with backoff" unless you build them.                      | A post office sorting room.                            | Whoever subscribes.                 | RabbitMQ, Kafka, Redpanda, Google Pub/Sub, SNS                                                                                                                |

**What this repo already has.** The repo already has three of the four, built on Postgres:

- the cron is the Netlify ticker;
- the queues are the state-as-outbox tables (`owed` markers, notification and email outboxes);
- the durable progress is the bounded slices with saved cursors and a lease (`withCronLock`, `SystemJobExecution`).

**The real gaps.**

- There is no in-process, event-driven queue worker.
- Retries happen only at the next tick.
- The code runs 95 ms away from the data.

A broker would add nothing.

---

## 2. Today's numbers used for every cost below

- **V1 (today).** About 2,850 job runs a day, which is about **85,500 a month**, plus 288 ticker invocations a day: about 93,000 Netlify invocations a month (#2466 §3.1).
- **V10.** About **855,000 job runs a month**. This only happens with event-driven enqueue or much tighter cadences; user growth alone does not cause it (see §0 point 3).
- **Job wall time today.** p50 1.1 s, p95 7.5 s, max about 10 s on Netlify (Sentry spans, #2466 §2.6). I use **2 s mean** for HTTP-wait billing.
- **Job wall time in Mumbai.** A job of about 20 statements goes from about 2 s to about 0.1–0.3 s at about 1 ms per statement (ADR: "about 95 ms to about 1 ms"). This is an ESTIMATE.

---

## 3. Comparison table

Legend for the "95 ms fixed?" column: **Yes** means the job code runs in Mumbai, next to Supabase `ap-south-1`. **No** means the code still runs on Netlify in Singapore.

| #   | Option                                                                                                    | $/mo at V1                                                                | $/mo at V10                                               | 95 ms fixed?                                                                                                                                   | Postgres connections                                                 | Second scheduler? (rule 4)                                                              | Lock-in / failback                                                            | Effort with existing `/api/cleanup/[job]` doors                                         | Money jobs fit?                                                        |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A   | **Netlify ticker (current)**                                                                              | **$0**                                                                    | ~$25 (legacy Pro step above 125k invocations, #2466 §3.2) | No                                                                                                                                             | 1 per Lambda, about 10 per tick                                      | It _is_ the scheduler                                                                   | Native; already the failback                                                  | None                                                                                    | Yes (today)                                                            |
| A2  | Netlify background functions                                                                              | $0                                                                        | same as A                                                 | No                                                                                                                                             | same                                                                 | No (dispatched by the ticker)                                                           | Native                                                                        | Small (fix 202/retry semantics, #2460 F10)                                              | Only once failures are recorded, not thrown                            |
| B   | **Upstash QStash** (schedules → HTTP doors)                                                               | **~$0.86**                                                                | ~$8.55                                                    | No                                                                                                                                             | unchanged (Netlify)                                                  | Yes, unless it _replaces_ the ticker via the switch                                     | Low: plain HTTP + signature; flip the switch back to Netlify                  | Small: one schedule per job, verify `Upstash-Signature` in the door                     | Yes (idempotent doors + lease)                                         |
| C   | Upstash Workflow                                                                                          | ~$1–3 (messages per step)                                                 | ~$10–30                                                   | No                                                                                                                                             | unchanged                                                            | Same as B                                                                               | Medium: workflow code is SDK-shaped                                           | Medium                                                                                  | Yes, but no gain over our cursors                                      |
| D   | **Inngest Cloud**                                                                                         | **$99** (Free 50k executions/mo is too small; it _pauses_ at the quota)   | ~$99–135                                                  | No                                                                                                                                             | unchanged                                                            | Same as B                                                                               | Medium-high: functions written to the SDK                                     | Medium: `serve()` route + one cron function per job or one fan-out                      | Risky on Free (pause); fine on Pro                                     |
| E   | **Trigger.dev Cloud** (task fetches our door)                                                             | ~$5 usage → **$10 Hobby** (Free allows only 10 schedules)                 | ~$51 (Pro $50 incl. $50 usage)                            | No: compute in US/EU, no Mumbai region found                                                                                                   | unchanged                                                            | Same as B                                                                               | Medium-high                                                                   | Medium                                                                                  | Yes; offers static IPs per region                                      |
| E2  | Trigger.dev self-hosted                                                                                   | box with ≥4 GB, e.g. Lightsail $24 (ESTIMATE) + ops                       | same                                                      | Only if self-hosted in Mumbai                                                                                                                  | own Postgres + Redis                                                 | Same as B                                                                               | Low lock, high ops                                                            | High                                                                                    | Yes, but heavy for 76 short jobs                                       |
| F   | Temporal Cloud (has `ap-south-1`) + a worker                                                              | ~$21 actions (ESTIMATE, 5 actions/run at $50/M) + worker box $7–12        | ~$107–214 + box                                           | Yes, via the Mumbai worker                                                                                                                     | worker pool                                                          | Same as B                                                                               | High (workflow programming model)                                             | High: rewrite to workflows/activities                                                   | Yes, but overkill                                                      |
| F2  | Temporal self-hosted                                                                                      | $24+ box + its own DB                                                     | same                                                      | Yes, if in Mumbai                                                                                                                              | own                                                                  | Same as B                                                                               | Low lock, very high ops                                                       | Very high                                                                               | Overkill                                                               |
| G   | Hatchet Cloud (1M runs/mo free with card)                                                                 | $0 + where tasks run                                                      | $0 + same                                                 | Only if its worker runs in Mumbai                                                                                                              | worker pool                                                          | Same as B                                                                               | Medium (young vendor)                                                         | Medium-high: worker process or Vercel serverless adapter                                | Yes                                                                    |
| H   | **Vercel Pro, jobs-only project in `bom1`** + Vercel Cron                                                 | **$20** (1 seat; $20 credit covers usage)                                 | ~$20–30                                                   | **Yes** (`bom1` = `ap-south-1`)                                                                                                                | Fluid compute: an instance serves concurrent calls, so pool >1 works | No, if it is the active host behind the switch and Netlify is standby                   | Medium (second platform), but the dual-boot rule already keeps both buildable | Medium: deploy the same repo; the Vercel Cron route reuses the ticker's dispatch module | Yes. Static IPs cost $100/project/mo, so RazorpayX keeps the proxy     |
| I   | Cloudflare Workers Cron + Queues                                                                          | $5                                                                        | ~$5.60                                                    | Only if job code is **ported to Workers** with Hyperdrive + placement hint `aws:ap-south-1`. Placement is documented for `fetch` handlers only | Hyperdrive pools                                                     | Same as B                                                                               | High (runtime port)                                                           | Low if it only calls the doors (then no latency fix); very high to port 76 Prisma jobs  | Not worth the port                                                     |
| J   | Supabase `pg_cron` + `pg_net` → doors                                                                     | $0                                                                        | $0                                                        | No (calls Netlify)                                                                                                                             | none extra                                                           | Same as B                                                                               | Low, but the scheduler dies with the DB                                       | Small                                                                                   | Weak failure visibility: `pg_net` is fire-and-forget                   |
| J2  | `pg_cron` → Supabase Edge Functions with `x-region: ap-south-1`                                           | $0 (500k invocations free)                                                | $0 on Pro (2M incl.)                                      | Yes                                                                                                                                            | Deno; fresh connection per call                                      | Same as B                                                                               | High (Deno port)                                                              | Very high (port jobs out of Next/Prisma)                                                | Not worth the port                                                     |
| K   | GitHub Actions `schedule`                                                                                 | blocked (budget); ~$50–70 for a 5-min runner (ESTIMATE)                   | same                                                      | No (US runners: worse)                                                                                                                         | n/a                                                                  | Yes                                                                                     | n/a                                                                           | n/a                                                                                     | No: min 5 min, delayed/dropped at load                                 |
| L   | AWS EventBridge Scheduler + Lambda in `ap-south-1` (+SQS)                                                 | ~$0 (14M scheduler + 1M Lambda req + 400k GB-s free)                      | ~$0–8                                                     | **Yes** (same AWS region as Supabase)                                                                                                          | Lambda again: 1 per instance, but only ~10 concurrent                | No, if it replaces via the switch                                                       | Medium (IAM, packaging)                                                       | High: jobs must be bundled outside Next.js                                              | Yes. A static IP needs a NAT gateway (hourly, tens of $; UNVERIFIED)   |
| M   | Google Cloud Scheduler + Cloud Run `asia-south1`                                                          | ~$0 (3 scheduler jobs free; run free tier)                                | ~$5–15 (ESTIMATE)                                         | **Yes** (cross-cloud, same metro; a few ms, UNVERIFIED)                                                                                        | an instance takes concurrent requests, so pool 5                     | No, if it replaces                                                                      | Medium                                                                        | Medium: needs a production container image                                              | Yes. A static IP needs Cloud NAT                                       |
| N   | **Always-on box in Mumbai** (AWS Lightsail `ap-south-1`) running the same build + the ticker's dispatcher | **$7** (1 GB)                                                             | **$12** (2 GB)                                            | **Yes** (~1 ms, same AWS region)                                                                                                               | Real pool, 5–10                                                      | No: it becomes the active host; the Netlify ticker skips via `ops:active_cron_platform` | **Low lock**; failback = flip one Redis key                                   | Medium: production Dockerfile + deploy script; doors unchanged                          | **Yes**, and a free attached static IP can be allowlisted by RazorpayX |
| N2  | DigitalOcean droplet / App Platform, Bangalore                                                            | $6 droplet / $5–12 App Platform                                           | same                                                      | Mostly (BLR→Mumbai ~15–25 ms, UNVERIFIED)                                                                                                      | real pool                                                            | same as N                                                                               | Low                                                                           | Medium (App Platform = no OS patching)                                                  | Yes                                                                    |
| N3  | Linode Mumbai / Vultr Mumbai                                                                              | ~$5 / ~$6 (Mumbai price UNVERIFIED)                                       | same                                                      | Yes (cross-provider, same city)                                                                                                                | real pool                                                            | same as N                                                                               | Low                                                                           | Medium                                                                                  | Yes                                                                    |
| N4  | Oracle Cloud Always Free, Mumbai                                                                          | $0                                                                        | $0                                                        | Yes                                                                                                                                            | real pool                                                            | same as N                                                                               | Account/capacity risk                                                         | Medium                                                                                  | **No** for money: Mumbai A1 capacity is reportedly scarce              |
| N5  | E2E Networks (Indian, INR + GST invoice)                                                                  | UNVERIFIED (old listings ~₹2,000+/mo)                                     | same                                                      | Yes                                                                                                                                            | real pool                                                            | same as N                                                                               | Low                                                                           | Medium                                                                                  | Yes                                                                    |
| N6  | Fly.io `bom` machine, always on                                                                           | ~$4–8 (512 MB–1 GB; `bom` priced above the $3.69/$6.70 `iad` list)        | same                                                      | Yes (cross-provider, same city)                                                                                                                | real pool                                                            | same as N                                                                               | Low-medium                                                                    | Medium                                                                                  | Yes, but `bom` had deploy restrictions in Sep 2025                     |
| O   | RabbitMQ (CloudAMQP Little Lemur, shared plans in Mumbai)                                                 | $0 + a worker                                                             | $0–19 + a worker                                          | Only via the worker's location                                                                                                                 | worker pool                                                          | Still needs a scheduler                                                                 | Low                                                                           | High                                                                                    | Adds a second source of truth                                          |
| P   | BullMQ on Upstash Redis                                                                                   | PAYG idle polling burns commands (reports of ~3M/mo idle ≈ $6); Fixed $10 | $10+                                                      | Only via worker                                                                                                                                | worker pool                                                          | Needs repeatable jobs = scheduler                                                       | Medium                                                                        | High                                                                                    | Adds a second source of truth                                          |
| Q   | Kafka (Upstash Kafka **discontinued 2025-03-11**; Confluent/Redpanda)                                     | tens of $ upward (not fetched today)                                      | same                                                      | n/a                                                                                                                                            | n/a                                                                  | n/a                                                                                     | High                                                                          | Very high                                                                               | Overkill                                                               |
| R   | Google Pub/Sub, SQS as a broker                                                                           | ~$0                                                                       | ~$0                                                       | Only via consumer location                                                                                                                     | consumer                                                             | Needs a scheduler                                                                       | Medium                                                                        | High                                                                                    | Overkill                                                               |
| S   | Kubernetes (EKS/GKE)                                                                                      | control plane alone ≈ tens of $/mo (EKS)                                  | same                                                      | If in Mumbai                                                                                                                                   | —                                                                    | —                                                                                       | —                                                                             | Very high                                                                               | **Overkill. Do not.**                                                  |

---

## 4. Option notes (the things the table cannot say)

### A. Netlify scheduled and background functions (current)

- Facts:
  - Scheduled functions have a 30 s execution limit and run only on published deploys.
  - Background functions run up to 15 minutes and return `202` immediately. In the measured environment, v2 default-export handlers that throw were not retried, while legacy `exports.handler` exceptions, `process.exit(1)` and timeout kills were retried after about 1 and then 2 minutes. Record failure explicitly in our own run row and keep the work idempotent.
  - Netlify has no Mumbai function region (sin is the nearest; #2466 §3.2).
- The pain points, sorted by what fixes each one:
  - **30 s tick cap.** Observed max is 18.5 s. Not hit.
  - **At-least-once duplicate ticks.** Already absorbed by the Postgres lease, by design.
  - **Background functions hide failures.** A code fix (#2460 F10: record the failure, return 200), not a platform change.
  - **10/10 slots full.** A code constant. Bundling the 20 fifteen-minute sweeps into 4–5 dispatch groups frees slots (#2466 §4.2 item 2). This fits rule 1, because each member still calls its single registry function.
  - **95 ms, `PG_POOL_MAX=1`, pooler cap.** Structural to Netlify plus Supabase Free. No scheduler change fixes them.

### B/C. QStash and Upstash Workflow

- **Pricing.**
  - Free is 1,000 messages a day, which is too small for 2,850 runs a day.
  - Pay-as-you-go is **$1 per 100K messages**, with 1,000 schedules free and up to 2 h HTTP duration.
  - Regions are EU and US only. That does not matter, because QStash only sends the trigger.
- **What it buys.** Each job gets its own schedule, so there is no 10-slot ceiling and no shared 24 s tick deadline. You also get per-message retries with backoff, a DLQ and failure callbacks.
- **What it does not buy.** The job still runs as a Netlify function in Singapore with one connection. The per-request edge cut (~26 s measured) also still applies.
- **Rule 4.**
  - It may only _replace_ the ticker: the ticker reads the switch and skips when another platform is active.
  - That needs a small change, because today the switch values mean "netlify vs a Mumbai host". QStash would become a third value, or the "Mumbai host" would be QStash calling Netlify.
- **The owner's reference point.** Dub runs Vercel Cron plus QStash for its Next.js jobs.

### D. Inngest

- **Pricing.** Every run and every step counts ("a function with 5 `step.run()` calls uses 6 executions"). Our 85k runs a month exceed the Free 50k, and Free _pauses_ at the quota rather than billing. That makes it unsafe for payouts and reconcilers. **Pro starts at $99/mo** for 1M executions.
- **Fit.** It needs an Inngest route (an `api/inngest` handler under `app/`, not present in this repo) served from Netlify, so the same latency remains.

### E. Trigger.dev

- **Pricing.**
  - Per run: $0.000025 (that is $0.25 per 10k runs).
  - Compute on the smallest machine: $0.0000169 per second.
  - Plans: Free ($5 credit, 10 schedules), Hobby ($10, 100 schedules), Pro ($50).
- **Calculation.** A task that only `fetch`es our door and waits about 2 s costs about $5/mo at V1, so Hobby at $10. At V10 it is about $51/mo. This is an ESTIMATE.
- **Regions.** I found three AWS regions, US and EU, and no Mumbai. Running our job _code_ on Trigger compute would therefore be slower than Netlify, not faster.
- **Self-hosting.** It is a multi-service stack (webapp with Postgres and Redis, plus a worker supervisor). The cloud-only features listed are warm starts, auto-scaling and checkpoints. Too heavy for short sweeps.
- **Real user.** Cal.com runs booking orchestration and calendar syncs on Trigger.dev.

### F/G. Temporal and Hatchet

- **Temporal.**
  - Cloud has had `ap-south-1` since August 2023.
  - Pay-as-you-go starts at $50 per million actions, with $150 credit for 90 days.
  - Both Temporal and Hatchet need a long-running worker process that you host. The latency fix comes from _that worker_ being in Mumbai, not from the SaaS.
- **Hatchet Cloud.** It gives 1M task runs a month free once a card is on file, then $30 per million. Its serverless adapter is documented for Vercel, not Netlify.
- **Verdict.** You would pay the worker cost _and_ learn a workflow model. For idempotent, cursor-based sweeps this buys nothing over the existing lease plus slices.

### H. Vercel, jobs-only, in `bom1`

- **Facts.**
  - `bom1` is a Vercel compute region (`ap-south-1`).
  - Cron on Pro allows 100 jobs per project at per-minute precision. Hobby is once a day, ±59 min, and is for non-commercial use.
  - Pro is $20 per seat with a $20 usage credit.
  - Invocations cost from $0.60 per million; Active CPU from $0.128 per hour; provisioned memory from $0.0106 per GB-hour.
  - At V1, about 85k short I/O-bound calls fit inside the credit (ESTIMATE).
- **New, beta.**
  - Vercel Daemons are always-on background containers, in beta since 2026-10-15, on all plans, production only. `bom1` support is not stated.
  - Vercel Queues is billed per operation.
  - Both signal that even Vercel now treats "serverless plus a worker" as normal.
- **Why consider it.** Same repo, same Next.js build, no server to patch, and it rehearses the possible later web move to `bom1`. That was the ADR's "least change" path, but here it is for jobs only.
- **Cost of choosing it.**
  - It is a second live platform. The dual-boot rule already keeps it buildable, but env vars, secrets and deploys now have two homes.
  - Static IPs are $100/project/mo, so RazorpayX payouts still need the proxy (decision F1).

### I. Cloudflare Workers

- **Pricing.** Workers Paid is $5/mo with 10M requests and 30M CPU-ms. There is no separate charge for Cron Triggers. Queues include 1M operations, then $0.40/M. Hyperdrive queries are unlimited on Paid.
- **Placement.**
  - Placement hints such as `aws:ap-south-1` run the Worker in the Cloudflare data centre closest to that cloud region.
  - The docs say placement "only affects the execution of fetch event handlers". Cron/scheduled handlers may run anywhere, "on underutilized machines".
- **Verdict.** Getting the latency fix means porting the job code (Prisma and Node APIs) into the Workers runtime. That is not worth it for jobs. As a mere HTTP trigger it is just a $5 version of QStash.

### J. Supabase `pg_cron` / `pg_net` / Edge Functions

- **Capabilities.** Supabase Cron schedules down to every second. It recommends at most 8 concurrent jobs and at most 10 minutes per job. Edge Functions can be pinned to `ap-south-1` with an `x-region` header. Free includes 500k invocations; Pro includes 2M, then $2/M.
- **`pg_net` → Netlify doors.** It costs $0, but it is fire-and-forget: the response lands in a table nobody watches. It also gives the database a second job (scheduling) and fixes no latency.
- **Edge Functions in Mumbai.** They fix latency, but they are Deno, outside the Next.js/Prisma codebase, so it is a port.
- **Worth noting.** Supabase Queues (pgmq) is free inside your own DB. It is the "Postgres is the queue" pattern the ADR already recommends, and it needs no new vendor.

### K. GitHub Actions `schedule`

- **Limits.** The minimum interval is 5 minutes. Runs "can be delayed during periods of high loads" and "some queued jobs may be dropped". Scheduled workflows in public repos are disabled after 60 days of inactivity.
- **Budget.** The org's Actions budget is exhausted today, which is why 11 jobs run nowhere (#2466).
- **Verdict.** Not a production scheduler for money.

### L/M. AWS Lambda + EventBridge Scheduler, Google Cloud Run + Cloud Scheduler

- **Cost.** Both are effectively free at V1 and V10:
  - EventBridge Scheduler: 14M invocations a month free.
  - Lambda: 1M requests and 400k GB-s free.
  - SQS: 1M requests free.
  - Cloud Scheduler: 3 jobs free.
  - Cloud Run: a monthly free tier; `asia-south1`'s pricing tier differs between Google pages (UNVERIFIED).
- **Latency.** Both fix it. Lambda in `ap-south-1` is the _same AWS region_ as Supabase.
- **Lambda's catch.** Packaging. The jobs live inside a Next.js app, so they would have to be bundled into a standalone handler, with care around Next-only imports. The connection is also back to one per instance; that is fine, since jobs run at most about 10 at a time.
- **Cloud Run's catch.** It needs a production container image (today's `Dockerfile` is a dev image running `npm run dev`).
- **Static egress IPs.** Both need a NAT gateway (AWS) or Cloud NAT (GCP), which adds cost.

### N. A small always-on box in Mumbai (the planned #2095 shape, sized for jobs only)

- **Price.** AWS Lightsail in `ap-south-1` costs $5 (0.5 GB), **$7 (1 GB, 2 TB transfer)**, $12 (2 GB) or $24 (4 GB) a month. Mumbai gets half the transfer allowance, but the prices are the same.
- **What runs on it.** One container running a `next start` standalone build of the same repo, plus the ticker's existing dispatch logic, either:
  - calling `http://localhost:3000/api/cleanup/[job]`, which keeps the doors and `CRON_SECRET` exactly as they are; or
  - calling the registry in-process.
- **Scheduler.** It sets `ops:active_cron_platform` to its own name, and the Netlify ticker then skips every target. This is AGENTS rule 4 as written ("active Mumbai host"). It is a _replacement_, not a second scheduler.
- **Connections.** About 1 ms to Supabase, the same AWS region. A real pool of 5–10 through the Supavisor pooler, or a direct connection. Supabase direct connections are IPv6 by default, and Lightsail supports IPv6.
- **Cold starts.** None.
- **Bonus.** A Lightsail static IP attached to the instance is free, and RazorpayX accepts up to 20 allowlisted IPs. Payout-batch jobs running there could skip the static-IP proxy. Admin-initiated payouts from the web tier still need it.
- **Sizing.**
  - Do not build on the box: a Next.js build of this repo needs more RAM than 1–2 GB. Build the image elsewhere and push it.
  - 1 GB is tight for `next start` plus Prisma, so add swap; 2 GB is comfortable.
- **Real cost.** The cost is ops, not dollars: OS patching, a deploy script, a health check, log shipping (Better Stack is already in use) and an alert when the box is down. Failback is one Redis key flip back to `"netlify"`.
- **Alternatives.**
  - DigitalOcean (Bangalore, $6 droplet; App Platform $5+ without OS patching).
  - Linode Mumbai (Nanode $5 list price).
  - Vultr Mumbai (~$6).
  - E2E Networks (INR and GST invoice, pricing UNVERIFIED).
  - Fly `bom` (shared-cpu-1x 512 MB $3.69 list in `iad`, more in `bom`; no free tier).
  - Oracle Always Free Mumbai ($0, but reportedly capacity-starved and an account-risk; never for money jobs).
- **Kubernetes.** Overkill: a managed control plane costs more than the whole workload, for one container.

### O–R. Brokers

- **The common problem.** Each still needs (a) a worker process somewhere and (b) a scheduler. They add a second source of truth next to Postgres, while the money invariants (CAS, ledger triggers, leases) live in Postgres.
- **RabbitMQ.** CloudAMQP Little Lemur is free (1M messages/mo, 20 connections), and shared plans are offered in Mumbai. Fine software, wrong problem.
- **BullMQ on Upstash pay-as-you-go.**
  - Upstash's own docs warn that BullMQ "accesses Redis regularly, even when there is no queue activity" and recommend a Fixed plan ($10/mo for 250 MB).
  - Idle-polling reports range from about 3M commands a month (≈ $6) to far more with default `drainDelay`.
  - Not prohibitive in dollars, but pointless when Postgres is already the queue.
- **Kafka.** Upstash Kafka was deprecated on 2024-09-11 and discontinued on 2025-03-11. Confluent and Redpanda are built for event streaming at a scale this product will not reach (ADR: "Kafka, a separate queue broker and microservices would add failure modes without removing a bottleneck").

### Not job runners

- **Blacksmith.** Managed GitHub Actions runners, billed per minute (2 vCPU about $0.004/min vs GitHub's $0.008, vendor claim). It is relevant only to the _CI_ decision (ADR decision 1, `temp/ci-cost-study.md`), not to cron.
- **"Ranos".** No product by that name turns up. The likely intended products, with their regions:
  - **Render**: Oregon, Ohio, Virginia, Frankfurt, Singapore.
  - **Railway**: California, Virginia, Amsterdam, Singapore.

  Neither has an India region, so neither fixes the 95 ms; Singapore is where Netlify already runs. If the owner meant **Northflank**, it can deploy into your own AWS `ap-south-1` or GCP `asia-south1` account (bring-your-own-cloud), and that would fix latency.

---

## 5. Plain answers to the four questions

### Q1. Is the Netlify ticker a bad choice at pre-launch volume?

**No. It is fine until roughly 300–500 concurrent active users, and what breaks at that point is the database path, not the scheduler.**

- Measured: 0.07% failed calls, no lock contention, and a max tick of 18.5 s against 30 s.
- The scheduler's first limit is a code constant (10 targets per tick, all used). Bundling sweeps fixes it for $0.
- The 95 ms per statement makes each job slower, but nobody waits on a job. It only lowers slice drain rates (#2466 §3.3), and those are tunable per job.
- The database limit comes first and comes from user traffic:
  - 200 pooler clients on Nano/Micro;
  - one connection per Lambda;
  - 30–100 statements per heavy page at 95 ms each.

  Changing the job runner does not move that line.

### Q2. What do typical early-stage startups on Vercel/Netlify do?

They start with the platform cron. When they need retries, delays or fan-out, they add a managed HTTP queue or durable-execution service. Teams that already run Postgres and care about simplicity keep Postgres as the queue and add one worker box only when needed. Examples:

| Who                                                 | What they do                                                                                                                                                                | Source                                                                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dub** (Next.js on Vercel)                         | Vercel Cron routes guarded by `CRON_SECRET` or a QStash signature, with batch fan-out via QStash                                                                            | [Upstash customer page](https://upstash.com/customers/dub), [DeepWiki on dubinc/dub](https://deepwiki.com/dubinc/dub/9-background-jobs-and-cron-system)                                       |
| **Cal.com** (scheduling, close to our domain)       | Trigger.dev for booking orchestration, calendar syncs and async fan-out at millions of operations a month                                                                   | [Trigger.dev × Cal.com post](https://www.plushcap.com/content/trigger-dev/blog/trigger-dev-powering-calcoms-core-booking-engine-with-ai-scans-calendar-syncs-and-durable-async-fan-out-tasks) |
| **Zerodha** (India-first reference, not serverless) | "Scaling with common sense": simple boxes, Postgres at the centre, its own small job server (DungBeetle) to protect the primary DB                                          | [zerodha.tech scaling posts](https://zerodha.tech/tags/scaling), [DungBeetle](https://github.com/zerodha/dungbeetle/wiki)                                                                     |
| **Supabase's own guidance**                         | `pg_cron` for schedules and Supabase Queues (pgmq) inside the database, at no extra charge                                                                                  | [Supabase Queues launch](https://supabase.com/blog/supabase-queues), [Supabase Cron](https://supabase.com/docs/guides/cron)                                                                   |
| Teams on pg-boss in serverless                      | pg-boss polls every 1–2 s, which fights serverless and idle-suspending databases. One team moved to Google Cloud Tasks. Lesson: a Postgres queue wants an always-on worker. | [dev.to write-up](https://dev.to/twio_ai/from-pg-boss-to-cloud-tasks-fixing-queue-bursts-and-db-connection-failures-on-serverless-ii5)                                                        |
| Vercel itself                                       | Shipped Queues and (beta, Oct 2026) Daemons, which are always-on containers for workers next to serverless                                                                  | [Vercel Daemons guide](https://vercel.com/kb/guide/vercel-daemons), [Vercel Queues pricing](https://vercel.com/docs/queues/pricing)                                                           |

I found no public write-up from an Indian startup on Netlify or Vercel describing its job architecture. The Indian reference above (Zerodha) argues for fewer moving parts, which agrees with the ADR.

### Q3. Does any option fix the real bottleneck without moving the web tier?

- **For jobs: yes.** Any option that runs the job code in Mumbai fixes it:
  - a Lightsail box (N);
  - Vercel `bom1` (H);
  - Lambda in `ap-south-1` (L);
  - Cloud Run `asia-south1` (M);
  - a Temporal or Hatchet worker hosted in Mumbai.

  Job statements drop from about 95 ms to about 1 ms, and jobs get a real pool. Jobs stop costing one pooler client per Lambda.

- **For users: no.** No job runner touches user requests. Without moving the web tier, the cheap levers are:
  1. **Supabase compute.** Small (~$15/mo; Pro includes $10 of compute credit) raises pooler clients from 200 to 400, and Medium (~$60) to 600. This moves the 300–500-user ceiling the most per dollar.
  2. **Fewer statements per request.** Batch reads, use `relationJoins` and Postgres functions for the heaviest dashboards. Latency is about 95 ms × statement count, so halving statements halves page time.
  3. **Caching for public and read-mostly pages.** ISR or the CDN.
  4. Nothing on Netlify can put functions in Mumbai. The self-serve region list stops at Singapore.

### Q4. The cheapest credible path at each stage

The table gives the cheapest credible path at each stage of growth.

| Stage                           | Jobs/cron                                                                                                                                                                                                                                                                                            | Database                                                                                                                                                                   | Extra $/mo for jobs |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **Pre-launch (now, mock data)** | Keep the Netlify ticker. Do the #2466 code fixes: bundle the 15-minute sweeps to free slots; put the 11 stranded jobs on the ticker; background functions record failure and return 200 (F10); Sentry escalations only.                                                                              | Free is fine for mock data. Pro + Micro ($25) and the preview/prod split _before real money_, as already decided.                                                          | **$0**              |
| **~100 concurrent users**       | Still the Netlify ticker (≈10–30% of the pooler cap, #2466 §3.2). Watch slice drain (§3.3): auto-complete, reminders, payouts.                                                                                                                                                                       | Pro + Micro ($25). Start statement-budget work on the top N+1 routes.                                                                                                      | **$0**              |
| **~1,000 concurrent users**     | Move jobs to a **jobs-only Mumbai host** behind `ops:active_cron_platform`: Lightsail `ap-south-1` 2 GB ($12), or Vercel Pro `bom1` ($20) if no server is wanted. Netlify ticker = standby. Then add the in-worker Postgres queue (ADR phase 2), which replaces timed sweeps with enqueue-on-change. | Pro + Small/Medium compute ($15–60 compute, partly covered by the $10 credit). Decide on the web-tier move from _measured_ p95 and pooler-client use, not from user count. | **$7–20**           |

**Trigger to move jobs earlier than 1,000 users.** Move sooner if any of these holds for a week: a job's backlog keeps growing across slices; tick p99 stays above 24 s; or Supavisor client use stays above 60% of the cap.

---

## 6. Recommendation

**1. Primary: keep the Netlify ticker through launch, and fix it in code ($0).**

- **Why.** It is measured healthy, AGENTS-native, and its known faults (slot ceiling, background 202/retry, Sentry noise, stranded jobs) are code fixes already scoped in #2466.
- **What to do.**
  - Spend the money on Supabase Pro first (backups, no pausing): $25.
  - Then right-size compute when pooler use climbs: Small ~$15, Medium ~$60.
  - Fund CI. Blacksmith or a capped Actions budget belongs there, not in jobs.

**2. When jobs need Mumbai: a jobs-only box on AWS Lightsail `ap-south-1` ($7–12/mo).**

- **Why.**
  - It is the cheapest way to fix the 95 ms for jobs: same AWS region as Supabase, about 1 ms per statement.
  - It gives a real connection pool and no cold starts.
  - A free static IP can be allowlisted for RazorpayX payout batches.
  - It adds no new vendor model: same repo, same `/api/cleanup/[job]` doors, same registry, same lease.
  - It plugs into the `ops:active_cron_platform` switch that already exists, so Netlify is the failback with one key flip.
- **Not the rejected plan.** This is the ADR's phase 1 "worker" without moving the web tier, at about 3–10% of the rejected $100–440.
- **Cost.** About a day of setup and a little ops: a production image, a deploy script, a health monitor in Better Stack.

**3. Alternate if nobody wants to run a server: a Vercel Pro jobs-only project in `bom1` ($20/mo).**

- **Pros.**
  - Managed, same Next.js build, Vercel Cron at per-minute precision.
  - Fluid compute lets an instance hold a pool.
  - It rehearses a later web move to `bom1`.
- **Cons.**
  - A second live platform to keep env-synced.
  - Static IPs are $100/project, so the RazorpayX proxy stays.
- **Same price band.** Cloud Run `asia-south1` + Cloud Scheduler (~$0–15) works too, but needs a production container image and a GCP account.

**Considered and not recommended now:**

- **QStash (~$1–9/mo).** A good cheap _dispatcher_ (per-job schedules, retries, DLQ). It does not fix latency or connections, and it must replace the ticker, not sit next to it. Use it only if the scheduler shape, not latency, becomes the pain before Mumbai is justified.
- **Inngest ($99/mo) and Trigger.dev ($10–51/mo).** Good products for multi-step workflows. They are priced for, and shaped for, a problem we do not have (76 idempotent slices with cursors and leases), and neither runs code in India.
- **Temporal and Hatchet.** Need a worker anyway; overkill.
- **Cloudflare, Supabase Edge Functions.** Need a runtime port to get the latency benefit.
- **RabbitMQ, Kafka, BullMQ, Pub/Sub, SQS, Kubernetes.** A second source of truth or an ops burden with no bottleneck removed.
- **GitHub Actions cron.** Budget-blocked, and it drops runs under load.
- **Render, Railway ("Ranos"?).** No India region.

---

## 7. Sources (fetched 2026-10-31)

Durable execution and queues:

- Inngest pricing: https://www.inngest.com/pricing
- Trigger.dev pricing: https://trigger.dev/pricing · self-hosting: https://trigger.dev/docs/self-hosting/overview · regions changelog: https://trigger.dev/changelog/us-west-2
- Upstash QStash pricing: https://upstash.com/pricing/qstash · multi-region: https://upstash.com/docs/qstash/howto/multi-region
- Upstash Redis pricing: https://upstash.com/pricing/redis · BullMQ note: https://upstash.com/docs/redis/integrations/bullmq · Fly forum idle BullMQ: https://community.fly.io/t/pay-as-you-go-pricing-for-redis-databases/16253
- Upstash Kafka deprecation: https://upstash.com/blog/workflow-kafka · https://community.fly.io/t/deprecation-notice-for-upstash-kafka/21775
- Temporal pricing: https://temporal.io/pricing · Mumbai region: https://temporal.io/blog/temporal-in-india-ap-south-1-mumbai-available-today-for-temporal-cloud · https://docs.temporal.io/cloud/regions
- Hatchet pricing: https://hatchet.run/pricing · Vercel serverless adapter: https://docs.hatchet.run/v1/serverless/vercel
- Defer: `defer.run` 301-redirects to `digger.tools` (checked with curl today). Service gone; profile: https://apis.io/providers/defer-run/

Platform cron:

- Netlify scheduled functions: https://docs.netlify.com/build/functions/scheduled-functions/ · background functions: https://docs.netlify.com/build/functions/background-functions/ · pricing: https://www.netlify.com/pricing/ · regions: https://docs.netlify.com/build/functions/optional-configuration/
- Vercel cron limits: https://vercel.com/docs/cron-jobs/usage-and-pricing · regions (bom1): https://vercel.com/docs/regions · pricing: https://vercel.com/pricing · Queues: https://vercel.com/docs/queues/pricing · Daemons (beta): https://vercel.com/kb/guide/vercel-daemons
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/ · limits: https://developers.cloudflare.com/workers/platform/limits/ · placement: https://developers.cloudflare.com/workers/configuration/placement/ · cron triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Supabase Cron: https://supabase.com/docs/guides/cron · Edge Function regions: https://supabase.com/docs/guides/functions/regional-invocation · pricing: https://supabase.com/pricing · compute sizes: https://supabase.com/docs/guides/platform/compute-and-disk · Queues: https://supabase.com/blog/supabase-queues
- GitHub Actions schedule: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

Cloud primitives and brokers:

- AWS EventBridge pricing: https://aws.amazon.com/eventbridge/pricing/ · Lambda: https://aws.amazon.com/lambda/pricing/ · SQS: https://aws.amazon.com/sqs/pricing/
- Google Cloud Scheduler: https://cloud.google.com/scheduler/pricing · Cloud Run: https://cloud.google.com/run/pricing · Pub/Sub: https://cloud.google.com/pubsub/pricing (pages did not render; figures marked UNVERIFIED)
- CloudAMQP plans: https://www.cloudamqp.com/plans.html
- Confluent and Redpanda pricing pages could not be fetched today (timeout or blocked); no figures quoted.

Always-on compute:

- AWS Lightsail: https://aws.amazon.com/lightsail/pricing/
- DigitalOcean droplets: https://www.digitalocean.com/pricing/droplets · App Platform pricing: https://docs.digitalocean.com/products/app-platform/details/pricing/ · availability (BLR): https://docs.digitalocean.com/products/app-platform/details/availability/
- Fly.io pricing: https://docs.fly.io/about/pricing · region consolidation (bom kept): https://fly.io/blog/the-region-consolidation-project/ · bom restriction thread (Sep 2025): https://community.fly.io/t/region-bom-cannot-host-your-machine-because-your-organization-is-on-a-legacy-or-non-paid-plan/26006
- Linode/Akamai: https://www.linode.com/pricing (Mumbai price UNVERIFIED) · Vultr Mumbai: https://baxtel.com/news/vultr-opens-cloud-data-center-in-mumbai (price UNVERIFIED; vultr.com returned 403)
- Oracle Always Free: https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm · capacity anecdote: https://autokaam.pages.dev/tutorials/oracle-arm-always-free-tier-2026-real-limits/
- E2E Networks listings (dated): https://www.whtop.com/plans/e2enetworks.com/91725
- Render regions: https://render.com/docs/regions · Railway regions: https://docs.railway.com/reference/deployment-regions · Northflank AWS ap-south-1: https://northflank.com/cloud/aws/regions/ap-south-1
- Blacksmith: https://docs.blacksmith.sh/blacksmith-runners/pricing

Startup examples: listed inline in §5 Q2.

## Deprecated & Superseded Approaches

The GitHub Actions cron fleet and its wrapper scripts are superseded by the Netlify ticker; the Actions minutes budget is exhausted. QStash, Inngest, Trigger.dev, Temporal and Hatchet are evaluated here and not adopted.
