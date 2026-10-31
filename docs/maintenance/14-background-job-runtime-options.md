---
title: Background-job runtime options and what the 2026-10-31 experiments showed
type: explanation
---

# Background-job runtime options and what the 2026-10-31 experiments showed

This page explains where background jobs can run, what each candidate runtime actually does with our code, and what four throwaway experiments measured on 2026-10-31. It is evidence for decisions the owner has already taken. It does not take a new one. The decisions are in [Ticker through launch, the scale path, the phase 2 queue and the database plan](../decisions/2026-10-31-ticker-scale-path-and-queue.md) and [Architecture at scale](../decisions/2026-10-30-architecture-at-scale-review.md). The evidence record, with the open questions for the owner, is [Job-runtime experiments](../decisions/2026-10-31-job-runtime-experiments.md). The raw reports are indexed in [the experiment folder](./experiments/2026-10-31-job-runtime/README.md).

Two experiments are still running and are marked **Pending** below: a lock-hold and interference measurement, and a check of which Trigger.dev plan includes static IPs.

## 1. Today: the Netlify ticker

All 76 registered jobs run from one Netlify scheduled function, `netlify/functions/cron-tick.mts`, every five minutes. Each tick calls the due jobs over HTTP at `/api/cleanup/[job]`, and the six long Stream and recording jobs through Netlify background functions. Every job has one implementation in `lib/cron/cleanup-registry.ts`. A run is a bounded slice: a `?limit=`, a deadline, a saved cursor and a Postgres lease taken by `withCronLock` (`lib/cron/with-cron-lock.ts`, backed by `SystemJobExecution`).

```mermaid
flowchart LR
  subgraph NF["Netlify functions, Singapore"]
    TICK["cron-tick.mts<br/>every 5 min, 30 s limit"]
    JOB["/api/cleanup/[job]<br/>one function instance per target<br/>PG_POOL_MAX=1"]
  end
  subgraph MUM["Mumbai, ap-south-1"]
    DB[("Supabase Postgres<br/>leases, run rows, CAS, outbox state")]
  end
  TICK -->|"HTTP + CRON_SECRET"| JOB
  JOB -->|"about 95 ms per statement"| DB
```

The scheduler and the compute are the same platform. The experiments below ask what changes when only the scheduler moves (Inngest), when both move to someone else's machines (Trigger.dev), or when the queue moves into the database and a long-lived worker reads it (pg-boss, DBOS).

## 2. What each runtime does with our code

### 2.1 Inngest replaces the scheduler, not the compute

Inngest never runs our code. It calls an HTTP endpoint that we host, built with the SDK's `serve()` adapter. On Netlify that endpoint is an ordinary Next.js route function, so it has the same Singapore location, the same one connection and the same time limits as every other route.

```mermaid
flowchart LR
  subgraph ING["Inngest (cloud or dev server)"]
    SCHED["Cron, sleep and retry state"]
  end
  subgraph NF["Netlify function, Singapore"]
    SERVE["serve() route<br/>runs the step code"]
  end
  DB[("Postgres, Mumbai")]
  SCHED -->|"POST, one request per step or per batch of steps"| SERVE
  SERVE -->|"each statement pays the round trip"| DB
  SERVE -->|"result in the response, or on a side channel"| SCHED
```

The experiment ran the SDK (`inngest` 4.26.2) against the local Inngest dev server behind a proxy that answers 504 after 26 seconds, which is the edge timeout measured on this site. Its results:

| Setup                                      | Result                                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three 1 s steps, default checkpointing     | One request for the three steps.                                                                                                                                                                                       |
| Same steps, `checkpointing: false`         | Four requests: one per step and one to finish.                                                                                                                                                                         |
| One 40 s step, checkpointing off           | The proxy answered 504 at 26 s on every attempt. Inngest retried after about 31 s and about 60 s, then marked the function failed. The step body ran to the end each time, so its side effect was written three times. |
| One 40 s step, checkpointing on            | The 504 still happened, but the result reached Inngest on a side channel, so the retry found the step already done and the side effect ran once.                                                                       |
| Ten 5 s steps, default (`maxRuntime` 10 s) | Seven requests, each at most 10 s, no 504.                                                                                                                                                                             |
| Ten 5 s steps, `maxRuntime: "20s"`         | Five requests, the longest 20.1 s, no 504.                                                                                                                                                                             |
| Ten 5 s steps, `maxRuntime: 0` (no cap)    | The proxy answered 504 at 26 s although the function kept running for 50 s. Inngest retried, and the last step ran twice at the same time.                                                                             |
| `step.sleep("10s")`                        | Two sub-millisecond requests 10 s apart. Nothing was held open on our side.                                                                                                                                            |
| Cron every minute                          | One request per minute, on the minute, sent by the dev server.                                                                                                                                                         |

