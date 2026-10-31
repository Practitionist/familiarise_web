---
title: "Queue prototype on owed refunds: pg-boss against a hand-written Prisma Job table"
type: explanation
---

# Queue prototype on owed refunds: pg-boss against a hand-written Prisma Job table

This page was moved from a GitHub issue into the docs on 2026-10-31. It is research evidence, not a decision. The owner decisions are in [Ticker through launch, the scale path, the phase 2 queue and the database plan](../decisions/2026-10-31-ticker-scale-path-and-queue.md) and in the [architecture at scale review](../decisions/2026-10-30-architecture-at-scale-review.md); where this page disagrees with them, they win. The labels VERIFIED (read on a primary source), UNVERIFIED (no primary source was read) and ESTIMATE (arithmetic from stated assumptions) are kept from the source.

**Measurement note (added 2026-10-31).** Every "95 ms per statement" on this page is the figure in the ticker decision record, measured through the app earlier. A later probe with raw `pg` from Netlify Singapore measured 62–64 ms, and Prisma's own per-statement overhead measured below noise in `bom1`, so the gap is unexplained and should not be attributed to Prisma. A Vercel `bom1` function measured 1.0–2.1 ms. See [Background-job runtime options](../maintenance/14-background-job-runtime-options.md).

- **Status:** Comparison spike for issue #2466 ("a queue prototype on ONE job"). It is never merged. No DDL was applied, no `db push` or `prisma generate` was run, and the TypeScript was not compiled.
- **Context:** [Architecture at scale review](../decisions/2026-10-30-architecture-at-scale-review.md), phase 2. The queue lives in Postgres, not Redis. It needs the always-on worker from phase 1 (#2095). Until then the Netlify ticker stays the only engine (AGENTS.md rule 4).
- **Files:** `pg-boss/boss.ts`, `pg-boss/enqueue.ts`, `pg-boss/worker.ts`; `prisma-job/job-model.md`, `prisma-job/queue.ts`, `prisma-job/refund-owed.ts`.

## 1. The pilot job as it runs today

A booking door (cancel, rejection, moderation ban, maintenance freeze, no-show, trial cancel, seat leave, incident) ends a booking and stamps `Payment.refundOwedKey`, `refundOwedPaise`, `refundOwedReason`, `refundOwedAt` and `refundOwedAttempts = 0` in the same transaction (`stampRefundOwed` / `stampRefundsOwed` in `lib/payments/operations/refund-owed.ts`). After commit, the door drives the refund inline (`driveRefundOwed`) so that the user sees the outcome.

If the inline drive fails, the `retry-auto-refunds` registry target (`scripts/payments/retry-auto-refunds.ts`, every 15 minutes on the ticker, 10 rows per run) scans `Payment` for markers older than 15 minutes with fewer than 3 attempts. It orders them by fewest attempts and then oldest, and re-drives each one. `driveRefundOwed` counts each failure on the marker by CAS and pages an operator once at `MAX_REFUND_OWED_ATTEMPTS = 3`. Markers older than 2 hours are summarised as one `SystemEvent` per day.

This is already a queue in the state-as-outbox shape (ADR 27): `refundOwedKey @unique` is the idempotency key, `refundOwedAttempts` is the attempt counter, and the CHECK `payment_refund_owed_paise_positive` guards the amount. It lacks four things:

- a per-row next-attempt time, so a failing row is retried on every run until the cap (3 attempts in about 30 to 45 minutes) instead of backing off;
- a claim or lease, so concurrency is one run at a time under the `withCronLock` lease;
- reaction in seconds, because the target runs every 15 minutes behind a 15-minute grace;
- a dead-letter state separate from "the third failure", for a crashed or killed run.

The marker also has a second job that no queue replaces. It is the domain lock: a second door that finds it refuses with `REFUND_IN_PROGRESS` or `REFUND_NEEDS_SUPPORT` (`heldMarkerRefusal`). Both sketches therefore keep the marker and its attempt budget, and add a job row for delivery only.

## 2. Side by side

The table compares the two designs on each concern.

| Concern                                    | (a) pg-boss 12.38.0                                                                                                                                                                                                                                                                                                     | (b) Prisma `Job` + hand-written worker                                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code we own (non-blank, non-comment lines) | About 130: `boss.ts` 37, `enqueue.ts` 27, `worker.ts` 68                                                                                                                                                                                                                                                                | About 200: `queue.ts` 153 (generic), `refund-owed.ts` 48, plus a 40-line model and 10 lines of sidecar SQL                                                                                     |
| Code we depend on                          | About 18,500 lines of compiled JS (1.6 MB `dist`) from one maintainer. Requires Node ≥ 22.12 and Postgres ≥ 13.                                                                                                                                                                                                         | None beyond Prisma and Postgres                                                                                                                                                                |
| Schema                                     | Its own `pgboss` schema: the `job_state` enum, a `job` table partitioned by queue name, `queue`, `schedule`, `subscription`, `bam`, `warning`, `job_dependency`, `instance`, `queue_stats`, `version`, and plpgsql functions. Installed and migrated by pg-boss itself (on `start()` or through its CLI).               | One `Job` table and two enums in `prisma/schema.prisma`; three CHECKs and one partial index in `prisma/sql/`                                                                                   |
| Transactional enqueue                      | Supported natively. `send(name, data, { db: fromPrisma(tx) })`: the built-in Prisma adapter runs the insert through `tx.$queryRawUnsafe`, so the job commits or rolls back with the cancel. No outbox bridge is needed.                                                                                                 | `INSERT ... ON CONFLICT DO NOTHING` through `tx.$executeRaw` in the door's transaction                                                                                                         |
| Idempotency                                | A deterministic job `id` (`uuidv5(refundOwedKey)`). The insert skips a duplicate id and `send` resolves `null`. Alternatively, `singletonKey` with the `exclusive` policy (one queued-or-active job per key, through partial unique indexes `job_i1`..`job_i13`). Once retention deletes the row, the id can be reused. | `@@unique([kind, idempotencyKey])` for the row's lifetime                                                                                                                                      |
| Claim                                      | `SKIP LOCKED` fetch, polling every `pollingIntervalSeconds`                                                                                                                                                                                                                                                             | One `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` statement                                                                                                                            |
| Lease and visibility timeout               | `expireInSeconds` (default 900; the sketch uses 120), optional `heartbeatSeconds`                                                                                                                                                                                                                                       | `lockedUntil`. An expired lease is reclaimable; an expired lease with no attempts left goes `DEAD` inside the claim.                                                                           |
| Retry and backoff                          | `retryLimit` (default 2), `retryDelay`, `retryBackoff` (exponential with jitter), `retryDelayMax`                                                                                                                                                                                                                       | `attempts` is spent at claim; backoff is 1 minute × 2^n with jitter, capped at 6 hours; `later` waits without spending an attempt                                                              |
| Dead letter                                | `deadLetter: 'refund-owed-dead'`: the failed job is copied into a second queue that a second `work()` handler drains. `redrive()` and `retry()` re-run jobs.                                                                                                                                                            | `status = DEAD` on the same row, with `lastError`. One `SystemEvent` per dead row (`skipSentry`) and one Sentry event per run. Remediation is the audited refund door or a reset to `PENDING`. |
| Throttling and singletons                  | Six queue policies (`standard`, `short`, `singleton`, `stately`, `exclusive`, `key_strict_fifo`), `singletonSeconds`, group concurrency, priority, cron and RRULE schedules, flows                                                                                                                                      | None. The unique key covers this pilot.                                                                                                                                                        |
| Running on Netlify (standby, rule 2.5)     | `send` needs a started instance, which means `start()` plus a queue-cache read on each cold Lambda (about 2 × 95 ms) and a second pg pool beside Prisma's. `work()` needs a long-lived process. `fetch`/`complete` could be driven from a ticker route, but that path is hand-wiring anyway.                            | The same `drainJobs()` function runs as a registry target on the ticker today and inside the worker loop later. Failback needs no new code.                                                    |

## 3. Supabase pooler (Supavisor transaction mode, port 6543)

Supabase's documentation states that the shared pooler in transaction mode does not support prepared statements, and that session-level features are lost between transactions: "`set` and `reset`, session-level advisory locks, `listen` and `notify`, and temporary tables". Session mode (port 5432) and direct connections support all of these ([Supabase: connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)). The shared pooler is IPv4. A direct connection is IPv6 unless the IPv4 add-on is bought.

- **pg-boss (checked in the 12.38.0 source).**
  - `useListenNotify` defaults to `false`. With it on, `notifier.js` detects a broken listener ("PgBouncer transaction pooling"), emits a `listen_notify_unavailable` warning and falls back to polling.
  - The only advisory locks are `pg_advisory_xact_lock` / `pg_try_advisory_xact_lock` (`plans.js`), which are transaction-scoped and therefore work in transaction mode.
  - Queries go through node-pg with parameters and no `name`, so no named prepared statements are created.
  - Conclusion: pg-boss works through port 6543 with polling only. Its LISTEN/NOTIFY fast path needs session mode or a direct connection. On the Mumbai worker with a 5-connection pool, use session mode (5432); the latency hint is not needed at this volume.
- **graphile-worker 0.18.0 (the alternative).**
  - LISTEN/NOTIFY is on by default and runs on a dedicated listening client (`main.js` reconnects it on error). It needs a session-mode or direct connection.
  - It has a `noPreparedStatements` option for poolers.
  - Polling picks up retried and scheduled jobs anyway ([graphile-worker FAQ](https://worker.graphile.org/docs/faq)).
  - Enqueue is the SQL function `graphile_worker.add_job(...)`, which a Prisma `tx.$executeRaw` can call in the door's transaction. It supports `job_key` deduplication and `max_attempts` (default 25), with exponential backoff.
  - It owns a `graphile_worker` schema with about 20 versioned migrations.
- **Hand-written queue.** Every statement is a single parameterised statement in its own implicit transaction, with no LISTEN and no session lock, so it works through 6543. The ticker twin runs under `PG_POOL_MAX=1` with no transaction around the claim.

## 4. Observability: what the ops console (#2424, "Needs attention") reads

The console design (`docs/maintenance/11-job-machinery-catalog.md` §5.3) is a registry of owed-work sources. Each source declares a stuck-item query, a reason field, an age limit and a remediation door. The "Refunds owed" source already reads `Payment.refundOwed*`, and it keeps doing so under both options, because the marker stays.

- **(a) pg-boss.** The console reads a schema that Prisma does not model, so it needs raw SQL:
  - `SELECT ... FROM pgboss.job WHERE name = 'refund-owed-dead' AND state = 'created'` for dead letters;
  - `boss.getQueue('refund-owed')` for `readyCount`, `deferredCount`, `activeCount`, `failedCount` and `readyOldestSeconds` (the deltas need `persistQueueStats`).
  - The reason is in `output` (jsonb). Adding the payment to the entity trace means matching on `data->>'paymentId'`.
  - The `@pg-boss/dashboard` package exists, but it would be a second admin UI outside our RBAC and audit log.
- **(b) Prisma `Job`.** The console uses one typed Prisma query per source (`job.findMany({ where: { status: 'DEAD' } })` or `PENDING` with `runAt` older than the age limit). The reason is `lastError`, the attempts are `attempts / maxAttempts`, and `entityRef = payment:<id>` joins the entity trace. Queue depth and oldest age come from one `groupBy`. It slots into the registry like the other five sources.

## 5. Operational cost

- **Round trips per enqueue.** Both options add one insert to the door's transaction (about 95 ms from Netlify today, about 1 ms from Mumbai). pg-boss adds `start()` and a queue-cache read on each cold web instance, plus a second pg pool (1 client) beside Prisma's. On the 200-client Free pooler that halves the headroom that the review names as the first ceiling.
- **Worker idle cost.** pg-boss's worker runs supervise, maintenance, the monitor and the queue-cache refresh on intervals (seconds to minutes), plus one poll per queue every `pollingIntervalSeconds`. The hand-written worker runs one claim every 5 seconds when idle. Both are trivial on Pro compute.
- **Schema posture.** pg-boss migrates its own schema on `start()` unless `migrate: false`. With that set, its CLI becomes a second human-run DDL step beside `db:push` and the sidecars. Prisma does not use `multiSchema` here, so `db push` and `migrate diff` look only at `public` and leave `pgboss` alone (INFERRED from `prisma/schema.prisma` having no `schemas` list; this was not run). Every pg-boss upgrade can carry schema migrations that we do not review in `prisma/`. The hand-written table follows the existing rules exactly: schema in `schema.prisma`, CHECKs and the partial index in `prisma/sql/`, and a reminder that `db push` drops the partial index.
- **Upgrades and bus factor.** pg-boss is one maintainer, has had 12 majors, and 12.x requires Node ≥ 22.12. graphile-worker is still pre-1.0. The hand-written code is about 150 lines that we must test ourselves (lease expiry, the CAS on settle, the crash loop).

## 6. Migration path from the ticker sweep

Both options share the same shape. Option (b) can start before phase 1.

1. **Schema.** Add `Job` (b) or install `pgboss` (a) in the human-run push. Nothing reads them yet.
2. **Producers.** In each door, `stampRefundOwed(tx, …)` becomes `stampAndEnqueueRefundOwed(tx, …)` (and `stampRefundsOwed` gets a bulk insert). The inline drive after commit stays.
3. **Consumer.**
   - (b): register `drain-jobs` in `lib/cron/cleanup-registry.ts` on the existing ticker. This needs no new scheduler, so rule 4 holds.
   - (a): there is no consumer until the phase-1 worker exists.
4. **Safety net.** Cut `retry-auto-refunds`' owed cohort to hourly. Change it from "drive every marker" to "enqueue a job for any marker with no live job" (an `ON CONFLICT DO NOTHING` re-enqueue), so the sweep heals a missed enqueue and never drives twice. The auto-refund (`Auto-refund pending:`) cohort stays as it is until it gets its own pilot.
5. **Phase 1 lands.** The worker loop calls the same `drainJobs()` every 5 seconds and the ticker target is retired. The Netlify standby keeps the registry target, so failback still drains.
6. **Later.** Move other owed-work sources (recording copies, payout status, invoice healing) onto `Job` kinds one at a time, each with its sweep demoted to a safety net.

## 7. Recommendation

**Recommended: (b), the hand-written Prisma `Job` table, as the phase-2 queue.**

Its claim, lease, backoff and dead letter are about 150 lines we can read in one sitting. It lives under the schema and sidecar rules we already enforce, and the console reads it with typed Prisma queries. Most importantly, the same drain function runs on the Netlify ticker today and in the Mumbai worker later. That keeps rule 4 (one scheduler) and rule 2.5 (Netlify failback) without special cases. pg-boss's extra features (policies, cron, flows, group concurrency, priority) solve problems we do not have; rule 2 says not to buy them speculatively.

**Alternates, in order:**

1. **Do less: keep state-as-outbox for this job.** Add `refundOwedNextAt` to `Payment` and order the existing sweep by it with `FOR UPDATE SKIP LOCKED`. This gives backoff and parallel-safe claims with one column and no new table. It is the right call if refunds owed stays the only latency-sensitive source. The generic table only pays off from the second source onward.
2. **pg-boss**, if phase 2 grows to need cron or RRULE scheduling inside the worker, per-tenant group concurrency, or job flows. In that case, run it on a session-mode (5432) connection from the worker only, set `migrate: false`, apply its schema through the CLI as a reviewed step, and enqueue through `fromPrisma(tx)`.
3. **graphile-worker**, only if its SQL-first `add_job` matters, for example enqueueing from a Postgres trigger. Its LISTEN default needs session mode, and it is pre-1.0.

**Not recommended:** Redis or QStash. The owner has already decided against both: Redis pub/sub is fire-and-forget, Streams need an outbox anyway, and QStash is a second scheduler.

## Deprecated & Superseded Approaches

- **Retrying every tick until the cap.** The current `retry-auto-refunds` owed cohort re-drives a failing marker on each 15-minute run after the 15-minute grace, which spends all 3 attempts in about 30 to 45 minutes, so a gateway outage longer than that retires every marker to an operator. Under either option this is replaced by per-row backoff.
- **The drive-everything sweep.** It becomes a safety net that only re-enqueues markers with no live job.
