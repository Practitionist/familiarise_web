# Maintenance Mode Documentation

Familiarise's maintenance mode system provides two-tier protection (DEGRADED and OFFLINE) for planned downtime. It uses Redis for edge-fast reads and Prisma for audit trails, with fail-open design ensuring the site stays up if Redis becomes unreachable.

## Quick Reference

| Mode         | User Experience                 | Reads | Writes    | Webhooks     | Cron Jobs | BetterStack           |
| ------------ | ------------------------------- | ----- | --------- | ------------ | --------- | --------------------- |
| **OFF**      | Normal operation                | Yes   | Yes       | Yes          | Yes       | No incident           |
| **DEGRADED** | Warning banner, site functional | Yes   | Yes (gap) | Yes          | Yes (gap) | No incident           |
| **OFFLINE**  | Full maintenance page           | No    | No        | Yes (exempt) | Yes (gap) | Auto-creates incident |

**Key gaps**: DEGRADED does not block writes. Cron jobs bypass middleware entirely in all modes.

## Table of Contents

0. [BetterStack Setup Guide](./00-betterstack-setup.md) -- **Start here**: full from-scratch setup: account, monitors, status page, API token
1. [Architecture](./01-architecture.md) -- System design, data flow, key files
2. [DEGRADED vs OFFLINE](./02-degraded-vs-offline.md) -- What each phase blocks (with tables)
3. [Business Risks](./03-business-risks.md) -- Money-at-stake analysis
4. [Cron Jobs Reference](./04-cron-jobs-reference.md) -- All 61 jobs, schedules, locking, maintenance impact
5. [Webhook Behavior](./05-webhook-behavior.md) -- Payment webhook handling during downtime
6. [Pre-Maintenance Checklist](./06-pre-maintenance-checklist.md) -- Step-by-step operational checklist
7. [Post-Maintenance Recovery](./07-post-maintenance-recovery.md) -- Verification and reconciliation steps
8. [SDK Update Guide](./08-sdk-update-guide.md) -- Detailed per-package update guide
9. [Future Improvements](./09-future-improvements.md) -- Planned code changes for better protection

---

## End-to-End Cron, Maintenance & Outbox Architecture (Old vs. New Double ASCII Diagram)

### 1.1 Pre-Hardening Architecture (With All 10 Audited Production Flaws Highlighted)

