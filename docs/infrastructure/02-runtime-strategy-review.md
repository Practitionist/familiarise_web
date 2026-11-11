---
title: "Background jobs and runtime strategy: unbiased review and options"
type: explanation
---

# Background jobs and runtime strategy: unbiased review and options

This page was moved from a GitHub issue into the docs on 2026-10-31. It is research evidence, not a decision. The owner decisions are in [Ticker through launch, the scale path, the phase 2 queue and the database plan](../decisions/2026-10-31-ticker-scale-path-and-queue.md) and in the [architecture at scale review](../decisions/2026-10-30-architecture-at-scale-review.md); where this page disagrees with them, they win. The labels VERIFIED (read on a primary source), UNVERIFIED (no primary source was read) and ESTIMATE (arithmetic from stated assumptions) are kept from the source.

**Measurement note (added 2026-10-31).** Every "95 ms per statement" on this page is the figure in the ticker decision record, measured through the app earlier. A later probe with raw `pg` from Netlify Singapore measured 62–64 ms, and a bare Prisma client running raw queries measured below noise in `bom1`. That probe did not exercise the app's extended client, model queries or the Netlify cold path, so the gap is unexplained. A Vercel `bom1` function measured 1.0–2.1 ms. See [Background-job runtime options](../maintenance/14-background-job-runtime-options.md).

**This review argues for a different path from the one the owner chose.** It recommends one always-on Mumbai VM and no Vercel trial. The owner decision stands: launch on the Netlify ticker, trial Vercel `bom1` before about 300 users, and write the phase 2 queue as a Prisma `Job` table. Read this page as the dissenting analysis the owner asked for, and as a source of vendor facts and costs, not as the plan. Whether the VM option is in scope is listed as an open question in the [job-runtime evidence record](../decisions/2026-10-31-job-runtime-experiments.md).

## TL;DR

- **Verdict: the job design is right and the runtime is wrong.** Do not rewrite the job layer, adopt a job SaaS or trial Vercel.
- **The bet.** Before launch, run the whole app (`next start` from the existing `Dockerfile.prod`) plus an in-process scheduler on **one always-on VM in Mumbai** (AWS Lightsail `ap-south-1`, 4 GB, $24 a month, static IP included). Netlify keeps PR previews and stays as the documented failback.
- **What it fixes.**
  - The 95 ms per SQL statement, for users and jobs alike.
  - `PG_POOL_MAX=1` and cold starts.
  - The HTTP fan-out ticker's cap, slot claims and background-function workarounds.
  - The build-time versus runtime and edge versus Node quirk class.
  - The RazorpayX static-IP proxy, but only after a reviewed direct-egress change and an allowlist check (see the RazorpayX bullet under option A in section 4).
- **Cost.** About $69 a month, against about $90 to $100 on the current path. Moving the ticker drops Netlify's $25 invocation step. The proxy saving is conditional: Netlify failback still needs a working static-egress route, so the proxy stays until a separate decision retires it.
- **Effort.** 5 to 7 engineer-days.
- **Cheap fix to do now.** Split the database for previews and dev with a second Supabase project, at about $0.
- **Where the current direction is wrong.**
  - It keeps investing in ticker machinery: about 40k lines of churn in October, and 3 of the last 4 PRs.
  - It picked a Vercel `bom1` trial as the scale path.
  - It deferred the DB split.
  - It plans to hand-write a queue shaped around the ticker.

  The cheap Mumbai box was in the team's own research (#2472 Report 1). It dropped out because it was only shown as "jobs-only, later".

**Related:** #2466 (ticker, Sentry and capacity investigation) · #2472 (scale-path research: job options, Mumbai hosting, queue prototype) · #2460 (runtime assumptions: build-only env vars, edge vs Node client IP) · #2424 (operations console)

A full analysis with the plain-English explainer for the owner follows. This is a read-only review of `origin/dev` at `ebd1a2879`, the revision current when the research was written. Treat the code claims as historical and re-check them against the current tree.

Labels: **MEASURED** means read from code, git or the linked issues. **VERIFIED** means read on a vendor page on 2026-10-31. **UNVERIFIED** means no primary source was confirmed. **ESTIMATE** means my own arithmetic.

---

## 0. Verdict in one paragraph

**The job design is fine. The runtime is wrong, and the team keeps paying for that in code instead of fixing it with a roughly $24-a-month decision.**

- **What is right.** The registry, the bounded slices, the Postgres lease, compare-and-swap status moves, owed markers and database-enforced money invariants are correct, and every option below keeps them.
- **What is wrong.** The code runs as short-lived serverless functions in Singapore, against a database in Mumbai, with no long-running process. Almost every piece of job machinery written in the last month exists to work around that:
  - the 5-minute HTTP fan-out ticker, its slot cap and slot de-dupe;
  - the 202 semantics of the background functions;
  - the 16 to 24 second slice deadlines;
  - `PG_POOL_MAX=1` and its deadlock rule;
  - the build-only `NETLIFY` variable bugs and the edge-versus-Node client-IP bugs;
  - the 30-second limit, cold starts and the scheduler lag.

  So is most of the measured user-facing slowness: about 95 ms per SQL statement.

- **The team's own research found the cheap fix and then set it aside.** Report 1 in #2472 recommended a $7 to $12 Mumbai box for jobs. The owner was then shown a $100 to $440 managed-container quote, rejected it, and the plan became "keep Netlify, trial Vercel later".
- **The bet.** Run the whole app (`next start` from the existing `Dockerfile.prod`) plus an in-process scheduler on **one always-on VM in Mumbai** (`ap-south-1`).
  - Netlify stays for PR previews and as the failback that the repo already built and documented.
  - Do it **before launch**, while the data is mock and a mistake costs nothing.
  - It is cheaper than the current path (§5), it removes the 95 ms for users and jobs alike, and the VM's free static IP can later replace the RazorpayX proxy once direct egress is reviewed and failback keeps a static route.
  - It stops the weekly stream of platform-quirk PRs.

---

## 1. Plain-English explainer (for the owner)

Think of the product as a restaurant.

- **The database is the kitchen's pantry.** It is in Mumbai.
- **The app code is the cooks.** Today the cooks work in Singapore, on short contracts:
  - each one is hired for a single order;
  - each may take 30 seconds to arrive on a cold morning;
  - each is allowed to carry one item at a time from the pantry.

  Every trip to the pantry takes about a tenth of a second. A dashboard needs 30 to 100 trips, so customers wait 3 to 9 seconds, even though each trip is trivial.

- **Background jobs are the chores:** refunds owed, reminders, payouts, invoices, clean-ups. Nobody stays in the restaurant between orders, so an alarm clock rings every 5 minutes (the "ticker").
  - When it rings, it phones up to 12 temporary cooks in Singapore, one per chore.
  - Each has at most about 20 seconds to do a slice of the chore and leave a note saying where it stopped.

  A lot of clever engineering went into making this safe. That is the 9,000 lines of job machinery described below, plus 4,700 lines of tests and 9,600 lines of docs about it.