Four conclusions follow, and each names its limit.

- **Inngest does not lift the host limit.** One step must fit inside one request. A single step longer than the 26 s edge cut fails on every retry. The SDK setting `checkpointing.maxRuntime` (default 10 s for `serve`) only splits a sequence of short steps into several requests, and it is checked between steps, never in the middle of one. Set it below the host limit minus the longest step.
- **At-least-once still applies.** The host keeps running after the edge answers 504, so a retry can repeat a side effect. Checkpointing can hide this, but it is not a guarantee.
- **Sleep and cron are Inngest's.** That is what Inngest sells: a durable timer outside our process. It would be a second scheduler beside the ticker, which `AGENTS.md` rule 4 forbids unless it replaces the ticker.
- **Inngest Connect** is the SDK mode where our process holds an outbound connection to Inngest and receives work over it. The SDK documents a five-minute default for it, but it needs a process that stays alive, which Netlify functions are not. The experiment did not exercise Connect.

The experiment used the local dev server only. Behaviour of Inngest Cloud, including its pricing and plan limits, was not measured.

### 2.2 Trigger.dev Cloud runs our code, but not near Mumbai

Trigger.dev runs the task on its own machines. A task that queries Postgres therefore runs in the region Trigger.dev offers, and the account used accepted only `us-east-1`, `us-west-2` and `eu-central-1`. Requests for `ap-south-1` and `ap-southeast-1` were rejected, so there is no Asian region to choose.

```mermaid
flowchart LR
  subgraph TD["Trigger.dev Cloud machines"]
    TASK["Task container<br/>eu-central-1, us-east-1 or us-west-2"]
  end
  DB[("Supabase pooler and Postgres, Mumbai")]
  APP["Our app, Netlify"] -->|"tasks.trigger(), an API call"| TD
  TASK -->|"every statement: 125 to 232 ms"| DB
```

Each row below is the median of 50 `SELECT 1` round trips to the Mumbai pooler on the transaction port (6543). The session port (5432) differed by less than 5 ms.

| Where the code runs                                    | Median round trip | Connect (TCP, TLS, auth) | 20-query mix, total |
| ------------------------------------------------------ | ----------------: | -----------------------: | ------------------: |
| Laptop in India (not representative)                   |           39.4 ms |               251–277 ms |      1,050–1,078 ms |
| Trigger.dev `eu-central-1` (Frankfurt)                 |            125 ms |               742–777 ms |      2,605–3,679 ms |
| Trigger.dev `us-east-1`                                |            185 ms |                 1,123 ms |            3,986 ms |
| Trigger.dev `us-west-2`                                |            232 ms |                 1,408 ms |            4,811 ms |
| Trigger.dev, no region given                           |            185 ms |                 1,122 ms |            3,866 ms |
| Netlify Singapore, from the ADR (not re-measured here) |       about 95 ms |                      n/a |                 n/a |

Reading the table:

- **The best Trigger.dev region is slower than Netlify today.** Frankfurt at about 125 ms is roughly a third worse than Singapore at about 95 ms, and an unset region lands in `us-east-1`, nearly twice as slow. Moving a chatty job to Trigger.dev makes its database time worse.
- **Connect cost is six to six and a half round trips**, so a task must reuse its connection.
- **Cost per run** for the probe, which makes over a hundred serial round trips, was 0.035 to 0.124 US cents depending on region and machine size, on a base fee of 0.0025 cents. A `micro` machine ran the same speed at half the price.
- **Egress IPs are dynamic on the Free plan.** The eu-central-1 runs used `3.40.0.x` addresses and the us-east-1 runs a single address, but nothing guarantees they stay. Trigger.dev's changelog says static IPs are for paid customers. It does not say which plan, so whether the cheapest paid tier includes them is **Pending** (static-IP plan verification). RazorpayX would need the static address, see [section 4](#4-questions-the-owner-asked).

The vendor facts here were read from Trigger.dev's changelog and pricing page on 2026-10-31. The documentation pages for regions and static IPs returned 404 on that date, so they could not be cross-checked.

### 2.3 pg-boss and DBOS keep the queue in Postgres