```text
+===================================================================================================+
|                        PRODUCERS (API Routes, Webhooks, Server Actions, Jobs)                     |
+===================================================================================================+
   |                                                |
   | (~10% Money/Booking paths pass `tx`)           | (~90% Lifecycle/Booking/Org paths omit `tx`)
   v                                                v
+------------------------------------------------+ +------------------------------------------------+
| INSIDE `Serializable` $transaction (PG_POOL=1) | | OUTSIDE $transaction (Post-Commit Dual Write)  |
|  [FLAW #1] Runs 2x React Email SSR (`render` + | |  [FLAW #2] Crash/freeze after DB commit loses  |
|  `plainText`) + sequential User/Suppression    | |  the email & Novu bell completely.             |
|  queries while holding Serializable locks!     | +------------------------------------------------+
+------------------------------------------------+                          |
   |                                                                        |
   +-----------------------------------+------------------------------------+
                                       |
         +-----------------------------+-----------------------------+
         |                                                           |
         v (Email Path: `lib/email/deliver.ts`)                      v (In-App Bell Path: `lib/novu/outbox.ts`)
+--------------------------------------------------+       +--------------------------------------------------+
| Postgres: `FailedEmail` & `FailedEmailBatch`     |       | Postgres: `NotificationOutbox`                   |
| - Inserts `status: PENDING, nextRetryAt: NOW()`  |       | - Upserts `status: PENDING, nextRetryAt: NOW()`  |
| - [FLAW #3] NO inline lease grace window!        |       | - [FLAW #3] NO inline lease grace window!        |
| - [FLAW #4] `headers` (`List-Unsubscribe`) NOT   |       | - [FLAW #6] `deriveTransactionId` misses 5 keys  |
|   rebuilt on retry -> stripped on relay replay!  |       |   (`invoiceNumber`, `exportId`, `providerId`,    |
| - [FLAW #5] Never pruned! Full HTML/text bodies  |       |   `feedbackId`, `streamCallId`) & omits fallback |
|   for every `SENT` email accumulate forever!     |       |   to `row.id` when `transactionId` is null!      |
+--------------------------------------------------+       +--------------------------------------------------+
         |                           |                               |                           |
         | Inline Fast-Path (3-5s)   | Relay (Every 15m, limit=20)   | Inline Fast-Path (5s)     | Relay (Every 5m, limit=20)
         | [RACE CONDITION!]         | [6s timeout in cron-tick!]    | [RACE CONDITION!]         | [6s timeout in cron-tick!]
         +-------------+-------------+                               +-------------+-------------+
                       |                                                           |
                       v                                                           v
+--------------------------------------------------+       +--------------------------------------------------+
| Resend API (`POST /emails`, `/emails/batch`)     |       | Novu Cloud API (16 Multiplexed Workflow Families)|
| - [FLAW #7] `idempotencyKeyFor()` hashes         |       | - [FLAW #8] `syncSubscriber` (on dashboard mount)|
|   `to + subject + html` instead of `row.id`!     |       |   & `updateSubscriberPreferences` overwrite      |
|   Resend caches keys 24h -> SILENTLY DROPS any   |       |   disjoint keys in `subscriber.data`, wiping out |
|   2nd identical email sent within 24 hours!      |       |   muted preferences on every dashboard load!     |
| - [FLAW #9] Exhausting 5 transient attempts ->   |       | - [FLAW #10] All 18 `ORG_*` workflows omit       |
|   `DEAD_LETTER` emits ZERO Sentry error alerts!  |       |   `NotificationScope` (`organizationId`) -> org  |
|   `NovuError.body` echoes PII to Sentry!         |       |   alerts NEVER show under Org tab in `<Inbox />`!|
+--------------------------------------------------+       +--------------------------------------------------+

+===================================================================================================+
|                     CRON & MAINTENANCE INFRASTRUCTURE (Post-`c4e85c003` State)                    |
+===================================================================================================+
  Netlify `cron-tick.mts` (*/5 * * * *)                      GitHub Actions (42 Scheduled Workflows)
  - Uses `minute % every < 5` (ZERO stagger):                - `c4e85c003` deleted 17 GHA backstop workflows
    * `:00` & `:30` -> fires ALL 18/19 targets at once!        for ticker jobs without raising ticker timeouts!
    * `:15` & `:45` -> fires 16/17 targets at once!          - `cron-heartbeat.yml` runs 1x/day at 04:40 UTC:
    * `:05, :25, :35, :55` -> fires ZERO targets (33% idle!)   ONLY writer of `redis.set("cron:heartbeat:last")`!
  - `keep-warm.mts` only warms 3 instances -> 15+ cold       - `/api/health` checks `cron:heartbeat:last` with
    starts stampede PgBouncer & hit 6s abort ceiling!          6h threshold -> `cron.stale: true` 18h/day!
  - Warm container bug: 1 failed tick loads `@sentry/node`   - `withCronLock` in Postgres (`SystemJobExecution`)
    and patches global `fetch` for all future warm ticks!      has NO partial unique index on `(jobName) WHERE
                                                               status = 'RUNNING'` -> P0 TOCTOU lock race!
```

### 1.2 Target Production Architecture (Improvised, Decoupled & Hardened)

