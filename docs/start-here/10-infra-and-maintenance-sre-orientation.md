---
title: Infra and Maintenance — SRE Orientation
type: explanation
band: index
audience: sde1
status: live
last-reviewed: 2026-10-19
---

# Infra and Maintenance — SRE Orientation

This is the map for someone new on call. It covers where the system runs, how scheduled work reaches it, how you tell whether it is healthy, and — most importantly — which things you must never "fix" by hand.

It is written for a DevOps or SRE engineer in their first weeks. It assumes you can read TypeScript but not that you know this codebase. Everything is prioritised: **read sections 1 to 4 in order, then the rest as you need it.**

## Priority map

| #      | Section                                                     | Why it matters to you                                                                            |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **1**  | [The single-connection trap](#1-the-single-connection-trap) | The one constraint that will cause an outage if you break it. Read this before writing any code. |
| **2**  | [The two schedulers](#2-the-two-schedulers)                 | All background work runs from one of exactly two places. Knowing which is half of on-call.       |
| **3**  | [Never repair these by hand](#3-never-repair-these-by-hand) | The database refuses bad money states for you. Undo that and you cause real financial loss.      |
| **4**  | [Reading a job's health](#4-reading-a-jobs-health)          | The status codes lie if you read them naively. This is the decoding table.                       |
| **5**  | [Maintenance mode](#5-maintenance-mode)                     | How planned downtime works, and the emergency door that cancels bookings.                        |
| **6**  | [How you know it is healthy](#6-how-you-know-it-is-healthy) | The watchdogs, and the important gap between them.                                               |
| **7**  | [Reconcilers](#7-reconcilers)                               | What they may and may not do.                                                                    |
| **8**  | [The database sidecars](#8-the-database-sidecars)           | Where the invariants live, and the command that silently drops four of them.                     |
| **9**  | [Continuous integration](#9-continuous-integration)         | What gates a merge, and what does not.                                                           |
| **10** | [Vendors and quotas](#10-vendors-and-quotas)                | The rate limits that silently degrade the system.                                                |

## The estate, in one picture

```
                      ┌────────────────────────────────────────┐
   user ── HTTPS ──▶  │  DNS · Netlify Edge · CDN              │
                      │  middleware.ts (auth, maintenance,    │
                      │  rate limits) — edge runtime          │
                      └───────────────────┬────────────────────┘
                                          │
                      ┌───────────────────▼────────────────────┐
                      │  ___netlify-server-handler            │
                      │  Next.js 15 App Router                │
                      │  Node 22 Lambda · 1024 MB             │
                      │  region: singapore · ceiling ~26 s    │
                      └───────────────────┬────────────────────┘
                                          │
      ┌───────────────┬───────────────────┼───────────────────┬───────────────┐
      ▼               ▼                   ▼                   ▼               ▼
 Supabase          Upstash            Razorpay              Stream           Novu
 Postgres          Redis              + RazorpayX           chat + video     bell
 ap-south-1        500k cmd/mo        INR only              + recordings
 Mumbai            REST only
      │               │                   │                   │
      │               │                   │                   │
      │               └───── state · locks · limiter state ──┘
      │                                                       │
      │                                                  ┌────┴─────────────┐
      │                                                  │  Sentry          │
      │                                                  │  5k events/mo    │
      │                                                  └──────────────────┘
      │                                             ┌─────────────────────────┐
      │                                             │  Supabase Storage · R2  │
      │                                             └─────────────────────────┘
      │
      └── ONE project, many worktrees. Also entered by:
          GitHub Actions (batch cron) · Netlify ticker (5-min cron) · Sentry canary
```

Three facts to take from that picture.

**One Postgres serves both development and production.** Every worktree on every machine symlinks the same `.env` and points at the same database. A careless script or a load test touches production rows. This is the single biggest operational hazard on this estate and it is deliberate — one project, not one per developer.

**Everything is in one region except compute.** The database is in Mumbai (`ap-south-1`); the functions run in Singapore. Every request therefore pays a cross-region round trip, which is why connection counts and query budgets are treated as scarce.

**Redis is REST, not a socket.** There is no long-lived connection to Upstash. Every read is an HTTP call, which changes how you reason about timeouts and why the Redis call budget is measured in monthly commands rather than connections.

## 1. The single-connection trap

This is the most important thing on the page.

On Netlify, each function invocation runs with **`PG_POOL_MAX=1`**. That is not a tuning choice; it is the ceiling the platform gives you, and `lib/prisma.ts` throws at import if the variable is unset on Netlify.

With exactly one database connection per invocation, this is fatal:

```ts
// NEVER — this deadlocks.
await prisma.$transaction(async (tx) => {
  const a = await prisma.appointment.findUnique({ where: { id } }); //  ← uses the global pool
  await tx.organization.update({ where: { id: orgId }, data: { x } });
});
```

```ts
// ALWAYS — everything inside the transaction takes `tx`.
await prisma.$transaction(async (tx) => {
  const a = await tx.appointment.findUnique({ where: { id } }); //  ← same connection
  await tx.organization.update({ where: { id: orgId }, data: { x } });
});
```

The transaction holds the only connection while waiting for the global client to borrow one that will never be free. The invocation hangs until the function ceiling kills it, and the user sees a 504.

**The rule, stated once:** inside a `$transaction`, every helper call receives and queries `tx`. Never the global `prisma`. This holds for helper functions too — passing `tx` down is part of their signature for this reason.

Two corollaries you will meet immediately:

- **Never make a network call inside a transaction.** Holding the single connection during a Razorpay or Stream call means every other query in the invocation waits on a vendor. Payments are confirmed by webhook, not by calling the gateway mid-transaction, and that is why.
- **Do not run `Promise.all` of writes inside a transaction.** Parallel writes contend for the one connection and serialise anyway, with extra overhead. Write them in sequence.

Multi-request runtimes (Cloud Run, Vercel Fluid, Fly) run a larger pool (`5` to `10`), so code that deadlocks locally may only fail on the deployed build. A deploy preview is the only place that reliably reproduces it.

## 2. The two schedulers

All background work in this system comes from exactly one of two schedulers. Knowing which owns a job is the first question to ask when something looks stuck.

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  SCHEDULER A — Netlify ticker            every 5 minutes        │
   │  netlify/functions/cron-tick.mts                                 │
   │  · 28 targets, latency-sensitive recovery sweeps                 │
   │  · phase-staggered: 7–8 targets fire per 5-minute slot         │
   └────────────────────────────┬─────────────────────────────────────┘
                                │  POST /api/cleanup/<slug>?limit=N
                                │  Authorization: Bearer $CRON_SECRET
   ┌────────────────────────────▼─────────────────────────────────────┐
   │  app/api/cleanup/[job]/route.ts        (the ONLY cleanup route) │
   │    · timing-safe secret check                                     │
   │    · ?limit= clamped to 500                                      │
   │    · assertNotInMaintenance(job)                                  │
   └────────────────────────────┬─────────────────────────────────────┘
                                │
   ┌────────────────────────────▼─────────────────────────────────────┐
   │  withCronLock(jobName)  →  Postgres lease on SystemJobExecution │
   └────────────────────────────┬─────────────────────────────────────┘
                                │
   ┌────────────────────────────▼─────────────────────────────────────┐
   │  lib/cron/cleanup-registry.ts     57 slugs, one implementation   │
   │  → core module (scripts/** or jobs/**)  →  row in SystemJobExecution
   └──────────────────────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────────────────────┐
   │  SCHEDULER B — GitHub Actions           6 cron-declaring files  │
   │  cron-intra-day · cron-daily · cron-weekly                       │
   │  + cron-heartbeat · db-live-drift                                │
   │  + security-audit                                                │
   │  · daily / weekly / statutory batch work                         │
   │  · 29 registry jobs + 13 jobs with no HTTP twin                  │
   │  · bare `npx tsx jobs/<domain>/<job>.ts` processes               │
   └──────────────────────────────────────────────────────────────────┘
```

**The split, and why it matters.** Sub-hourly _recovery_ work — sweeps that clean up after a failure — runs on the Netlify ticker, because GitHub throttles scheduled workflows and a job asking for every hour can be measured delivering once per hundred minutes. Daily and weekly _business_ work — payouts, invoices, statutory filings — runs on GitHub Actions, where a few hours of delay is harmless.

**Actions is not a backstop for the ticker.** This trips people up constantly. If a job is listed as a ticker target, it runs on the ticker and nowhere else unless a workflow also names it. Twenty-seven of the 28 targets have no workflow at all — including `auto-complete-appointments` and `detect-consultant-no-shows`, which both move money. **If GitHub Actions is down, those two still run and the batch fleet does not.** If Actions is down, Monday payouts do not happen.

Both schedulers converge on the same Postgres lease, so a tick and an Actions run of the same job can never proceed together. The loser gets a 409.

**Do not add a third scheduler.** A job that is not in the ticker and not in a workflow runs nowhere. The build fails if you register a job with no scheduler, so this is caught in CI rather than in production.

### The lock

`withCronLock` writes a `RUNNING` row to `SystemJobExecution` and relies on a partial unique index that permits only one such row per job name. It is a Postgres lease, not a Redis lock — Redis is deliberately kept off this path because an incident on 2026-09-21 spent roughly 430,000 of the account's 500,000 monthly commands on cron locking alone.

| Lock mode          | What it does when the lease table is unreachable                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `closed` (28 jobs) | Refuses to run and pages. Correct for money: a missed run is recoverable, a silent double-run is not. |
| `open` (23 jobs)   | Runs unlocked with a warning. Correct where repeating the work is harmless.                           |
| bespoke Redis (2)  | `create-payout-batch` and `process-payouts`, because they also coordinate interactive admin runs.     |
| none (3)           | Deliberately unlocked.                                                                                |

Both modes flip to `closed` if the error looks like connection or pool exhaustion — that outage is exactly the window where two runners would both believe they hold the lease.

The lease is 15 minutes by default and 35 for the payout and reconcile family. A running job renews every third of the TTL. **A hard-killed invocation leaks its lease until it expires**, so a job can appear stuck for up to 45 minutes after it actually died. That is a known cost, not a bug you should fix by shortening the TTL.

## 3. Never repair these by hand

This section is the reason the whole system is shaped the way it is.

The database holds roughly **82 check constraints, 28 indexes and 8 triggers** that exist to make certain states physically impossible. An operator fixing a money row by hand with a SQL client is not "helping" — they are removing the only guarantee.

```
 ┌──────────────────────────────────────────────────────────────────┐
 │  An unbalanced ledger transaction cannot commit.                 │
 │                                                                  │
 │   LedgerTransaction  ← idempotency key (UNIQUE)                  │
 │     └── LedgerEntry × N     amountPaise BIGINT  CHECK (> 0)      │
 │                                                                  │
 │   CONSTRAINT TRIGGER  (DEFERRED until COMMIT)                    │
 │     Σ(DEBIT) − Σ(CREDIT)  ==  0   for every transaction           │
 │                                                                  │
 │   If it does not balance, COMMIT is refused. Not rolled back —    │
 │   refused. Nothing was written.                                   │
 └──────────────────────────────────────────────────────────────────┘

 ┌──────────────────────────────────────────────────────────────────┐
 │  Two confirmed sessions cannot overlap for one expert.            │
 │                                                                  │
 │   EXCLUDE USING gist (                                           │
 │     consultantProfileId WITH =,                                  │
 │     tstzrange(startsAt, endsAt) WITH && )                         │
 │   WHERE not tentative, not deleted, not cancelled                 │
 │                                                                  │
 │   Violation → SQLSTATE 23P01 → HTTP 409 SCHEDULE_CONFLICT        │
 └──────────────────────────────────────────────────────────────────┘

 ┌──────────────────────────────────────────────────────────────────┐
 │  A payment's funding legs must sum to its amount.                 │
 │                                                                  │
 │   CONSTRAINT TRIGGER on PaymentLeg  AND  on Payment.amount       │
 │   Two carve-outs, both deliberate:                               │
 │     · REFERRAL_CREDIT — already netted out of Payment.amount      │
 │     · licence-only payments — licence absorbed at contract time   │
 │                                                                  │
 │   Reversal legs must be negative and cannot exceed their sibling. │
 └──────────────────────────────────────────────────────────────────┘
```

The rule that follows, and which is written into this repository's own agent instructions:

> **Never write an application-level sweep to re-verify something a check constraint, an exclusion index or a trigger already refuses at commit.**

Reconciling across a vendor boundary is legitimate, because a vendor really can disagree with us. Re-checking arithmetic the database already refuses is waste that rots.

**What this means when you are on call:**

- If a ledger row looks wrong, find the reconciler finding. Do not `UPDATE`.
- If two sessions look like they overlap, the database already said no. One of your two rows is a read replica, a soft-deleted row, or a `RESCHEDULED` row the exclusion index ignores but the app still treats as occupied. That last one is a known gap.
- If a payment's legs do not sum, the commit that created them failed. The rows you are looking at did not come from a successful transaction.

## 4. Reading a job's health

This is the decoding table. Most on-call confusion comes from reading a 2xx as "fine".

| Status          | What it actually means                                                                                                                     | Do you need to act? |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `200`           | Ran cleanly                                                                                                                                | No                  |
| **`207`**       | **Ran, and found something a human must look at.** A double-booking detected, a row escrowed, a document missing, a cascade still failing. | **Yes**             |
| `400`           | The `?limit=` was malformed                                                                                                                | Fix the caller      |
| `401`           | `CRON_SECRET` missing or wrong                                                                                                             | Fix the secret      |
| `404`           | Unknown slug                                                                                                                               | Fix the slug        |
| **`409`**       | **Another copy holds the lease.** Expected under overlap.                                                                                  | **No**              |
| `500`           | The job failed, or returned `success: false`                                                                                               | Investigate         |
| `503` + `phase` | Maintenance held the job. Expected.                                                                                                        | No                  |
| `503` no phase  | Lease table unreachable on a fail-closed job                                                                                               | Investigate         |

Two traps:

**A 207 is not a success.** An alert rule that treats any 2xx as healthy silently discards every needs-human finding. This is the most common way a real problem goes unnoticed here.

**The ticker always returns 200.** Not even when every target failed. Netlify re-invokes a scheduled function that answers 5xx up to three times, seconds apart, and each retry re-fires every due target — production once ran the whole ticker at triple rate for weeks because one target was failing. So you cannot judge the ticker by its HTTP status. **Read the structured log line instead:**

```json
{
  "event": "cron-tick",
  "ok": true,
  "lockHeld": 2,
  "failed": 0,
  "durationMs": 4120
}
```

`failed` is the field that matters. It holds the slugs that returned something other than 200, 207, 409, or a maintenance-marked 503.

## 5. Maintenance mode

A deliberate way to take the site into a reduced state for a migration or an incident. Three phases, held in Redis and mirrored to a `MaintenanceWindow` audit row.

```
   ┌────────┐          ┌───────────┐          ┌─────────┐
   │  OFF   │─────────▶│ DEGRADED  │─────────▶│ OFFLINE │
   └────────┘          └───────────┘          └─────────┘
   normal operation     reads fine             everything
                       writes mostly           blocked —
                       blocked —               EXCEPT webhooks
                           │                       │
                           │                       │ payments must
                           │ financial jobs        │ still confirm
                           │ are held              ▼
                           ▼                   webhooks +
                    writes refused          cron only
```

| Phase      | Reads | Writes                                        | Webhooks         | Cron jobs                               |
| ---------- | ----- | --------------------------------------------- | ---------------- | --------------------------------------- |
| `OFF`      | yes   | yes                                           | yes              | all run                                 |
| `DEGRADED` | yes   | mostly — a 44-pattern deny-list blocks writes | yes              | only the **27** financial jobs are held |
| `OFFLINE`  | no    | no                                            | **yes (exempt)** | all held                                |

Two design points worth internalising.

**Webhooks are always exempt, in every phase.** Razorpay can capture a payment at any moment. If webhook handling were blocked, those payments would sit unconfirmed. This is why maintenance mode can be used without stranding money.

**The read fails open.** If Redis is unreachable, maintenance mode reports `OFF` and the site proceeds. That is deliberate — a Redis outage must not take the site down — but it means a Redis outage also silently disables the maintenance gate.

### The emergency door

`POST /api/admin/maintenance` is the one place where a mistake causes real damage. **An empty body means `OFFLINE`.** Activating `OFFLINE` drains active sessions, freezes appointments, and pauses discount codes.

So, in order of how badly this can go:

- Do not call it without a typed confirmation.
- `OFFLINE` **cancels and refunds every booking in the window.** This is not reversible by flipping the phase back.
- The activation is not idempotent and is not duration-bounded.
- It is not currently written to an audit row before it takes effect.

If you need the site in a reduced state during a migration, `DEGRADED` is almost always what you want. Reach for `OFFLINE` only when the site genuinely cannot serve reads.

## 6. How you know it is healthy

Three watchdogs, with an important gap between them.

```
   ┌────────────────────────────────────────────────────────────────┐
   │  1. cron-heartbeat          daily, GitHub Actions             │
   │     "did every workflow that declares cron: actually run?"     │
   │     Tolerance: interval x 12, floor 6 h.                       │
   │     ⚠ does NOT watch the Netlify ticker at all.                │
   └────────────────────────────────────────────────────────────────┘
   ┌────────────────────────────────────────────────────────────────┐
   │  2. Sentry cron monitor      every 5 min, from the ticker      │
   │     ⚠ checkin_margin 3, failure_issue_threshold 3             │
   │     ⚠ CALIBRATED FOR A 5-MINUTE TICK.                        │
   │       A 15 or 30 minute target will NEVER trip it, because    │
   │       three consecutive misses fit inside its normal interval. │
   └────────────────────────────────────────────────────────────────┘
   ┌────────────────────────────────────────────────────────────────┐
   │  3. GET /api/health  →  cron.stale                            │
   │     every locked job refreshes cron:heartbeat:last in Redis    │
   │     stale = true once older than 45 minutes                   │
   │     watch this from an external uptime pinger                 │
   └────────────────────────────────────────────────────────────────┘
   ┌────────────────────────────────────────────────────────────────┐
   │  Sentry ingest canary        every 6 hours, ticker target      │
   │     Posts one real error event to prove Sentry still accepts   │
   │     errors. Alerts BY EMAIL, never through Sentry.            │
   │     Exists because Sentry answers 200 while silently           │
   │     discarding events once the quota is spent.                 │
   └────────────────────────────────────────────────────────────────┘
```

**Read that gap carefully.** The heartbeat checks that GitHub Actions workflows ran. It does not check the Netlify ticker. The Sentry monitor covers the ticker but cannot see an individual fifteen-minute target fail. So there is no single signal that says "the recovery sweeps are broken".

The two that _are_ reliable for the ticker are the ticker's own `failed` field in the log line, and `cron.stale` on `/api/health`. When you are asked "is the cron fleet healthy", check those two, not the heartbeat.

`/api/health` also returns degraded responses as `no-store`, so polling it runs several database and Redis queries each time. Do not poll it from a tight loop.

## 7. Reconcilers

A reconciler compares two sources of truth and adopts or reports the difference. There are exactly two kinds, and telling them apart tells you whether a sweep is behaving correctly.

```
   VENDOR-BOUNDARY                         INTERNAL-CACHE
   ───────────────                         ───────────────
   local row says PENDING                  cached value vs the
   Razorpay / Stream /                     system that authored it
   Supabase says otherwise
        │                                        │
        ▼                                        ▼
   ADOPT the vendor's answer              REPORT the difference
   reconcile-payment-status                reconcile-ledgers
   reconcile-payout-status                 (BillingAccount.walletBalance
   reconcile-disputes                         is only a cache for an
   reconcile-refunds                          atomic debit guard; this
   reconcile-orphaned-recordings              sweep asserts it)
   reconcile-document-storage
   sweep-stuck-webhook-events

   ✗ A third kind must never exist:
     re-verifying a database invariant. If COMMIT already refuses
     the state, a sweep that re-checks it is waste.
```

When a reconciler finds something it cannot safely repair, it **records a finding and stops**. It does not guess. The vocabulary you will meet in logs and summaries:

| Term             | Meaning                                                      |
| ---------------- | ------------------------------------------------------------ |
| **Dead-letter**  | Attempt budget exhausted; a human decides.                   |
| **Needs-human**  | State is legitimate but unusual; the operator queue owns it. |
| **Escrow**       | Row parked in a holding state with a stamp explaining why.   |
| `AWAITING_HUMAN` | A marker that suppresses automatic earnings release.         |

The largest reconciler is `reconcile-ledgers`: about seventeen derivation families, run set-based, writing a `LedgerReconciliationReport`. It repairs nothing. A `WALLET_BALANCE_DRIFT` finding freezes wallet spend for that account and pages once per drifting account, with a weekly reminder; the freeze lifts on the next audit that finds the cache equal to the journal.

## 8. The database sidecars

The invariants in section 3 live in three hand-written SQL files, not in the Prisma schema.

| File                        | Constraints | Indexes | Triggers |
| --------------------------- | ----------- | ------- | -------- |
| `check-constraints.sql`     | 82          | 28      | 3        |
| `ledger-triggers.sql`       | 0           | 0       | 3        |
| `payment-legs-triggers.sql` | 0           | 0       | 2        |

Prisma's schema language cannot express any of these — no check constraints, no deferrable triggers, no partial or `NULLS NOT DISTINCT` indexes, no `EXCLUDE USING gist`. So they are applied separately, idempotently, each statement in its own short transaction with a 3-second lock timeout.

### The command that will bite you

```
   npm run db:push        ──▶  db:preflight
                              prisma db push        ← drops every sidecar index
                              db:sidecars           ← re-adds them
                              check-db-sidecars     ← asserts they exist

   ⚠ `npm run db:push:schema` ALSO exists as a standalone script.
     It runs db:preflight + prisma db push and STOPS.
     Sidecars are never applied. Four money uniques are silently gone
     and no test fails.
```

Because one Postgres serves development and production, a bare `prisma db push` against the shared database drops sidecar-owned indexes on live data. Always use the full `db:push`, never the `:schema` variant, and never run `db:*` without being certain.

Four independent layers verify the sidecars, so a silent loss is unlikely but not impossible:

1. **Static** — `scripts/db/sidecar-objects.ts` parses the SQL, so an object commented out by accident is caught.
2. **Live catalog** — `scripts/ci/check-db-sidecars.ts` queries `pg_constraint`, `pg_indexes` and `pg_trigger` and fails on anything missing. Runs against a throwaway Postgres in CI.
3. **Daily read-only drift** — `scripts/ci/check-db-live-drift.ts` runs `prisma migrate diff` and fails on any unplanned difference.
4. **Round trip** — CI rebuilds a fresh database from scratch and asserts all objects exist.

## 9. Continuous integration

`ci.yaml` is the merge gate. Five jobs, and the one that matters most for infrastructure work is the last.

| Job          | What it checks                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `lint`       | Prettier (advisory), ESLint (blocking), `bash -n` and shellcheck on CI scripts                                                |
| `typecheck`  | `tsc --noEmit`, supply-chain audit, and four static guards: money columns, auth schema, workflow secrets manifest, docs drift |
| `unit-tests` | Jest, split into two shards                                                                                                   |
| `build`      | `next build`. Skipped on ordinary pull requests; the Netlify deploy preview is the build gate there.                          |
| `db-guards`  | Throwaway Postgres → `db push` → sidecars → assert → support race tier. Proves a fresh database keeps every invariant.        |

**Two gates are deliberately advisory.** Knip (dead code) runs with `continue-on-error`. CodeRabbit is report-only by explicit policy — reviews do not block merges, and comments are triaged by hand against the code.

**The load gate, load test and race-condition tests are manual-dispatch only.** One Postgres serves development and production, so a self-firing load test would be a recurring production incident. Run them deliberately, against a deploy preview, with the cleanup step enabled. A load-gate run whose cleanup was _skipped_ fails on purpose: a green run with production rows still in the database is the one outcome it must never report as success.

## 10. Vendors and quotas

The system degrades silently when a quota runs out. These are the limits worth knowing by heart.

| Vendor                | Limit                                        | What happens at the ceiling                                                                       |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Upstash Redis**     | 500,000 commands/month, shared with previews | Call failures. Some limiters fail open, which means the protection is silently off                |
| **Sentry**            | 5,000 events/month                           | Sentry keeps answering 200 while discarding errors. The ingest canary exists purely to catch this |
| **GitHub Actions**    | included minutes, then billed                | If billing lapses, every scheduled workflow stops and nothing outside Actions notices             |
| **Supabase Postgres** | `PG_POOL_MAX=1` per Netlify invocation       | Deadlock on any global-client read inside a transaction                                           |
| **Razorpay / Stream** | rate limits                                  | Webhook processing slows; retries stack                                                           |
| **Stream recordings** | 14-day retention on their copy               | After that the file is gone. Transfer to R2 before it expires                                     |

The GitHub Actions case is the one that has actually bitten. Actions can stop running for reasons unrelated to code — lapsed billing, a spending limit — and the heartbeat that watches for it lives _in_ Actions, so it cannot report the failure it exists to detect. **If a payout date passes and no payout row appeared, check whether the Actions fleet ran at all before debugging payout logic.**

## Failure modes and recovery

| Symptom                                   | First thing to check                                                                                     | Where to look                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 504 on a write                            | A global-client read inside a transaction                                                                | The query touching Supabase              |
| Sweeps seem to run at triple rate         | A target returning 5xx — Netlify retries the whole tick                                                  | Ticker's `failed` field                  |
| Job stuck for 15–45 min after dying       | A leaked lease; wait for expiry rather than clearing it                                                  | `SystemJobExecution` rows with `RUNNING` |
| Two sessions booked the same slot         | Not a data problem — the exclusion index refused the second; look for soft-deleted or `RESCHEDULED` rows | The 409 in the response                  |
| Ledger does not balance                   | The commit was refused. Nothing was written                                                              | `LedgerReconciliationReport`             |
| `CRON_SECRET` 401s everywhere             | The Actions secret is missing, not the Netlify one                                                       | Both environments                        |
| Sentry shows no errors during an incident | Probably the quota. The canary tells you                                                                 | Canary alert email                       |
| Payout did not run on schedule            | Did GitHub Actions run at all?                                                                           | Actions run history                      |

## Where to read next

| Question                                             | Document                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| What each job is and what it mutates                 | [../maintenance/04-cron-jobs-reference.md](../maintenance/04-cron-jobs-reference.md)                             |
| Response codes, locks, sidecars, reconciler taxonomy | [../maintenance/10-cron-and-reconciliation-reference.md](../maintenance/10-cron-and-reconciliation-reference.md) |
| Why the scheduler is shaped this way                 | [ADR 27](../enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md)                           |
| Why Postgres does the concurrency work               | [ADR 13](../enterprise/70-design-decisions/13-postgres-native-concurrency.md)                                    |
| Why GitHub Actions still exists                      | [ADR 05](../enterprise/70-design-decisions/05-github-actions-crons.md)                                           |
| Redis locking and caching posture                    | [../architecture/distributed-systems-explained.md](../architecture/distributed-systems-explained.md)             |
| Maintenance phases in full                           | [../maintenance/02-degraded-vs-offline.md](../maintenance/02-degraded-vs-offline.md)                             |
| Netlify specifics and the cold-start story           | [../deployment/netlify.md](../deployment/netlify.md)                                                             |
| Environment variables                                | `.env.sample`                                                                                                    |
| Infrastructure and maintenance audit                 | GitHub issue 2157                                                                                                |

Related issues: 2157 (infrastructure and maintenance audit, with its P0–P3 findings), 2137 (booking productionization), 2145 and 2156 (alert paths and monitoring).

## Deprecated & Superseded Approaches

**A generic outbox table and a queue worker.** Replaced by state-as-outbox (ADR 27), which keeps every obligation on the domain row it belongs to. The ADR 27 diagram still shows a Redis platform switch that was never implemented.

**Redis as the cron lock.** Replaced by the `SystemJobExecution` lease after the 2026-09-21 command-budget incident. `CronLockUnavailableError` in `lib/cron/cron-lock-errors.ts` still says the lock "requires a real Redis lock"; that text is stale.

**Individual per-job cron workflow files.** Sixty-seven of them once burned roughly 340 Actions runner starts a day. Consolidated into three fleet files plus the monitors.

**A keep-warm pinger.** Added to fight ~28 s cold starts, then deleted once disabling Next.js entry preloading brought them to under 2 s. `__tests__/lib/next-config-preload.test.ts` actively asserts the file stays absent.

**The hot-standby platform switch.** `AGENTS.md` §2.5 describes an Upstash key that mutes the ticker on a standby host, so a failover is a sub-minute key flip. **That gate does not exist in code.** If you are ever asked to perform a failback using it, the documented step is a no-op and you must change DNS instead. Treat any runbook that claims a one-step cron flip as wrong until you have grepped for it.