Both libraries store their jobs in the database and run workers in our own process. The enqueue happens inside the caller's transaction, so a rolled-back business change leaves no job behind. Neither is a hosted service, and neither supplies compute: a long-lived worker process must exist somewhere, ideally in Mumbai.

```mermaid
flowchart LR
  subgraph APP["App or worker process"]
    TX["BEGIN<br/>business write + enqueue<br/>COMMIT"]
    W["Worker loop<br/>poll or LISTEN"]
  end
  subgraph PG["Postgres"]
    BIZ[("Business tables")]
    Q[("Queue / workflow tables<br/>pgboss or dbos schema")]
  end
  TX --> BIZ
  TX --> Q
  W -->|"claim rows"| Q
```

The experiment ran pg-boss 12.38.0 and DBOS Transact 5.4.0 on a local Postgres 16, through a local PgBouncer in transaction mode, and finally through the Supabase Mumbai poolers using throwaway `lab_` schemas that were dropped afterwards.

| Check                                             | pg-boss 12.38                                                                                                                                                            | DBOS 5.4                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Enqueue inside the caller's transaction           | Correct. Rollback left 0 jobs, commit left 1 (`db` option).                                                                                                              | Correct. Rollback left 0 workflows, commit left 1 (`enqueueInTransaction`, same database only).                                      |
| Through the Supabase 6543 and 5432 poolers        | Worked on both.                                                                                                                                                          | Worked on both, with the pool caveat below.                                                                                          |
| Cron, two workers, local                          | One job per minute for 7 minutes.                                                                                                                                        | One workflow per minute for 6 minutes; the id contains the minute, so a duplicate is refused.                                        |
| Cron on Supabase, first minute after `schedule()` | A second job fired 30 s after the first, in 2 of 2 runs, on both poolers. Steady state was once a minute. Cause not found; clock skew was 80 ms.                         | Fired once per minute on 6543; not run on 5432.                                                                                      |
| Concurrency limit of 2, two workers               | Up to 4 ran at once, because the limit is per process.                                                                                                                   | 2 at once, because the limit is global.                                                                                              |
| Kill -9 during step 2 of 3                        | The whole job reran after about 65 s (a 60 s monitor interval is the floor). Step 1's side effect ran twice. With default settings recovery would take about 15 minutes. | The workflow resumed about 3 s after restart. Step 1 did not rerun; its side effect ran once. Only the same executor id recovers it. |
| Connections per idle worker                       | 3 to 5.                                                                                                                                                                  | 3 to 4, one of them idle in transaction.                                                                                             |
| Enqueue-to-start latency, local                   | About 1 s polling; about 7 ms with LISTEN/NOTIFY on both the instance and each queue.                                                                                    | About 0.2 s polling.                                                                                                                 |
| LISTEN/NOTIFY through a transaction pooler        | Not used in the Supabase run.                                                                                                                                            | Failed on 6543 and fell back to polling; worked on 5432.                                                                             |
| Operator view                                     | Free `@pg-boss/dashboard` ran and listed the queues.                                                                                                                     | SQL on the `dbos` schema only. The UI and MCP server are part of the paid Conductor.                                                 |

Three results deserve plain statements.

- **DBOS has a pool floor.** It keeps an advisory-lock transaction open with a 5-second idle-in-transaction timeout. With `systemDatabasePoolSize: 2` that connection was starved, Postgres killed it, and the process crashed on both poolers. With the default pool of 10 it was stable. The true minimum between 2 and 10 was not measured. This rules DBOS out inside a Netlify function (`PG_POOL_MAX=1`, enforced in `lib/prisma.ts`) and means it needs its own pool on a long-lived host.
- **Both need idempotent handlers.** pg-boss reruns the whole job after a crash and can fire a duplicate cron job in its first minute. DBOS narrows the window by checkpointing each step, but a step that crashes between its side effect and its checkpoint still repeats.
- **Version pinning matters for DBOS.** A worker on a non-latest application version stopped dequeuing client-enqueued work until a stray version row was removed. Pin `DBOS__APPVERSION` in deploys.

## 3. The evidence in one table

The table lists the measured facts and the source report of each, so that a reader can find the log behind a claim.