```text
+===================================================================================================+
|                     PRODUCERS (API Routes, Webhooks, Server Actions, Jobs)                        |
+===================================================================================================+
   |
   | 1. Pre-render React Email OUTSIDE Serializable $transaction (single-pass `render` + `toPlainText(html)`)
   | 2. Evaluate all User & Org NotificationPreferences in Postgres/App BEFORE staging (Single Source of Truth)
   | 3. Inside `$transaction(tx)`: insert lightweight Outbox row with:
   |    - `status: "PENDING"`, `nextRetryAt: NOW() + 60s` (inline lease grace window — prevents relay race!)
   |    - Reconstructed RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers on relay retry
   |    - `transactionId: derivedKey ?? row.id` (guaranteed idempotency key for every single/org workflow)
   |    - `NotificationScope` (`scope: "org", organizationId`) on all 18 `ORG_*` workflows
   v
+---------------------------------------------------------------------------------------------------+
|                        CONSOLIDATED OUTBOX LAYER (Postgres + Partial Indexes)                     |
|  1. `FailedEmail` & `FailedEmailBatch` (Resend Email Outbox)                                      |
|  2. `NotificationOutbox` (Novu In-App Feed Outbox)                                                |
|  3. `OutboundWebhookDelivery` (Enterprise Customer Webhooks)                                      |
|  * Bounded concurrency (`CONCURRENCY = 5`) + multi-recipient `resend.batch.send` (up to 100/call) |
|  * Outbox-row-scoped `Idempotency-Key: <EMAIL_TYPE>/<row.id>` (never drops legitimate repeats)    |
|  * Automated retention pruning in `prune-system-job-executions`:                                  |
|    - Null `htmlBody`/`textBody` on `SENT` emails after 7d; delete terminal outbox rows after 30d  |
+---------------------------------------------------------------------------------------------------+
   |
   v
+===================================================================================================+
|                  STAGGERED CRON & LOCKING ENGINE (Netlify Ticker + GitHub Actions)                |
+===================================================================================================+
  Netlify `cron-tick.mts` (Every 5m, Phase-Staggered):
  - Slot `:00, :15, :30, :45` (6 targets) | Slot `:05, :20, :35, :50` (6 targets) | Slot `:10, :25, :40, :55` (6 targets)
  - Max 6–7 concurrent targets per tick (matches warm pool + PgBouncer budget); 0% idle ticks!
  - Per-target timeout raised from 6s -> 15s; `tracePropagationTargets: []` prevents warm container fetch pollution.
  - Atomic Postgres lock: `CREATE UNIQUE INDEX "SystemJobExecution_running_jobName_key" ON "SystemJobExecution"("jobName") WHERE status = 'RUNNING'`
  - `/api/health` queries `pickFresherTimestamp(redisHeartbeat, SystemJobExecution.startedAt)` -> 0% false-stale rate!

+===================================================================================================+
|                CONSOLIDATED SENTRY v10 OBSERVABILITY (Errors + Traces + Logs + Metrics)           |
+===================================================================================================+
  - `tracesSampler`: 0% `/api/health` & `/_next`, 2% `/api/cleanup/*`, 10% default, 50% `/api/webhooks/*` & `/api/payments/*`
  - `beforeSend`, `beforeSendTransaction`, `beforeSendSpan`, `beforeSendLog`: unified `sentry-scrubber.ts`
    (strips `NovuError.body`, regex-redacts emails/tokens in messages/breadcrumbs, strips `culture.timezone`)
  - `Sentry.startSpan({ op: "queue.process" })` + `Sentry.metrics.count/gauge` on email & Novu drains
  - P0 Alerting: `level: "error"` (`expected: false`) whenever `FailedEmail` or `NotificationOutbox` hits `DEAD_LETTER`
```

---

## Emergency Contacts

| Role           | Contact | Notes                                        |
| -------------- | ------- | -------------------------------------------- |
| Platform Admin | _TBD_   | Primary escalation for maintenance decisions |
| DevOps Lead    | _TBD_   | Infrastructure and deployment issues         |
| Payment Ops    | _TBD_   | Payment reconciliation and refund issues     |

## Quick Commands

**Start DEGRADED mode** (admin dashboard):
`Dashboard > Maintenance > Start Degraded Mode`

**Start OFFLINE mode** (admin dashboard):
`Dashboard > Maintenance > Start Offline Mode`

**Bypass during maintenance** (for admin testing):

- Header: `x-maintenance-bypass: <secret>`
- Cookie: `maintenance_bypass=<secret>`

**Health check**: `GET /api/health` -- returns maintenance state + BetterStack connectivity

```json
{ "status": "healthy", "maintenance": { "phase": "OFF" }, "betterstack": { "configured": true, "reachable": true, "monitors": [...] } }
```