- **The alternative is to rent one permanent cook who lives next to the pantry in Mumbai.** That is a small always-on server, about ₹2,300 ($24) a month.
  - Trips to the pantry take a thousandth of a second instead of a tenth.
  - The cook never has a cold start.
  - The cook can carry many items at once.
  - The cook can do the chores whenever they are due, without an alarm clock phoning strangers.
  - The cook has a fixed address (a static IP). RazorpayX requires one before it will send payouts, and today that means renting a separate proxy.
- **What you give up.** The one cook is a single point of failure. The Singapore setup stays ready as the backup (it already is), and switching back is a documented DNS flip. You also take on light housekeeping for the server: security updates and a deploy script, roughly an hour or two a month.
- **Why now.** No real customer has paid yet. Moving now costs a few days and risks nothing real. Moving after launch means doing it with real money in flight.

---

## 2. What the evidence shows

### 2.1 The measured system (from #2466 and the 10-31 ADR)

The table summarises the measured state of the system that the rest of this review starts from.

| Fact            | Value                                                                                                                                                                  | Source                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Registered jobs | Every registered job, all on one Netlify ticker                                                                                                                        | `lib/cron/schedule.ts`, #2474    |
| Job starts      | about 2,876 a day, 3,456 slots (83 % used), cap 12 per tick                                                                                                            | #2474                            |
| Ticker health   | 446 ticks in 36 h, 0.07 % target failures, p99 15 s against a 30 s limit                                                                                               | #2466 §0 (MEASURED)              |
| Duplicate ticks | 3.5 % of slots fired twice                                                                                                                                             | #2466 §2.5 D                     |
| Scheduler lag   | p50 16 s, max 38 s past the slot                                                                                                                                       | #2466 §3.1                       |
| SQL round trip  | about 95 ms per statement (Netlify `sin` to Supabase `ap-south-1`)                                                                                                     | #2466 §3.2                       |
| Pool            | `PG_POOL_MAX=1` per Lambda; Supabase Free has 200 pooler clients                                                                                                       | #2466 §3.2                       |
| User ceiling    | roughly 300 to 500 concurrent users, set by the DB path, not by jobs                                                                                                   | #2466 §3.4                       |
| Cold boots      | historically 28 to 32 s; 1 to 2 s after #1972, to be re-measured                                                                                                       | memory note, #2466 §3.4          |
| Database        | one Supabase Free project for prod, previews and dev; mock data                                                                                                        | 10-31 ADR decision 5             |
| Netlify bill    | legacy Pro: $19 member plus a flat $25 invocation step, because the ticker pushes the site over 125k invocations. Before the ticker crossed the line, the bill was $19 | 2026-10-04 invoice (memory note) |
| RazorpayX       | live payout APIs only accept allowlisted static IPs; Netlify has none, so a paid static-IP proxy was chosen                                                            | memory note, decision F1         |

### 2.2 How much code is job machinery (MEASURED on `origin/dev`)

The table gives the measured size of the job machinery, by area, with the method in appendix A.