| Fact                                                                                   | Measured by                           | Source report                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| A 26 s edge 504 fails a 40 s Inngest step on every retry; the side effect runs 3 times | Inngest dev server behind a 504 proxy | [inngest-on-serverless](./experiments/2026-10-31-job-runtime/inngest-on-serverless.md) |
| `maxRuntime` splits step sequences (7 requests at 10 s, 5 at 20 s)                     | Same                                  | Same                                                                                   |
| Trigger.dev round trip to the Mumbai pooler: 125, 185, 232 ms by region                | Real Trigger.dev Cloud runs           | [trigger-dev-latency](./experiments/2026-10-31-job-runtime/trigger-dev-latency.md)     |
| No Asian Trigger.dev region accepted                                                   | Same                                  | Same                                                                                   |
| pg-boss and DBOS enqueue transactionally and work through the Supabase poolers         | Local plus Supabase Mumbai            | [pg-boss-vs-dbos](./experiments/2026-10-31-job-runtime/pg-boss-vs-dbos.md)             |
| DBOS pool 2 crashes; pool 10 is stable                                                 | Supabase Mumbai                       | Same                                                                                   |
| pg-boss first-minute duplicate cron job, 2 of 2 runs                                   | Supabase Mumbai                       | Same                                                                                   |
| Crash recovery: DBOS about 3 s with one side effect; pg-boss about 65 s with two       | Local                                 | Same                                                                                   |
| Lock-hold and interference on shared rows                                              | **Pending**                           | To be added                                                                            |
| Static IP included in which Trigger.dev plan                                           | **Pending**                           | To be added                                                                            |

Latency numbers measured from a laptop in India are best-case and not representative of any production host. Only the Trigger.dev rows were measured from real cloud regions.

## 4. Questions the owner asked

### 4.1 Does running jobs on an external machine make a Postgres transaction distributed?

No. A transaction opened by a worker in Frankfurt is still one ACID transaction on one database, and the database enforces it exactly as before: `ledger_txn_balanced`, `payment_legs_sum_to_amount` and `occurrence_no_confirmed_overlap` (all in `prisma/sql/`) are checked at commit regardless of where the client sits. A distributed transaction would need two databases or two resource managers, and none of these options adds one.

What changes is how long the transaction stays open. Every statement waits for a network round trip, so row locks and Serializable snapshots (`withSerializableRetry` in `lib/db/serializable-retry.ts`) are held for longer, and a user request that needs the same rows waits longer or hits a retry. This is arithmetic from the measured round trips, not a measurement of contention:

| Where the transaction runs                 |   Round trip | Eight-statement transaction holds its locks for at least |
| ------------------------------------------ | -----------: | -------------------------------------------------------: |
| Mumbai host, as the scale-path ADR expects | about 1–2 ms |                                            about 8–16 ms |
| Netlify Singapore, today                   |  about 95 ms |                                             about 760 ms |
| Trigger.dev `eu-central-1`                 | about 125 ms |                                           about 1,000 ms |
| Trigger.dev `us-east-1`                    | about 185 ms |                                           about 1,480 ms |
| Trigger.dev `us-west-2`                    | about 232 ms |                                           about 1,856 ms |

**Pending (lock-hold and interference measurement):** the separate experiment will measure how much a held lock delays a competing request on the same row. Until it lands, treat the last column as a lower bound on lock duration, not as a measured delay.

### 4.2 Where does the dual-write risk come from?

It comes from the vendor and its trigger, not from the location. A dual write happens when we commit to the database and then tell a separate system to start the job, as two steps that can fail apart.

**Example.** Priya Anderson cancels Hannah Anderson's 1-hour consultation on Mon 2 Nov 2026 at 10:00 IST and is owed ₹590 (59,000 paise). The cancel route commits the cancellation and stamps a refund-owed marker on the payment (`Payment.refundOwedPaise`, `lib/payments/operations/refund-owed.ts`). Suppose the next line is a call such as `inngest.send()` or `tasks.trigger()` and the network drops. The booking is cancelled and committed, but no hosted engine knows a refund is owed. The vendor now holds half the truth.

There are two fixes, and the repo already has one of them.

- **State as the outbox.** The marker row is the outbox: the job reads database state, so a missed trigger costs nothing. `retry-auto-refunds` (registered in `lib/cron/cleanup-registry.ts`) finishes any marker the process died on. A hosted engine can be added behind this pattern by relaying marker rows afterwards, and the database remains the source of truth.
- **In-database enqueue.** pg-boss and DBOS write the job in the same transaction as the business change, which the experiment proved (rollback leaves no job).

A cron-triggered sweep that reads database state has no enqueue dual write at all, which is why the ticker is safe today.

### 4.3 Do vendor side effects become exactly-once on a better runtime?

