# ADR: Architecture at scale: keep the domain, change the runtime

- **Status**: Proposed. This is a principal-architect review written for the owner on 2026-10-30. Nothing here is accepted until the owner records a decision for each numbered proposal. The tracking issue is #2466.
- **Status update (2026-10-31)**: The owner's decisions are recorded in [Ticker through launch, the scale path, the phase 2 queue and the database plan](2026-10-31-ticker-scale-path-and-queue.md). Phase 1's container option (web plus worker in a Mumbai container) is **superseded** by a Vercel Pro `bom1` trial with Netlify as hot standby. The phase 2 queue is a hand-written Prisma `Job` table. The database split moves to after launch.
- **Date**: 2026-10-30
- **Author**: Platform engineering
- **Related**: [Launch sweep decisions (ADR-01 to ADR-13)](2026-10-26-launch-sweep-observability-and-money-holds.md), [Job machinery catalog](../maintenance/11-job-machinery-catalog.md), [Deployment and pooling](../deployment/README.md), [Observability system design](../observability/00-system-design.md), issues #2460 (runtime assumptions), #2466 (ticker and Sentry readiness), #2424 (operations console), #2095 (Mumbai worker)

## Context: what the system is today, measured

- **Web tier.** Next.js 15 (App Router) on Netlify. Each request runs in a short-lived function instance. Middleware runs as a Netlify edge function.
- **Database.** One Supabase Postgres project in Mumbai (`ap-south-1`), on the Free plan. Production, previews and dev all use it. The app reaches it through the Supavisor pooler, with `PG_POOL_MAX=1` per function instance. Each statement costs about 95 ms of round trip from the function region to the database. A request's latency is therefore roughly 95 ms times its statement count.
- **Background work.** 76 registered jobs (`lib/cron/cleanup-registry.ts`):
  - 60 run from a 5-minute Netlify scheduled function that calls each due job over HTTP, at most 10 in parallel per tick;
  - 5 run in background functions;
  - 11 are scheduled nowhere today (#2466).
  - Each run is a bounded slice: a `?limit=`, a 16-second deadline, a saved cursor, and a 90-second Postgres lease on Netlify.
- **Correctness.** Correctness is enforced by the database, not by job ordering:
  - one Postgres lease per job;
  - compare-and-swap status transitions (`updateMany` with the expected prior status);
  - Serializable transactions with retry for multi-row rules;
  - CHECK constraints and constraint triggers for money (`ledger_txn_balanced`, `payment_legs_sum_to_amount`, `occurrence_no_confirmed_overlap`);
  - idempotency keys on every gateway call.
- **Measured health (2026-10-30).**
  - 446 ticks in 36 hours had 3 target failures, a p50 of 6.1 s and a maximum of 18.5 s against the 30-second limit.
  - The ticker uses nearly all of its 288 × 10 daily dispatch slots.
  - The first limit expected to break under user load is the database path, at roughly 300 to 500 concurrent active users. The reasons are the 200 pooler clients, one connection per instance and per-statement round trips.

## What is right and must be kept

1. **The domain model and its invariants.**
   - The money ledger has database-enforced balance.
   - Statuses move by compare-and-swap.
   - There is one confirmation path for gateway captures.
   - Refunds and payouts have owed markers and dead letters.

   This is the hard-won part of the system. A rewrite would lose it, and nothing about scale requires replacing it.

2. **Jobs as bounded, resumable slices with a lease.** This is the correct shape at any scale. Only the thing that runs the slices needs to change.
3. **One implementation per job, in one registry.** It stays the unit of work whatever runs it.
4. **Postgres as the system of record and the queue.** At this product's shape (bookings, payments, payouts, a few thousand state changes a minute even at hundreds of thousands of users), one well-sized Postgres with a read replica is enough. Kafka, a separate queue broker and microservices would add failure modes without removing a bottleneck.
5. **Three observability layers.** Sentry tells us what failed in the system, Better Stack what did not run, and the operations console what happened to a customer's item.

## What is wrong, ranked by how much it hurts at scale

1. **Compute is not where the data is, and it cannot pool.**
   - Every statement crosses regions (about 95 ms).
   - Each serverless instance holds one connection, so concurrency is bounded by pooler clients, not CPU.
   - Cold boots stall for 28 to 32 seconds (see the deployment skill).

   This one fact explains most slow pages, most timeouts and the 300 to 500 user ceiling. No code change inside the current topology removes it.

2. **The job runner is an HTTP fan-out on a 5-minute timer.**
   - It works today, but it polls instead of reacting, retries only at the next tick, cannot prioritise, and has no headroom (10 slots per tick, nearly full).
   - Every job pays a function cold start and a pooler client.
   - Many of the 76 jobs are repair sweeps for states that an event-driven design would not leave behind.
3. **One database for production, previews and dev.** A preview can write production data, use up invoice numbers (seen) or take production job locks, and no load test is safe.
4. **No running CI.** The GitHub Actions budget is exhausted, so no workflow runs: no live-schema check, no full test suite, no scheduled maintenance jobs. Releases are gated by agents and previews only. This is the largest process risk.
5. **Two hosting platforms kept bootable on every commit (the dual-boot rule).** It costs every change, and it caused the build-time versus runtime environment bugs found on 2026-10-30. That makes sense once a second platform is actually live. Before launch it is insurance paid in velocity.
6. **Volume of change per release.** One release carried 476 changed files. Releases of that size cannot be reviewed by a person, so they rely entirely on automated checks, and the CI that should run those checks is not running.

## Target architecture for hundreds of thousands of users

```
            CDN / edge (static, ISR, middleware: auth gate, client IP, rate limit)
                                   │
          ┌────────────────────────┴────────────────────────┐
   Web tier: Next.js server                       Worker tier: one always-on Node
   (container or Fluid compute,                   process (same repo, same registry)
    in Mumbai, min instances ≥ 1,                 ├─ Postgres-backed queue (SKIP LOCKED):
    pool 10–20 per instance)                      │   event-driven jobs, retries with
          │                                       │   backoff, dedupe keys, dead letters
          │                                       └─ scheduler for the remaining sweeps
          └────────────── Supavisor (transaction mode) ─┘
                                   │
               Postgres primary (Mumbai, Pro, sized compute)
                    + read replica for dashboards and exports
               Separate projects: production / staging / preview branches
```

- **Co-locate compute with the database in Mumbai.** Use an always-on container with a real connection pool: the planned Mumbai host (#2095), or a container platform with an Indian region. Per-statement cost drops from about 95 ms to about 1 ms, the pooler ceiling becomes per process instead of per request, and cold boots disappear.
- **Replace the HTTP ticker with a Postgres-backed job queue inside the worker.**
  - Domain code enqueues a job when a state changes, for example "refund owed": one row in the same transaction as the change.
  - The worker claims jobs with `SELECT … FOR UPDATE SKIP LOCKED`, retries with backoff, de-duplicates by key, and dead-letters after N attempts.
  - The existing sweeps stay as low-frequency safety nets and reconcilers, not as the main engine.
  - Libraries such as pg-boss or graphile-worker implement this pattern. The repo's own outbox tables already do it by hand.
  - This keeps AGENTS.md rule 4 (one scheduler): the queue replaces the ticker instead of running beside it.
- **Make state machines explicit.** For each aggregate (Payment, Appointment, Refund, Payout, Invoice, Dispute), one module owns the transition table of which writer may move which status, from what, to what. A source-scan test rejects any status write outside that module or without compare-and-swap. This is what keeps 76, or 200, jobs from tangling shared state (#2466, the state ownership matrix).
- **Database operations.**
  - Supabase Pro with sized compute, and a read replica for the back-office and exports.
  - Versioned migrations (`prisma migrate`) with a drift gate in CI, instead of `db push`.
  - Time-partitioned or pruned high-volume tables: job runs, system events, webhooks, outboxes.
  - A statement budget per route; the open N+1 performance issues are the first targets.
- **Environments.** Production, staging and preview databases, with preview branches seeded from fixtures. Load tests run against staging.
- **CI.** Fund the GitHub Actions budget with a hard cap, or use a self-hosted runner. Typecheck, lint, the full test suite, the drift gate and a smoke test run on every PR. CI comes before any other investment in this list.
- **Observability.** Sentry stays for errors only, with the escalations-only policy. Traces use OpenTelemetry where cheap. The operations console is the place for "what happened to this customer's item".

## Migration path: incremental, never a rewrite

| Phase                | Change                                                                                                                                                                                                                   | Why first                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 0, before launch     | Run CI. Move Supabase to Pro before real customers. Split the preview/dev database. Ticker fixes from #2466 (the stranded jobs, background failure handling, escalations-only Sentry). Write the state ownership matrix. | Safety and truth, with no topology change.                                     |
| 1, first months live | Move the web tier and a worker process to Mumbai, next to the database (#2095). Keep Netlify as CDN and as the documented failback, not as a second fully maintained platform.                                           | Removes the cross-region latency, the pool ceiling and cold boots.             |
| 2                    | Add the Postgres-backed queue in the worker. Move the money and recovery jobs from timed sweeps to enqueue-on-change, keeping the sweeps as hourly or daily safety nets. Retire the HTTP ticker.                         | Reaction in seconds instead of up to 5 minutes; real retries; no slot ceiling. |
| 3                    | Consolidate the 76 jobs into a handful of domain workers (payments, payouts, booking, communications, compliance, retention) with internal steps. Add a read replica.                                                    | Fewer moving parts, and clear ownership.                                       |

## Alternatives considered

- **A full rewrite or reconstruction.** Rejected. The domain rules and invariants are correct and expensive to rediscover. The problems are in runtime topology and process, which can be changed under the existing code.
- **Moving to Vercel.** On its own, this does not fix the core problem: it is still per-request serverless. Two Vercel features would close most of the gap: Fluid compute, where instances serve concurrent requests and can pool, and a Mumbai function region. A long-running worker is still needed for jobs. It is a reasonable "least change" path for the web tier, but the same result comes from a container in Mumbai, which also hosts the worker. Choose by cost and team familiarity, not by brand.
- **Microservices, Kubernetes or a separate message broker.** Rejected at this scale. One Postgres-backed queue and one worker process cover the throughput with far less operational load.
- **QStash or Upstash Workflow, or pg_cron with pg_net.** Each adds a second scheduler (AGENTS.md rule 4) and leaves the database path unchanged. A Postgres queue inside the worker gives the same retries without a new vendor.
- **Keep everything as is and only raise limits.** That works for launch traffic, which is why phase 0 is enough to launch. It does not reach hundreds of thousands of users, because the per-statement round trip and the one-connection-per-instance design cap concurrency.

## Decisions for the owner

1. Fund CI now: either an Actions budget with a hard cap, or a self-hosted runner.
2. The Supabase plan and the database split timing, already decided on 2026-10-30: Free while the data is mock, Pro plus Micro before real customers, and the split before launch.
3. Whether phase 1 (co-locate in Mumbai) happens before launch or in the first months live, and on which platform: a container host with an Indian region, or Vercel Fluid in Mumbai plus a worker.
4. Whether to relax the dual-boot rule to "Netlify is CDN plus documented failback" once phase 1 lands.
5. Adopting a Postgres-backed queue (phase 2) as the replacement for the HTTP ticker.

## Deprecated & Superseded Approaches

- **The 5-minute HTTP fan-out ticker as the only job engine.** This is proposed to become a safety-net scheduler inside a worker in phase 2. Until then it stays authoritative (AGENTS.md rule 4).
- **One database for every environment.** The 2026-10-30 decision to split before launch was itself reversed on 2026-10-31: the split now follows launch (see the 2026-10-31 record).
- **Phase 1 as a Mumbai container for web and worker.** Superseded on cost by the 2026-10-31 record's Vercel `bom1` trial.
