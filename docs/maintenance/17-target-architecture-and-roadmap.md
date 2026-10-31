---
title: Target architecture and roadmap for the jobs subsystem
type: explanation
---

# Target architecture and roadmap for the jobs subsystem

This page opens with an executive summary of the problems, the experiments and the contenders, then describes a greenfield target design and the reversible path from today to it. The target design is a **proposal, not a decision**. The decision stays as the owner recorded it in [the evidence and decision record](../decisions/2026-10-31-job-runtime-experiments.md): launch on the Netlify ticker plus Background Functions, then choose between Vercel `bom1` with Workflows and a Mumbai VM with DBOS after two tests. Labels follow [page 14](./14-background-job-runtime-options.md): MEASURED, DOCS, ESTIMATE and UNVERIFIED. Anything described as planned does not exist in the repository yet.

## 1. Executive summary

### 1.1 Today

About 76 jobs run from one Netlify Scheduled Function, `netlify/functions/cron-tick.mts`. Every five minutes it POSTs the due jobs, at most 12 per tick (`MAX_TARGETS_PER_TICK` in `lib/cron/schedule.ts`). Most land on Netlify functions in Singapore, and six land on Netlify Background Functions. Correctness comes from four things: state as the outbox, `withCronLock` leases (one run per job name, `lib/cron/with-cron-lock.ts`), compare-and-swap status writes, and the Postgres constraints and triggers in `prisma/sql/`.

### 1.2 The problems, in order of impact