No. Razorpay and Stream calls stay at-least-once on every runtime in this page: the Inngest experiment repeated a side effect on a retry, pg-boss reran a whole job after a crash, and even DBOS can repeat a step that crashed between its effect and its checkpoint. What makes them safe is unchanged: gateway idempotency keys, compare-and-swap status writes (`updateMany` with the expected prior status in `WHERE`), and the reconcilers that compare our state with the vendor's.

### 4.4 Can RazorpayX static egress be solved on Netlify?

Yes, and it already is. Live RazorpayX answers only allowlisted IP addresses and Netlify has no static egress address. The earlier finance decision (F1) routes the RazorpayX client alone through a static-IP HTTP proxy, set by `RAZORPAYX_EGRESS_PROXY_URL`. The client refuses live calls without it, with `RAZORPAYX_EGRESS_NOT_CONFIGURED` (`apiRequest` in `lib/payments/payouts/razorpay-payouts.ts`; see [RazorpayX](../finance/40-payouts/04-razorpayx.md)). So the question for any new runtime is cost and added latency, not possibility. The cost and the extra hop of that proxy are not recorded in the repo and were not measured; issue #2484 estimates the proxy at about $20 to $30 a month, which it marks unverified. A runtime with its own static address (a Lightsail VM in Mumbai, or a paid Trigger.dev tier if confirmed) could replace the proxy, but only for the code that runs there.

## 5. How the experiments bear on the existing decisions

This section reads the evidence against the decisions without changing them.

| Decision                                                          | Effect of the evidence                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision 1: keep the ticker through launch                        | Strengthened. Every alternative either leaves the compute on the same host (Inngest) or moves it farther from the database (Trigger.dev).                                                                                                                                                                                                                                                   |
| Decision 2: trial Vercel `bom1` before about 300 users            | Not tested. Nothing here ran on Vercel. The evidence only shows that compute in Mumbai is the one thing that removes the per-statement cost.                                                                                                                                                                                                                                                |
| Decision 3: no hosted job service, because none fixes the latency | Strengthened, with one wording correction. The ADR says these services call back into our functions. That is true of Inngest and QStash, but Trigger.dev runs the code on its own machines. The conclusion holds: its nearest region is slower than Singapore.                                                                                                                              |
| Decision 4: a hand-written Prisma `Job` table with `SKIP LOCKED`  | Neither weakened nor replaced. pg-boss and DBOS work through the poolers, but pg-boss keeps its own schema outside Prisma and DBOS needs its own pool and system tables, which is the reason the ADR gave. The experiment lists what a hand-written queue must still provide: reclaiming a crashed claim quickly, a global concurrency limit, and handlers that tolerate a duplicate start. |
| Issue #2484: one always-on Lightsail VM in Mumbai at $24 a month  | Compatible. The libraries and Inngest Connect all need a long-lived process, which a VM gives. The ticker ADR rejected the $100 to $440 container plan on cost, not a $24 VM, so whether the VM is in scope is an open question for the owner (see the evidence record).                                                                                                                    |

## 6. Where in code

| Concern                                  | Location                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| The ticker and its target cap            | `netlify/functions/cron-tick.mts`, `MAX_TARGETS_PER_TICK` in `lib/cron/schedule.ts` |
| One implementation per job               | `lib/cron/cleanup-registry.ts`                                                      |
| Job lease in Postgres                    | `withCronLock` in `lib/cron/with-cron-lock.ts`                                      |
| Single-connection pool on Netlify        | `PG_POOL_MAX` handling in `lib/prisma.ts`                                           |
| Serializable retry                       | `withSerializableRetry` in `lib/db/serializable-retry.ts`                           |
| Refund-owed marker (state as the outbox) | `lib/payments/operations/refund-owed.ts`, the `retry-auto-refunds` job              |
| RazorpayX static egress                  | `apiRequest` in `lib/payments/payouts/razorpay-payouts.ts`                          |

## Related issues

#2472 (scale-path research), #2484 (runtime review), #2485 (side-by-side runtime picture), #2466 (ticker and Sentry readiness).

## Deprecated & Superseded Approaches

- **Hosted-engine triggers as a second scheduler.** An earlier plan in the scaling roadmap listed QStash, Inngest and Trigger.dev as ways to queue webhook work. Adopting one beside the ticker would break the one-scheduler rule and, as the dual-write section shows, add a commit-then-call gap. The roadmap's queue section is superseded by the Prisma `Job` table decision.
- **Cron by GitHub Actions.** The Actions-based cron fleet that the roadmap describes was deleted when the minutes budget ran out. Jobs run on the ticker.