| Bucket                           | Lines            | What is in it                                                                                                                                                                                                                                                                  |
| -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/cron/*`                     | 5,357            | the registry (2,410, mostly HTTP adapters and metadata), `schedule.ts` (655: cadences, offsets, windows, the per-tick cap), `cleanup-route.ts` (575), `with-cron-lock.ts` (350), run record, outcome, context, deadline, streaks, refusal, deploy context, background adapters |
| `netlify/functions/*`            | 964              | `cron-tick.mts` (881) and two background functions                                                                                                                                                                                                                             |
| Job HTTP and console routes      | about 650        | `/api/cleanup/[job]`, `/api/health/jobs`, streaks, tick claim, the admin Run door, reconcile doors                                                                                                                                                                             |
| Console and generator            | about 1,700      | `job-run-metrics.ts` 351, `SystemJobsPanel.tsx` 453, executions route 141, `generate-cron-reference.ts` 464, `check-cron-heartbeat.ts` 318 (measured before it was narrowed to the Actions-scheduled workflows; it is 155 lines now)                                           |
| Run-row pruning job              | 322              | `prune-system-job-executions.ts`. It exists because the ticker writes about 92k run rows a month                                                                                                                                                                               |
| **Machinery code, total**        | **about 9,000**  |                                                                                                                                                                                                                                                                                |
| Machinery tests                  | about 4,700      | cleanup-route 631, cron-tick-targets 672, cron-lock-registry 493, with-cron-lock 416, health route 260, background tests 391, and others                                                                                                                                       |
| Platform and ops docs and skills | about 9,600      | `docs/maintenance` 3,495, `docs/deployment` 2,391, `docs/observability` 1,891, plus three skills of about 1,800                                                                                                                                                                |
| **Job business logic**           | **about 33,600** | the 72 modules the registry imports. This is an upper bound: it includes shared domain code. About 690 of those lines handle deadlines, cursors, checkpoints or `hasMore`                                                                                                      |

- **The ratio.** For every 100 lines of job logic there are about 27 lines of machinery, 14 lines of machinery tests and 29 lines of platform docs.
- **The ratio is not the problem.** A money platform with 76 obligations needs a registry, run records and single-flight. A well-run worker setup would still be about 3,000 to 4,000 lines.
- **The churn is the problem.**
  - Since 2026-10-01, 82 of 389 commits on `dev` touched the job machinery paths. Those paths saw about 23.6k lines added and 16.3k deleted.
  - Of the four PRs merged in the last two days, three are plumbing:
    - #2474, ticker resilience: +1,631 / −2,024 over 107 files;
    - #2475, Sentry escalations only: +927 / −2,017 over 56 files;
    - #2477, preview isolation and the schema gate: +720 / −117 over 47 files.

    Only #2473 (refund backoff, +1,498 / −367) changes product behaviour, and part of it, the `refundOwedNextAt` backoff, is itself a queue feature added by hand.

  - In the last week, about 20 of roughly 80 merged PR titles are runtime, cron, isolation or observability plumbing. Examples: "inline NETLIFY at build", "resolve the client IP once at the edge", "bound recording copies for Netlify background execution", "move lifecycle maintenance onto the runtime ticker", "bound housekeeping", and "a pull request's new schema objects must exist in the live database before its preview is deployed".

### 2.3 What the team already concluded (and where it then went sideways)

- The 10-30 ADR is correct on the diagnosis. Its words: "Compute is not where the data is, and it cannot pool … This one fact explains most slow pages, most timeouts and the 300 to 500 user ceiling. No code change inside the current topology removes it."
- The 10-30 ADR is also correct that "Two hosting platforms kept bootable on every commit … before launch … is insurance paid in velocity."
- Report 1 in #2472 is correct that no hosted job service fixes the 95 ms, and that "for jobs alone [the fix] costs $7–20 a month, not $100–440".
- Then the 10-31 ADR made four decisions:
  - it kept the ticker as the only engine through launch;
  - it named a **Vercel Pro `bom1` trial** as the scale path;
  - it deferred the DB split until after launch;
  - it chose a hand-written Prisma `Job` queue to run first on the ticker.

  The cheap Mumbai box dropped out because it was framed as "jobs-only, at about 1,000 users". The only "move the web tier" option the owner saw was the $100 to $440 managed-container plan.

---

## 3. Root causes of the complexity, ranked

Ranked by how much engineering time each one generates today, not by how much it hurts at 100× scale.

| Rank | Cause                                                                                                                                            | Essential or accidental                                                                                                                                             | What it generates                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **No long-running process.** Serverless functions only: 30 s scheduled limit, 15 min background limit, no worker loop                            | **Accidental** (a hosting choice)                                                                                                                                   | The HTTP fan-out ticker; the per-tick cap and offset tuning (`TARGET_OFFSET_MINUTES`); slot claims and de-dupe; one-retry logic; background 202 semantics and outcome back-reads; slice deadlines in every job; leases with a 90 s cap; `after()` as best-effort; tick-level Sentry check-ins and heartbeats; about 92k run rows a month that need pruning |
| 2    | **Compute in Singapore, data in Mumbai, one connection per instance**                                                                            | **Accidental** (Netlify has no Mumbai region)                                                                                                                       | 95 ms per statement for users and jobs; the 300 to 500 user ceiling; statement-count optimisation work; query-timeout tuning; the `PG_POOL_MAX=1` deadlock rule (AGENTS §2.1); idle "fast path" reads in sweeps; cold-start investigations                                                                                                                 |
| 3    | **One database for prod, previews and dev**                                                                                                      | **Accidental** (budget; Free plan)                                                                                                                                  | All of #2477 (job refusal on previews, production-only writes, environment filters, per-context `CRON_SECRET`); the schema-drift incidents (55 % of stored Sentry errors in #2466); load testing is impossible; previews mint production invoice numbers (#2460 F3)                                                                                        |
| 4    | **Dual-boot portability before a second host exists** (AGENTS §2.5, rule 4's fleet switch)                                                       | **Self-imposed**                                                                                                                                                    | Build-time versus runtime env bugs (#2437, #2460 F1, F2, F4); host-specific IP header rules; the failback runbook and fleet switch maintained for a host that has never run                                                                                                                                                                                |
| 5    | **Recovery by timed sweep rather than by enqueue-on-change**                                                                                     | Mostly **essential** today: inline-first with sweeps as the safety net is a sound design. It is made worse by cause 1, because a 5-minute clock is the only trigger | 76 jobs, many of them healers; fixed drain ceilings (#2466 §3.3); hand-built backoff columns (`refundOwedNextAt`)                                                                                                                                                                                                                                          |
| 6    | **Free-tier observability** (Sentry 5k errors, 1 cron monitor) with no process to watch                                                          | Accidental, budget                                                                                                                                                  | The ingest canary and its `stats_v2` rewrite; the escalation policy; the Better Stack heartbeat; the hand-built operations console (#2424)                                                                                                                                                                                                                 |
| 7    | **Process: no running CI, very large releases, rules added per incident**                                                                        | Accidental and self-imposed                                                                                                                                         | Every plumbing change needs agents, previews and long PR bodies to prove itself. AGENTS.md grows a rule per quirk                                                                                                                                                                                                                                          |
| —    | **Money correctness:** CAS, ledger triggers, owed markers, idempotency keys, Razorpay and RazorpayX, Stream, DPDP retention, GST and TDS exports | **Essential**                                                                                                                                                       | Keep all of it. No option below touches it                                                                                                                                                                                                                                                                                                                 |

**The honest summary.** Causes 1 and 2 are one decision (where and how the code runs), and they drive most of the machinery and most of the latency. Causes 3 and 4 are about $0 to $25 of decisions and some rules. The essential complexity, the 76 money and compliance obligations, is real but is not what is making it "look bad".

---

## 4. Options, in priority order

Every option keeps the domain code, the registry, the lease, CAS and the money invariants. They differ in where the code runs and what triggers it.

### Option A (recommended). One always-on VM in Mumbai runs web plus jobs; Netlify keeps previews and failback

- **Shape.**
  - One Linux VM in `ap-south-1`: AWS Lightsail 4 GB, or a 2 GB instance with swap.
  - Docker Compose runs `Dockerfile.prod` (`next start`, standalone) and Caddy for TLS. Optionally, Cloudflare Free sits in front for CDN and DDoS.
  - The image is built off-box (GitHub Actions within the capped budget, or locally) and pushed to GHCR. A deploy is `docker compose pull && up -d`.
- **Jobs.**
  - A small in-process scheduler, about 100 to 150 lines, runs every minute and calls the **same** `dueTargets()` and the **same** registry. It keeps run records, leases and outcomes by calling `cleanupRoute` directly or over `localhost`.
  - The per-tick cap, the 30 s limit, background functions and HTTP retries stop mattering on this host.
  - It sets `ops:active_cron_platform` to its own name, so the Netlify ticker stands down. That is AGENTS rule 4 exactly as written.
- **Database.** A pool of 5 to 10 through the session pooler or a direct (IPv6) connection, at about 1 to 2 ms per statement, in the same AWS region as Supabase.
- **RazorpayX.** The VM's static IP is free on Lightsail and can go on the allowlist, but that alone does not remove the proxy. `apiRequest` in `lib/payments/payouts/razorpay-payouts.ts` throws `RAZORPAYX_EGRESS_NOT_CONFIGURED` for every live key when `RAZORPAYX_EGRESS_PROXY_URL` is unset, on every host, and keeping the variable still routes through the proxy.
  - Removing the proxy on the VM needs a separately reviewed direct-egress change, plus a check that the observed source IP of a live call matches the allowlisted address.
  - Netlify failback has no static egress of its own. A DNS flip and the fleet key cannot restore live payouts if the proxy subscription or its allowlisted addresses have been retired, so a working static-egress route and its credentials must stay in place for failback.
- **Netlify.** Keeps building every PR (previews, QA agents). That alone proves the dual-boot build. The production site stays deployable as cold failback through a DNS flip and the existing runbook.
- **What it deletes from the active path.**
  - The ticker's fan-out and its cap, offsets, slot claim, retry and back-read: about 1,500 to 2,000 lines plus about 1,500 test lines, which become failback-only and frozen.
  - The background-function adapters and the Netlify 15-minute workarounds.
  - The `PG_POOL_MAX=1` deadlock class and cold starts.
  - The edge-versus-Lambda IP split: one Node process reads the proxy's `X-Forwarded-For`.
  - The build-only env-var class (#2460).
  - The RazorpayX proxy, conditionally: only after the direct-egress change, the allowlist check and a retained failback route described above.

  Over time, deadlines and slices can relax for jobs that no longer race a 20 s abort.

- **What it adds.** A Compose file and Caddyfile (about 60 lines), a deploy script (about 50), the scheduler loop (about 150), a health check and log shipping to Better Stack (already a vendor), and OS auto-updates.

### Option B. Same as A, but a managed container in Mumbai instead of a VM

- **Shape.** Google Cloud Run `asia-south1` with min-instances 1 for web, plus an always-on worker service. Fly.io `bom` would be cheaper, at about $46 to $60, but its availability is ambiguous today: it is missing from the current docs region list. Verify it before considering it.
- **Trade.** It costs more and the static IP costs extra (Fly egress IP, Cloud NAT). In return there is no OS patching, plus rolling deploys and autoscale.
- **When to choose it.** If the owner will not have a server at all. It is also the natural graduation from A at about 1,000 concurrent users.

### Option C. Jobs-only VM in Mumbai; web stays on Netlify

- **Shape.** This is Report 1's recommendation in #2472.
- **What it fixes.**
  - Job latency.
  - The ticker machinery, on the active path.
  - The RazorpayX static IP, for payout batches. Admin-initiated payouts from the web tier still need the proxy, unless they are queued to the worker.
- **What it leaves.**
  - User-facing latency and the 300 to 500 user ceiling.
  - Two runtimes in production at once.
  - The serverless quirk class for every web request.
- **Verdict.** A reasonable **first step** of A, on the same box. It is not a destination.

### Option D. Status quo, hardened (the team's current direction)

- **Plan.** Keep the Netlify ticker through launch, trial Vercel `bom1` before about 300 users, hand-write a Prisma `Job` queue that drains on the ticker, and split the database after launch.
- **Cost.** No new vendor now. The bill stays at Netlify $44 plus the proxy, plus Supabase Pro later.
- **Problem.** The churn continues. Every new quirk becomes a PR, a doc and an AGENTS rule. Job latency stays at 95 ms per statement until the Vercel trial, and the trial adds a third runtime.

### Option E. Vercel Pro in `bom1` for web and cron

- **What it fixes.** Latency, through a Mumbai region. Pooling, through Fluid compute, where one instance serves concurrent requests.
- **What it keeps.**
  - Serverless function duration limits.
  - Cron as HTTP calls into functions.
  - Long jobs need Vercel Queues or Daemons (beta).
- **What it adds.**
  - Static IPs at $100 per project per month.
  - Usage-scaled billing, about 3× the container cost at 1,000 users (Report 2 in #2472).
  - A third runtime's env semantics: another #2460.
- **Verdict.** Better than D for users, worse than A on cost, machinery and lock-in.

### Option F. A hosted job platform on top of the current web tier

- **Candidates.** Inngest, Trigger.dev, Upstash QStash or Workflow, Hatchet, Restate.
- **Problem.** These call back into your functions or run your code in their US or EU regions. Either way the 95 ms stays (see §6 for regions).
- **What they add.** A vendor in the money path, step-based billing, and a second scheduler.
- **Where they are good.** Multi-step workflows with sleeps and fan-out. This app mostly does idempotent, cursor-based sweeps.

### Option G. A runtime rewrite

- **Candidates.**
  - Cloudflare Workers with Queues, Workflows and Hyperdrive.
  - Supabase Edge Functions with pg_cron and pgmq.
  - Temporal.
  - DBOS durable workflows.
- **Problem.** Each means porting the Prisma and Node job code to another runtime or programming model. That is weeks of work with real money-correctness risk.
- **Verdict.** None of them fixes something A does not fix more cheaply.

(Costs, effort and scores are in §5. Vendor facts are in §6.)

---

## 5. Scorecard

Costs are USD per month, excluding GST. "Now" means today's fixed ticker calendar, about 87k job dispatches a month (a source-only count at this head gives 86,202 per 30 days, with at most 11 targets in one wave). "10×" means about 870k job runs a month. That column is a scenario multiplier, not a capacity derived from users: more users make each slice heavier and can grow a backlog, but they do not multiply the calendar's calls, and an event-driven design counts per-record work instead of sweep invocations. With no real users yet, no user count here is a measured limit. A costing that decides between hosts should start from one workload stated as connected users, active requests, peak requests per second and duty cycle, then requests a day, CPU seconds, resident memory time, events, steps and retries, and media bytes, applied to every host including VM saturation and burstable CPU. Hobby workflow allowances are not Pro billing, and queue, compute and storage charges are separate lines. Every row includes Supabase Pro ($25, which includes $10 of compute credit covering Micro) from the first real customer, because every path needs it.

**Fixed lines used in every row**

The table lists the monthly cost lines that are the same in every scorecard row.

| Line                                                           | Monthly cost                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Netlify legacy Pro, member seat                                | $19                                                                                                                                                                                                                                                                 |
| Netlify invocation step, once the site passes 125k invocations | $25. The ticker alone is about 93k a month, which is what pushes the site over                                                                                                                                                                                      |
| Upstash                                                        | about $1                                                                                                                                                                                                                                                            |
| RazorpayX static-IP proxy, QuotaGuard class                    | $19 to $219 by plan (QuotaGuard pricing page, CONFIRMED on 2026-10-31; see the [static-egress matrix](../maintenance/experiments/2026-10-31-job-runtime/04-lock-hold-and-static-ip.md)); the review's original estimate of about $20 to $30 matches the lowest plan |

| #     | Option                                                                                               | $/mo now                                                                                                                                                                             | $/mo at 10×                                                                                                                       | Machinery code deleted (active path)                                                                                                                                                                                                                                                                | Code added                                                    | Effort (engineer-days)     | Risk before launch                                   | Fixes 95 ms for users / jobs                                                                | Money correctness                                            | Ops burden (1 person)                                       | Lock-in and failover                                                | DPDP / residency                                      |
| ----- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| **A** | **Mumbai VM: web plus jobs** (Lightsail 4 GB $24, static IP free); Netlify for previews and failback | **about $69** = 24 (VM) + 19 (Netlify seat) + 25 (Supabase Pro) + 1 (Upstash). The $25 Netlify invocation step goes away; the proxy goes only if failback keeps another static route | **about $125**: two 4 GB VMs $48, Lightsail load balancer about $18 (UNVERIFIED), Supabase Small about $5 to $15 net, Netlify $19 | Ticker fan-out, cap, offsets, slot claim, retry, back-read and background adapters: about 1.5k to 2k lines plus about 1.5k test lines leave the active path and are frozen as failback. The `PG_POOL_MAX=1` deadlock class, the client-IP split and the build-only env class go away for production | About 300 lines plus a Compose file and a Caddyfile           | **5 to 7** (phases 0 to 2) | **Medium-low**. Mock data, and a documented failback | **Yes / Yes** (about 1 to 2 ms, same AWS region)                                            | Unchanged invariants. Enables same-transaction enqueue later | Medium-low: patching, deploys, disk; about 1 to 2 h a month | **Lowest**: plain Docker. Failback is a DNS flip plus the fleet key | Compute moves to India; fewer cross-border processors |
| B     | **Managed container in Mumbai**: Cloud Run `asia-south1`, min 1, plus a worker                       | about $130 for compute + Cloud NAT and IP (UNVERIFIED, about $30+) + $25 + $19 → **about $200**                                                                                      | about $340 to $540 for compute (Report 2) + DB → **about $400 to $600**                                                           | Same as A                                                                                                                                                                                                                                                                                           | About 400 lines plus Cloud config                             | 7 to 10                    | Medium                                               | Yes / Yes (a few ms, cross-cloud, same metro)                                               | Same as A                                                    | **Low**                                                     | Low-medium. Failback as A                                           | As A. GCP India bills in INR with GST (UNVERIFIED)    |
| C     | **Jobs-only Mumbai VM** (Lightsail 2 GB $12); web stays on Netlify                                   | **about $57** = 12 + 19 + 25 + 1, with payouts routed through the worker                                                                                                             | About $70 plus whatever web fix comes later                                                                                       | Same ticker machinery as A                                                                                                                                                                                                                                                                          | About 200 lines                                               | 3 to 4                     | Low                                                  | **No** / Yes                                                                                | Same                                                         | Medium-low                                                  | Low                                                                 | Jobs in India, web still in Singapore                 |
| D     | **Status quo hardened** (team direction): Netlify ticker, proxy, Vercel trial later                  | **about $90 to $100** = 44 + 20 to 30 + 25 + 1                                                                                                                                       | About $110 to $140 before the Vercel move. About $230+ if the Vercel static IP ($100) is bought                                   | None. It keeps adding code: about 40k lines of machinery churn last month                                                                                                                                                                                                                           | Ongoing, about 2 to 4 days a month (ESTIMATE from the churn)  | 0 now                      | Low now, rising                                      | No / No                                                                                     | Unchanged                                                    | **High, hidden in code**                                    | Medium                                                              | Web and jobs in Singapore                             |
| E     | **Vercel Pro `bom1`**: web plus Vercel Cron                                                          | $20 seat + usage of about $0 to $20 + static IP $100 (or the proxy at $20 to $30) + $25 + Netlify $19 → **about $85 to $165**                                                        | **About $900 to $1,500** at 1,000 users for Fluid compute (Report 2 ESTIMATE)                                                     | Ticker partly. Cron still fans out over HTTP, and long jobs need Queues or Daemons (beta)                                                                                                                                                                                                           | About 300 to 600 lines, plus the Vercel env and runtime fixes | 5 to 8                     | Medium (a third runtime)                             | Yes / Yes                                                                                   | Unchanged                                                    | Low                                                         | Medium-high                                                         | Indian compute                                        |
| F     | **Hosted job platform** on top of D                                                                  | D + Inngest $99 → $223; Trigger.dev $10 to $17 → about $170; QStash about $1 → $9; Hatchet $0 → about $48                                                                            | See previous column                                                                                                               | Ticker replaced by vendor schedules; most machinery stays                                                                                                                                                                                                                                           | SDK wrappers for 76 jobs                                      | 5 to 15                    | Medium                                               | **No / No**. No Mumbai compute for Trigger.dev, QStash or Hatchet; Inngest regions unstated | **Weaker**: no same-transaction enqueue, needs an outbox     | Medium                                                      | High                                                                | Adds a foreign processor                              |
| G     | **Runtime rewrite**: Cloudflare Workers, Supabase Edge (Deno), Temporal or DBOS                      | $5 to $25 platform + the porting effort; Temporal Cloud about $22 → $218 plus a worker host                                                                                          | See previous column                                                                                                               | Most ticker machinery                                                                                                                                                                                                                                                                               | A port of about 34k lines of job code                         | **30 to 60+**              | **High**                                             | Jobs only, after the port                                                                   | Risky during the port                                        | High                                                        | High (Cloudflare static IP is Enterprise-only)                      | Mixed                                                 |

**How to read the cost column.**

- Option A is **cheaper than the path the team is already on (D)**. Moving the ticker off Netlify drops the $25 invocation step, and the VM's free static IP can drop the proxy once the conditions under option A are met.
- The "$100 to $440 a month" figure the owner rejected was option B at two to five instances. It was never option A.

---

## 6. Vendor facts (web research, 2026-10-31)

### 6.1 Job platforms at about 87k runs a month now and about 870k at 10×, assuming about 3 steps per run

The table compares job platforms at the current and the ten-times run volume.

| Platform                                                      | Free tier                                                   | Now                                                                  | 10×                                   | Mumbai compute?                                                                                             | Same-transaction enqueue?                                                                                                                                                    | Static egress IP                              |
| ------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Inngest                                                       | 50k executions a month. Execution **pauses** at the quota   | Pro **$99**. About 348k executions, because each run bills steps + 1 | About **$223**                        | Regions not stated (UNVERIFIED)                                                                             | No: HTTP event send, so an outbox is needed                                                                                                                                  | Not documented                                |
| Trigger.dev v4                                                | $5 of usage                                                 | About $17 (Hobby $10 includes $10)                                   | About **$170** (Pro $50 includes $50) | **No `ap-south-1` found.** US and EU only (UNVERIFIED)                                                      | No                                                                                                                                                                           | Paid plans only                               |
| Temporal Cloud                                                | $150 of credit for 90 days                                  | About $22 plus storage                                               | About $218                            | **Yes**, `aws-ap-south-1` control plane. Workers are your own process                                       | No                                                                                                                                                                           | Your worker host's IP                         |
| Hatchet Cloud                                                 | 1M runs a month with a card on file                         | $0                                                                   | About $48                             | No (US, EU, Sydney)                                                                                         | No                                                                                                                                                                           | Your workers                                  |
| Restate                                                       | UNVERIFIED                                                  | UNVERIFIED                                                           | UNVERIFIED                            | UNVERIFIED                                                                                                  | No                                                                                                                                                                           | Your services                                 |
| DBOS Transact                                                 | The library is free                                         | $0 + a host (Conductor $99, optional)                                | $0 + a host                           | Wherever you run it                                                                                         | Partly (state lives in your Postgres; UNVERIFIED for same-transaction)                                                                                                       | Your host                                     |
| pg-boss, graphile-worker                                      | Free libraries                                              | $0 + a worker host                                                   | $0 + a host                           | Wherever you run it                                                                                         | **Yes.** graphile-worker's `add_job()` inside the Prisma transaction. pg-boss through its Prisma adapter (#2472 Report 3; the agent marked pg-boss's `db` option UNVERIFIED) | Your host                                     |
| Upstash QStash / Workflow                                     | 1,000 messages a day, below today's about 2,900 a day       | About $0.87 / about $3.5                                             | About $8.7 / about $35                | **No.** QStash runs in `eu-central-1` and `us-east-1` only                                                  | No                                                                                                                                                                           | n/a: it calls you                             |
| Cloudflare Workers + Queues + Workflows + Cron                | Workers Free; Queues 10k ops a day                          | $5                                                                   | About $23                             | A placement hint `aws:ap-south-1` exists, but **only for `fetch` handlers**. Cron handlers may run anywhere | No                                                                                                                                                                           | **Enterprise only**                           |
| Supabase pg_cron + pgmq + Edge Functions                      | 500k Edge invocations a month on Free                       | $0                                                                   | $25 (Pro, 2M included)                | **Yes**: Edge Functions can be pinned to `ap-south-1`, but they are Deno (2 s CPU, 256 MB)                  | **Yes** (pgmq in the same database)                                                                                                                                          | Not documented                                |
| Vercel Cron + Queues, Functions in `bom1`                     | Hobby crons are daily only                                  | Pro $20, likely inside its credit                                    | About $20 to $40 for jobs only        | **Yes** (`bom1`)                                                                                            | No                                                                                                                                                                           | **$100 per project per month**                |
| AWS EventBridge Scheduler + SQS + Lambda (`ap-south-1`)       | 14M scheduler invocations; 1M Lambda requests and 400k GB-s | About $0                                                             | About $30                             | Yes                                                                                                         | No                                                                                                                                                                           | **NAT gateway about $41 + an EIP about $3.6** |
| GCP Cloud Scheduler + Cloud Tasks + Cloud Run (`asia-south1`) | Free tiers                                                  | About $0 to $5                                                       | About $10 to $30                      | Yes                                                                                                         | No                                                                                                                                                                           | Cloud NAT (UNVERIFIED cost)                   |

**The key pattern.**

- **Same-transaction enqueue** is only available from Postgres-native tools: pgmq, graphile-worker, pg-boss, and possibly DBOS. Every SaaS orchestrator needs an outbox, which is what the repo already has (owed markers). So a SaaS orchestrator adds no correctness; it adds a vendor.
- **The cheapest static egress IP** in India is a Lightsail VM, where it is free. Every serverless static-IP route costs about $45 to $100 a month, or is Enterprise-only.

### 6.2 Plain hosting in or near India

The table compares plain hosting in or near India.

| Provider              | India region                                                                                                                        | 2 vCPU, 2 to 4 GB                                          | Static IP                                 | Note                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| **AWS Lightsail**     | **Mumbai** (`ap-south-1`, the same region as Supabase)                                                                              | **$12 (2 GB) / $24 (4 GB)**, public IPv4 included          | **Included free**                         | Mumbai bundles carry half the transfer allowance                     |
| DigitalOcean          | Bangalore (`blr1`)                                                                                                                  | $18 (2 GB) / $24 (4 GB)                                    | Public IPv4 bundled                       | Bangalore to Mumbai is about 12 to 25 ms (UNVERIFIED)                |
| E2E Networks (Indian) | Delhi NCR and Chennai on the rate card                                                                                              | 2 vCPU / 6 GB at ₹894 + 18 % GST                           | Not stated                                | INR GST invoice. Not in Mumbai, so the RTT needs measuring           |
| Hetzner               | **No India region** (Singapore is closest)                                                                                          | n/a                                                        | n/a                                       | Eliminated                                                           |
| Oracle Always Free    | Mumbai and Hyderabad (home region only)                                                                                             | Now 2 OCPU / 12 GB                                         | Not stated                                | Reclaimed when idle; capacity often unavailable. **Never for money** |
| Render                | **No India region**                                                                                                                 | from $7                                                    | Dedicated IPs on Pro workspaces and above | Eliminated for co-location                                           |
| Railway               | **No India region** (staff confirmed)                                                                                               | about $20 to $40                                           | Static outbound IPs on Pro                | Eliminated for co-location                                           |
| Fly.io                | **`bom` is ambiguous**: kept in the consolidation blog and had incidents in May 2026, but missing from the current docs region list | UNVERIFIED                                                 | Egress IP about $3.60 (UNVERIFIED)        | Run `fly platform regions` before relying on it                      |
| Google Cloud Run      | `asia-south1` (Mumbai)                                                                                                              | about $130 a month at launch with min instances (Report 2) | Cloud NAT                                 | Managed; INR and GST billing for Indian accounts (UNVERIFIED)        |

### 6.3 Netlify and Supabase facts that matter

- **Netlify limits.** Synchronous functions 60 s, scheduled functions **30 s**, background functions **15 min**.
- **Netlify regions.** Selectable on Pro and above: cmh, iad, pdx, sfo, yul, gru, dub, fra, lhr, nrt, **sin**, syd. **There is no Mumbai region on any plan.**
- **Netlify credit plans (2026).** Pro is $20 with 3,000 credits. The team is on **legacy** Pro, so the flat invocation step applies.
- **Supabase Pro ($25).** No pausing, 7-day daily backups, 8 GB of storage, 250 GB of egress, 2M Edge invocations and a $10 compute credit (covers Micro). Small costs $15 and Medium $60.

### 6.4 Peers and what they ran

The table lists what peer companies run for background jobs.

| Who                       | What they did                                                                                             | Region / stage               | Lesson                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unkey (2025)              | Moved API-key verification from Cloudflare Workers to stateful Go servers on Fargate                      | Not India; startup           | 6× lower latency. Serverless had pushed them into a sprawl of extra caching, batching, queue and log services. Self-hosting became one Docker command |
| Amazon Prime Video (2023) | Moved one monitoring pipeline from Step Functions and Lambda to a monolith                                | Not India; big company       | Over 90 % lower cost. It was one service, not a rejection of serverless                                                                               |
| 37signals (2023 to 2025)  | Left the cloud for owned servers                                                                          | Not India; mature            | About $2M a year saved. Shows that boring servers are operable by small teams                                                                         |
| Zerodha                   | Self-hosts on EC2, Postgres at the centre, its own small job server (DungBeetle). Avoids managed services | **India**; profitable, large | "Boring tech", low lock-in                                                                                                                            |
| Dukaan (2023)             | Moved core workloads from AWS to bare metal                                                               | **India**; startup           | An $80k a month bill could have become about $5k (secondary source)                                                                                   |
| Cal.com                   | Trigger.dev for booking orchestration                                                                     | Not India; scale-up          | A job SaaS earns its keep at millions of multi-step operations. That is not this app's shape today                                                    |
| Dub                       | Vercel Cron plus QStash                                                                                   | Not India; startup           | Fine for a US-hosted app; there is no co-location problem to solve                                                                                    |

- No credible Indian early-stage engineering blog (2023 to 2026) describing a Postgres-queue or monolith stack was found. That gap is unfilled, not evidence either way.
- The Cal.com, Dub and Zerodha rows are from #2472 Report 1.

---

## 7. Before or after launch?

**Before launch, for A's phases 1 and 2.**

- The data is mock, so a mistake in the move costs nothing.
- Measuring real p95s before and after is clean now, and it is noisy later.
- Each week on the current runtime adds more Netlify-specific code that later has to be deleted.
- The move is cheaper per month than the path already planned.
- Launch-time RazorpayX payouts need a static IP anyway: either the paid proxy or the VM.

**If the owner still says "after launch",** move as soon as any one of these trigger conditions holds:

1. The first **live RazorpayX payout** is due. That is a static IP decision, so take the VM instead of the proxy.
2. The p95 of any of the top 10 user routes is above 3 s for a week, or Supavisor client use is above 60 % of the cap.
3. Sustained concurrent users approach **150**, which is half the measured ceiling.
4. Another PR is needed for a platform-quirk class: build-time versus runtime, edge versus Node, a function limit or a scheduler limit.
5. A job's backlog grows across slices for three days, or tick p99 exceeds 24 s.
6. The ticker slot cap blocks a new job again.

---

## 8. Recommended phased plan, with exit criteria

### Phase 0, this week (about 1 engineer-day). Stop the line and fix the cheap structural items

- **Freeze new job machinery.** Defer:
  - ticker features;
  - console phase 1b in #2424 (the per-tick table);
  - the Vercel trial;
  - the hand-written queue on the ticker.

  Bugs that lose money are still fixed.

- **Database split now, at about $0.** Create a second Supabase project for previews and dev. Supabase Free allows two active free projects. Production moves to Pro ($25) before the first real payment. The free project stays in a separate Free organisation (UNVERIFIED: confirm the free-project limit applies per owner, not per org). This removes the reason for most of #2477 going forward, and makes the load test possible.
- **Decide** A versus B versus C (see the open questions).
- **Exit criteria:**
  - previews point at the preview database;
  - no new ticker code merged;
  - the owner has decided.

### Phase 1 (2 to 3 engineer-days). Mumbai VM takes over the jobs

- **Provision.** Lightsail `ap-south-1` (4 GB), with a static IP attached. Install Docker, Compose, Caddy and unattended-upgrades. Ship logs to Better Stack, and add a Better Stack uptime check on `/api/health`.
- **Deploy.** Build `Dockerfile.prod` off-box and push it to GHCR. Run it with the production env (pool 10, no `NETLIFY`).
- **Scheduler.** Add an in-process loop that calls `dueTargets(now)` every minute and runs each due target through the registry with a concurrency limit of about 4. The loop sets `ops:active_cron_platform`, and Netlify's ticker stands down. Stream and recording jobs run in-process, so they no longer need Netlify background functions.
- **RazorpayX.** Allowlist the VM's static IP and route payout calls through the VM, behind a reviewed direct-egress change, and confirm the observed source IP of a live call. Do not cancel the proxy while Netlify is the failback: it is the only static-egress route that failback has.
- **Exit criteria (7 days):**
  - zero missed or duplicate runs;
  - no new FAILED class;
  - job p95 duration down at least 5×. The measurement is `SystemJobExecution.durationMs`, before and after;
  - a failback drill: flip the key to `netlify` and confirm the ticker resumes within one tick, then flip it back.

### Phase 2 (2 to 3 engineer-days). Web moves onto the same VM

- **Routing.** Point DNS at the VM, through Cloudflare Free or directly, with a low TTL. Netlify stays deployed as the failback target.
- **Client IP.** Trust only the proxy's `X-Forwarded-For` hop on this host. One header rule replaces the edge-versus-Node split.
- **Exit criteria (7 days):**
  - the p95 of the top 10 routes is measured before and after; expect a 5 to 20× cut in DB wait;
  - no rise in the 5xx rate;
  - a DNS failback drill to Netlify in under 15 minutes;
  - the memory and CPU headroom on the VM is recorded.

### Phase 3, after launch, trigger-based. Clean up and go event-driven where it pays

- **Freeze the failback path.** Mark `cron-tick.mts`, the background functions and the HTTP-only ticker logic as failback-only. Stop extending them. Revisit AGENTS §2.5 and rule 4 so they describe "VM primary, Netlify failback" rather than the reverse.
- **Queue.** When a second owed-work source needs reaction in seconds (refunds owed, payouts), adopt a Postgres queue **inside the worker**, with transactional enqueue in the door's transaction. Sweeps become hourly safety nets. pg-boss, graphile-worker or the hand-written `Job` table are all acceptable (§9); the mistake would be building it on the ticker first.
- **Consolidation.** Merge the registered jobs toward domain workers only where it deletes code.
- **Exit criteria:**
  - the active path has no code that exists only for Netlify;
  - every money-critical owed-work source reacts in under a minute;
  - the sweeps run hourly or slower.

### Phase 4, at about 1,000 concurrent users or a measured ceiling. Scale out

- **Web.** Two VMs behind a load balancer, or graduate to option B: Fly `bom` or Cloud Run `asia-south1`.
- **Worker.** Stays a single process.
- **Database.** Supabase compute moves to Small or Medium, plus a read replica for dashboards and exports.

---

## 9. What NOT to do, and why

1. **Do not build more ticker machinery.** That means no per-tick table, no smarter slot packing and no more back-read logic. Each line is code for a runtime you should leave.
2. **Do not trial Vercel `bom1` as the scale path.**
   - It fixes latency, but it is still serverless, and its static IPs cost $100 a month.
   - Its cost scales with traffic.
   - It is a third runtime to keep dual-booted, with its own env semantics: the #2460 class again.
   - A $24 VM fixes the same things with fewer moving parts.
3. **Do not adopt Inngest, Trigger.dev, QStash, Hatchet or Restate now.** None runs your code in Mumbai, so none fixes the 95 ms. Each adds a vendor to the money path and a second scheduler.
4. **Do not port to Cloudflare Workers, Supabase Edge Functions (Deno), Temporal or DBOS workflows.** That is weeks of work in a new runtime or programming model, with money risk, and it buys nothing A does not.
5. **Do not hand-write the `Job` queue to drain on the ticker.**
   - Building it is reasonable once a long-running worker exists.
   - The current design is shaped around the ticker, which is the thing to leave.
   - On a worker, a maintained library (pg-boss: Prisma adapter for transactional `send`, cron, singleton, dead letter) is less code to own. The cost is a schema outside `db push`.
   - The hand-written table is also fine if it stays at or under about 300 lines. Choose once, on the worker.
6. **Do not defer the DB split to save money.** A second Free project costs about $0. Sharing a database with previews is a money-safety bug. It already minted invoice numbers and broke production health checks.
7. **Do not keep turning platform quirks into permanent AGENTS.md rules.** Rules §2.1 and §2.5 and parts of rule 4 encode Netlify behaviour. Once Netlify is failback-only, rewrite them shorter.
8. **Do not build the full operations console (#2424) before launch.** The run table plus a minimal page already answer "did it run". Build the rest after the runtime settles, so it is not built twice.
9. **Do not use Kubernetes, Kafka, RabbitMQ or BullMQ, or a separate Redis queue.** These were already rejected correctly.

---

## 10. Where I disagree with the current direction

The sections below are the reviewer's own view and are not adopted.

| Team position                                                            | My view                                               | Why                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The ticker is measured healthy, so keep it through launch"              | Health is not the issue; **cost of ownership** is     | 0.07 % failure is fine. But the ticker generated about 40k lines of churn in a month and three of the last four PRs. A healthy component that needs a PR every two days is not cheap                     |
| "No hosted job service, because none fixes the latency" (ADR decision 3) | Agree                                                 | This is the strongest part of the existing analysis                                                                                                                                                      |
| Scale path = Vercel Pro `bom1` trial (ADR decision 2)                    | Disagree                                              | Same benefits as a VM for more money, more serverless limits and a third runtime. It was chosen because the VM option was only shown as "jobs-only"                                                      |
| Owner rejected $100 to $440 a month for Mumbai hosting                   | The rejection was right, but the option set was wrong | One 4 GB VM is $24. It also removes the $25 Netlify invocation step, and can retire the static-IP proxy once direct egress is reviewed and failback keeps a static route. Net: cheaper than today's path |
| Split the DB after launch (ADR decision 5)                               | Disagree                                              | About $0 for a second Free project. It removes a money-safety bug class and unblocks the load test                                                                                                       |
| Hand-written Prisma `Job` table on the ticker (ADR decision 4)           | Premature                                             | Right idea (a Postgres queue, transactional enqueue), wrong time and host. Decide on the worker                                                                                                          |
| Keep both hosts bootable on every commit (AGENTS §2.5)                   | Keep it, but flip it                                  | Make the Mumbai VM primary and Netlify the failback. Previews already prove the Netlify build on every PR, so the rule becomes nearly free                                                               |
| Phase 3 "consolidate jobs into domain workers"                           | Low priority                                          | The count of jobs is not what hurts; the trigger mechanism is                                                                                                                                            |

---

## 11. Open questions for the owner

1. Are you willing to run **one small server** in Mumbai, with OS auto-updates, a deploy script and an uptime alert? (Option A.) If not, is about $50 to $60 a month for a managed Mumbai container acceptable? (Option B.)
2. Move **before launch** (recommended), or wait for one of the §7 triggers?
3. Approve the **second Supabase project** for previews and dev now, and Supabase Pro before the first real payment?
4. Has the **RazorpayX static-IP proxy** been bought yet? If not, wait for the VM's static IP.
5. **DNS:** keep Netlify DNS and point an A record at the VM, or move DNS to Cloudflare Free for CDN, DDoS and a faster failback flip?
6. Is a **GST invoice in INR** a requirement for hosting? If so, use AWS India for Lightsail billing, or E2E Networks.
7. Where should the **image be built**: GitHub Actions under the $15 cap, or locally?

---

## 12. India data residency and DPDP notes

- **No localisation requirement.** DPDP imposes no general data-localisation requirement. Section 16 is a power to restrict transfers to notified countries, and none is notified. The repo's own posture says this in `docs/compliance/01-india-first-posture.md`.
- **Moving compute to Mumbai simplifies things.** It reduces cross-border processing. The web tier currently processes personal data in Singapore on Netlify, a US company. It also simplifies the processor inventory (RoPA).
- **Payment data.** RBI's storage directive binds the payment system operator (Razorpay), which already holds payment data in India. Moving compute does not change that.
- **Vendors that stay abroad either way.** Sentry, Stream, Resend, Novu and Upstash. None of the options changes them, except that QStash, Inngest and Trigger.dev would each add one more foreign processor.
- **CERT-In.** CERT-In requires 180 days of ICT logs. The logs may be stored outside India if they can be produced to CERT-In in reasonable time (FAQ question 35), so location does not force a move; a VM whose logs you control still makes producing them easier.

---

## Appendix A. How the line counts were measured

- **Commands.** `git show origin/dev:<file> | wc -l` over:
  - `lib/cron/*` and `netlify/*`;
  - the job routes;
  - the console files;
  - the generator and heartbeat scripts;
  - the machinery tests under `__tests__/maintenance/*` and `__tests__/stream/*background*`.
- **Job logic.** The dynamic `import("@/…")` targets in `lib/cron/cleanup-registry.ts`: 72 modules, 33,628 lines.
- **Churn.** `git log origin/dev --since=2026-10-01 --numstat` over the machinery paths.
- Counts include comments and blank lines.

## Sources

**Repository and issues**

- #2466: ticker, Sentry and capacity investigation.
- #2472: scale-path research. Report 1 covers job options, Report 2 Mumbai hosting, Report 3 the queue prototype.
- #2460: runtime assumptions.
- #2424: the operations console.
- PRs #2474, #2473, #2475 and #2477.
- `docs/decisions/2026-10-30-architecture-at-scale-review.md` and `docs/decisions/2026-10-31-ticker-scale-path-and-queue.md`.
- `docs/deployment/emergency-failback-runbook.md`.
- `docs/compliance/01-india-first-posture.md`.

**Vendors, fetched 2026-10-31**

- Inngest: https://www.inngest.com/pricing
- Trigger.dev: https://trigger.dev/pricing and https://trigger.dev/changelog/static-ips
- Temporal: https://temporal.io/pricing and https://docs.temporal.io/cloud/regions
- Hatchet: https://hatchet.run/pricing
- DBOS: https://www.dbos.dev/pricing
- graphile-worker: https://worker.graphile.org/docs
- Upstash: https://upstash.com/pricing/qstash, https://upstash.com/docs/workflow/pricing and https://upstash.com/docs/qstash/howto/multi-region
- Cloudflare: https://developers.cloudflare.com/workers/platform/pricing/, https://developers.cloudflare.com/workers/configuration/placement/ and https://developers.cloudflare.com/smart-shield/configuration/dedicated-egress-ips/other-products/
- Supabase: https://supabase.com/pricing, https://supabase.com/docs/guides/functions/limits, https://supabase.com/docs/guides/functions/regional-invocation and https://supabase.com/docs/guides/queues
- Vercel: https://vercel.com/docs/cron-jobs/usage-and-pricing, https://vercel.com/docs/queues/pricing, https://vercel.com/docs/pricing/regional-pricing/bom1 and https://vercel.com/docs/networking/static-ips
- AWS: https://aws.amazon.com/lightsail/pricing/, https://aws.amazon.com/eventbridge/pricing/ and https://aws.amazon.com/lambda/pricing/
- Google Cloud: https://cloud.google.com/run/pricing and https://cloud.google.com/tasks/pricing
- DigitalOcean: https://www.digitalocean.com/pricing/droplets
- E2E Networks: https://www.e2enetworks.com/pricing
- Hetzner: https://docs.hetzner.com/cloud/general/locations/
- Oracle: https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm
- Railway: https://docs.railway.com/networking/static-outbound-ips and https://station.railway.com/questions/there-is-no-india-region-7c26b6d1
- Render: https://render.com/docs/dedicated-ips
- Fly.io: https://docs.fly.io/reference/regions and https://fly.io/blog/the-region-consolidation-project/
- Netlify: https://www.netlify.com/pricing/, https://docs.netlify.com/build/functions/optional-configuration/, https://docs.netlify.com/build/functions/scheduled-functions/ and https://docs.netlify.com/build/functions/background-functions/

**Peers**

- Unkey: https://www.unkey.com/blog/serverless-exit
- Prime Video: https://devclass.com/2023/05/05/reduce-costs-by-90-by-moving-from-microservices-to-monolith-amazon-internal-case-study-raises-eyebrows/
- 37signals: https://www.theregister.com/2024/10/21/37signals_aws_savings
- Zerodha: https://zerodha.tech/blog/hello-world/
- Dukaan (secondary source): https://analyticsindiamag.com/ai-news-updates/dukaan-moved-to-bare-metal-to-prevent-80000-a-monthly-cloud-bills

**Unverified items**

- The QuotaGuard-class proxy price.
- The Lightsail load-balancer price.
- Fly `bom` availability.
- Cloud NAT cost.
- Restate pricing.
- pg-boss's transactional `db` option (Report 3 in #2472 says it works through `fromPrisma(tx)`).
- Supabase's free-project limit per owner.
- Bangalore-to-Mumbai RTT.

## Deprecated & Superseded Approaches

Not applicable: this is a review, not an architecture doc. If the owner accepts option A, the 10-31 ADR's decision 2 (the Vercel trial) and the ticker-first timing in decision 4 become superseded, and the ADR records that.