1. **Distance to the database (MEASURED).** 62–64 ms per statement from Singapore to Mumbai, and about 700 ms of row-lock hold for a ten-statement transaction.
2. **One database connection per function.** The database path saturates at about 300–500 concurrent users (issue #2466).
3. **Ticker capacity.** At most 12 jobs per tick with hand-packed offsets, backed by about 2,000 lines of slicing and packing machinery ([page 16](./16-job-machinery-and-portability.md)).
4. **Time limits.** Roughly 26–30 s for synchronous functions. Few jobs are long: typical p50 durations are 79–490 ms and the worst tick took 18.5 s.
5. **RazorpayX needs a static IP**, which today means the F1 egress proxy (`RAZORPAYX_EGRESS_PROXY_URL`).

### 1.3 What the experiments found

Fourteen setups were deployed and measured against the Mumbai database ([experiment index](./experiments/2026-10-31-job-runtime/README.md)). The findings that hold for every candidate:

- No trigger is transactional with Postgres, so an outbox is always needed.
- Every engine ran some side effect more than once (2 to 29 times).
- A transaction never becomes distributed because the code runs elsewhere. It only holds locks longer.
- Engines that call back into Netlify change who decides when a job runs, not where it runs.

### 1.4 The contenders

The table lists each contender with its measured database cost and the reason for and against it.

| Option                                           | DB per statement                    | Why                                                                         | Why not                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Netlify ticker plus Background Functions (today) | 62–64 ms (MEASURED)                 | Correct, no migration                                                       | Slow database path, a pool of one, heavy machinery                                                                                                                 |
| Vercel `bom1` plus Workflows                     | 1–2 ms, Workflows 2–3 ms (MEASURED) | About 40 times faster database path, managed, completed steps do not re-run | The real app did not run on Vercel without code changes; a static IP costs $100 a month or needs the proxy; cost at about 1,000 users is highly uncertain; lock-in |
| Mumbai VM plus DBOS                              | about 1–3 ms (ESTIMATE)             | Cheapest, free static IP, transactional enqueue, step recovery              | We run the server; the Lightsail probe is blocked on the owner's AWS login                                                                                         |
| Cloudflare pinned plus Hyperdrive                | 4 ms (MEASURED)                     | Fast `fetch` handlers                                                       | Queues, cron and Workflows ignore placement; certificate-verified TLS only through Hyperdrive                                                                      |
| Restate Cloud (EU)                               | 348 ms end to end (MEASURED)        | Good step semantics                                                         | US and EU regions only                                                                                                                                             |
| Inngest, QStash, Upstash Workflow, Trigger.dev   | 62–125 ms (MEASURED)                | UIs and retries                                                             | The same latency or worse                                                                                                                                          |
| Async Workloads                                  | 63 ms (MEASURED)                    | Native to Netlify                                                           | Ruled out: steps ran up to 29 times and delays landed about 70 s late                                                                                              |

## 2. The target design (proposal)

### 2.1 Principles

The evidence points to four principles: put compute next to the database in Mumbai, keep correctness in Postgres, enqueue in the database in the same transaction as the business write, and run one long-lived worker with no 30-second slicing.

### 2.2 The picture

```text
                        ap-south-1 (Mumbai): everything next to the data
 ┌───────────────────────────────────────────────────────────────────────────┐
 │   Web tier (Next.js)                     Worker (1 long-lived process,    │
 │   Vercel bom1  -or-  container           2 replicas for failover)         │
 │   - Fluid compute, pooled conns          - DBOS (or pg-boss) runtime      │
 │   - 1-2 ms per SQL statement             - cron schedules (DB-deduped)    │
 │   - a user request writes the row        - queues with GLOBAL limits      │
 │     AND enqueues the job in the          - durable steps (no re-run)      │
 │     SAME transaction                     - no time limit, no slicing      │
 │                                   |                                       │
 │                                   v      claims with SKIP LOCKED          │
 │                        ┌──────────────────────────┐                       │
 │                        │  Supabase Postgres       │                       │
 │                        │  - business tables       │                       │
 │                        │  - job and workflow tables│  <- the queue IS the DB│
 │                        │  - CAS, CHECKs, ledger   │                       │
 │                        │    triggers, uniques     │  <- correctness lives │
 │                        └──────────────────────────┘     here, unchanged   │
 │   Static egress IP (VM IP or NAT) --> RazorpayX allowlist (no proxy)      │
 └───────────────────────────────────────────────────────────────────────────┘
        | heartbeat on every run             | errors (escalations only)
        v                                    v
   Better Stack (uptime, heartbeat,     Sentry (what broke)
   on-call, status page)
```

### 2.3 The same design as an HLD

The flowchart shows the components and what flows between them.

```mermaid
flowchart LR
  subgraph MUM["Mumbai, ap-south-1"]
    WEB["Web tier: Next.js on Vercel bom1 or a container"]
    WK["Worker, 2 replicas: DBOS or pg-boss runtime, cron, queues, durable steps"]
    PG[("Supabase Postgres: business tables, job tables, CAS, CHECKs, triggers")]
    EG["Static egress IP"]
  end
  USR["User request"] --> WEB
  WEB -->|"one transaction: business write + enqueue"| PG
  WK -->|"claim with SKIP LOCKED, run steps, record outcome"| PG
  WK --> EG
  EG --> RZX["RazorpayX allowlist"]
  WK -->|"heartbeat each run"| BS["Better Stack"]
  WEB -->|"errors"| SE["Sentry"]
  WK -->|"errors"| SE
```

### 2.4 The request-to-heartbeat sequence

The diagram shows the flow in the proposal: a user request writes the row and enqueues the job in one transaction, a worker claims it, runs durable steps and sends a heartbeat. The measured basis is in [page 14](./14-background-job-runtime-options.md): transactional enqueue (rollback leaves no job), a crash recovery of about 3 s for DBOS, and no step re-run.

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web tier (bom1)
  participant PG as Postgres (Mumbai)
  participant K as Worker
  participant BS as Better Stack
  U->>W: request
  W->>PG: BEGIN, write business row, enqueue job, COMMIT
  W-->>U: response (the job exists if and only if the row exists)
  K->>PG: claim with SKIP LOCKED
  loop durable steps
    K->>PG: run step, checkpoint its output
    Note over K,PG: a crash resumes at the first unfinished step, about 3 s (DBOS, MEASURED)
  end
  K->>PG: record outcome (CAS to DONE)
  K->>BS: heartbeat
```

### 2.5 Components: today and from scratch

The table compares each concern today and in the proposal, with the reason.

| Concern                | Today                                                         | From scratch                                                                        | Why                                                                                                  |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Where code runs        | Netlify Singapore                                             | Mumbai, next to the database                                                        | 62 ms against 1–3 ms per statement; about 700 ms against about 20 ms lock hold (ESTIMATE for the VM) |
| Job runtime            | Serverless, sliced under 30 s                                 | One long-lived worker with 2 replicas                                               | Deletes about 1,500–2,000 lines of machinery (ESTIMATE)                                              |
| Queue                  | Business rows polled by sweeps                                | A Postgres-native queue (DBOS or pg-boss)                                           | Transactional enqueue (MEASURED)                                                                     |
| Time-based work        | 15-minute polls                                               | Delayed jobs created with the row, plus a slow backstop sweep                       | On time; 99.8 percent of runs today find nothing to do                                               |
| Vendor reconcilers     | Ticker targets                                                | Cron jobs in the worker                                                             | They must poll the vendor                                                                            |
| Scheduler              | Netlify Scheduled Function, HTTP fan-out and the fleet switch | The worker's own cron, deduplicated by the database                                 | One scheduler, no fan-out                                                                            |
| Multi-step money flows | Hand-written state and reconcilers                            | DBOS durable steps                                                                  | About 3 s resume with no step re-run (MEASURED)                                                      |
| Correctness            | CAS, leases, constraints, triggers                            | The same                                                                            | It works                                                                                             |
| Static IP              | F1 proxy                                                      | The worker's own IP                                                                 | Free on a VM (DOCS)                                                                                  |
| Observability          | Run rows, Sentry, Better Stack and the console                | The same, plus a per-item run log and oldest-pending-age alerts                     | Starvation (issue #2492)                                                                             |
| Environments           | One database for production, dev and previews                 | A separate database for preview and dev                                             | Safe experiments                                                                                     |
| Failover               | Netlify hot standby and a DNS flip                            | 2 worker replicas (a database lease elects the cron leader) plus a managed web tier | Simpler                                                                                              |

### 2.6 Deleted and kept

- **Deleted in the proposal:** the HTTP fan-out ticker, the packing in `lib/cron/schedule.ts`, the `run-deadline` slicing, the background adapters, the fleet switch (`ops:active_cron_platform`), the `PG_POOL_MAX=1` workarounds and the egress proxy.
- **Kept:** the registry (`lib/cron/cleanup-registry.ts`), leases (which become leader election), compare-and-swap writes, the ledger triggers and constraints in `prisma/sql/`, idempotency keys and run records.

### 2.7 Concrete choices, costs and trade-offs

- **Worker:** a Lightsail VM in Mumbai ($12–24 a month, static IP included, no SLA) or ECS/Fargate in `ap-south-1`. See [Mumbai VM provider research](../infrastructure/05-mumbai-vm-provider-research.md).
- **Engine:** DBOS, with pg-boss as the fallback. Both need the caveats on page 14 (a DBOS pool floor, pg-boss `supervise()` in drain mode).
- **Web:** Vercel `bom1` after a spike, or the same image on the worker host. The real-app attempt shows the Vercel move needs code and build changes.
- **Cost:** about $60–90 a month at launch (ESTIMATE).
- **Trade-offs:** you run a server (about 1–2 hours a month, ESTIMATE), DBOS brings mild lock-in (it is an open-source library), and the migration is about 5–7 days plus a web spike (ESTIMATE). It should not happen before launch.

## 3. The path from today

Every step is reversible, and correctness never leaves Postgres. The flowchart shows the order.

```mermaid
flowchart LR
  A["1. Launch on the ticker plus the skip-idle PR"] --> B["2. Issue #2491: a portable runJob and thin triggers (planned)"]
  B --> C["3. Mumbai VM probe (needs the owner's AWS login)"]
  C --> D["4. Move jobs to a Mumbai DBOS worker first"]
  D --> E["5. Move the web tier after a spike"]
  A -.->|"reversible"| A
  D -.->|"fail back to the ticker"| A
```

## 4. Netlify billing: status only

The skip-idle pull request (`perf/ticker-skip-idle-targets`) writes the billing details into `docs/deployment/netlify.md` and the billing-guardrails skill, so this page does not duplicate them. The decision status as of 2026-11-01 is this. Moving to the credit-based Pro plan is PENDING Netlify support's confirmation of region pinning and Background Functions on that plan; an email was drafted on 2026-11-01. Removing the second (Developer) seat is pending the owner's yes. The figures behind both are UNVERIFIED here and land with the skip-idle PR.

## 5. Where in code

| Concern                  | Location                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| The ticker and its cap   | `netlify/functions/cron-tick.mts`, `MAX_TARGETS_PER_TICK` in `lib/cron/schedule.ts`                          |
| The registry             | `lib/cron/cleanup-registry.ts`                                                                               |
| Lease                    | `withCronLock` in `lib/cron/with-cron-lock.ts`                                                               |
| Constraints and triggers | `prisma/sql/ledger-triggers.sql`, `prisma/sql/payment-legs-triggers.sql`, `prisma/sql/check-constraints.sql` |

## Deprecated & Superseded Approaches

- **Framing hosted vendors as job engines only.** Early comparisons treated QStash, Inngest and Trigger.dev as engines that run the jobs. As a clock they are viable ([page 14, section 9.7](./14-background-job-runtime-options.md)); as engines they lose on latency and complexity.
