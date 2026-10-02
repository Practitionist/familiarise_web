---
title: State-as-outbox with a scheduled ticker
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-10-02
---

# ADR 27 — State-as-outbox with a scheduled ticker

## Context

ADR 14 kept the platform queue-less for launch; ADR 22 measured GitHub Actions delivering every sub-hourly schedule roughly once per hundred minutes and authorised QStash as the escalation. The 2026-09-03 financial audit asked for a transactional outbox for post-payment side effects (#1356), and the 2026-10-02 Staff Architecture Re-Audit (#1926, #1930, #1931, #1932, #1935, #1937) hardened the end-to-end outbox, ticker, locking, and observability stack.

Three facts settle the queue posture:
1. **Postgres already holds the durable state an outbox exists to provide**: `WebhookEvent` is an inbound inbox with a `processed` flag; `FailedEmail` (`FailedEmailBatch`), `NotificationOutbox`, and `OutboundWebhookDelivery` are transactional outboxes with retry state; and money-bearing follow-ups are keyed on domain rows (`Payment`, `Appointment`, `Refund`, `WalletTopUp`).
2. **Every background job is exposed via `app/api/cleanup/[job]/route.ts`** built by `lib/cron/cleanup-route.ts`, gated by `CRON_SECRET` and wrapped in `withCronLock` (`lib/cron/with-cron-lock.ts`), so any HTTP scheduler can drive the fleet safely.
3. **External message brokers (Kafka, RabbitMQ, AWS SQS) cannot participate in a Postgres `$transaction` without a dual-write**, meaning a Postgres outbox table is still required even if a broker is added.

| Broker / Pattern | Atomic with Postgres `$transaction`? | Serverless (Netlify) Fit | Operational & Cost Overhead | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **Apache Kafka** | **No** (Requires DB outbox + CDC/Debezium to avoid dual-write) | **Poor** (Long-lived consumer groups & partition rebalancing) | **Very High** (\$150–\$500+/mo + ops overhead) | **Rejected** |
| **RabbitMQ / BullMQ** | **No** (Redis/AMQP enqueue inside DB tx is a dual-write) | **Poor** (Requires persistent TCP workers on a separate 24/7 VM tier) | **High** (Separate compute fleet required) | **Rejected** |
| **AWS SQS** | **No** (HTTP `SendMessage` inside DB tx is a dual-write) | **Mediocre** (No native SQS event source mapping on Netlify) | **Moderate** (Cross-cloud IAM + poller still required) | **Rejected** |
| **Upstash QStash** | **No on its own** (Still needs DB outbox) | **Excellent** (Stateless HTTP push with retries, DLQ, and `FlowControl`) | **Low** (~$1 / 100k messages) | **Optional Stage-2 Escalation** (if `OutboundWebhookDelivery` exceeds >10k/day) |
| **Postgres Transactional Outbox + Phase-Staggered Ticker** | **100% Atomic** (`stage()` writes inside the caller's `$transaction`) | **Native** (Inline fast-path delivers in ~150ms; phase-staggered ticker sweeps stragglers) | **Zero Incremental Cost** (\$0/mo) | **Active Production Architecture** |

## Decision

1. **Consolidated 3-Table Transactional Outbox + Domain Stamps.**
   - `FailedEmail` (and `FailedEmailBatch`), `NotificationOutbox`, and `OutboundWebhookDelivery` are the three dedicated transactional outbox tables.
   - Domain-row obligations use explicit nullable stamps (e.g. `Appointment.chatChannelEnsuredAt`, `Payment.description` `Auto-refund pending:` prefix) walked by idempotent sweepers.
2. **Inline Fast-Path with a 60-Second Lease Grace Window.**
   - When `stage()` (`lib/email/deliver.ts`) or `stageTrigger()` (`lib/novu/outbox.ts`) writes a `PENDING` outbox row that will immediately be attempted inline after the transaction commits, `nextRetryAt` is set to `NOW() + 60s`. This prevents a concurrent cron relay tick from claiming and double-sending the same row while the inline HTTP call is still in flight.
   - Resend `Idempotency-Key` headers are scoped to the outbox row ID (`<EMAIL_TYPE>/<row.id>`) when staged, so legitimate repeat transactional emails to the same recipient within 24 hours are never silently dropped by Resend's 24-hour payload cache.
3. **Phase-Staggered Netlify Scheduled Ticker (`netlify/functions/cron-tick.mts`).**
   - `cron-tick.mts` runs every 5 minutes (`*/5 * * * *`) and distributes 15-minute and 30-minute targets across three 5-minute phase offsets (`TARGET_OFFSET_MINUTES`: `:00/:15/:30/:45`, `:05/:20/:35/:50`, and `:10/:25/:40/:55`).
   - Instead of firing all 18 targets simultaneously at `:00` and `:30` (and 0 targets at `:05` and `:25`), each 5-minute tick fires a bounded wave of 6–7 targets with a 15-second per-target timeout, matching the warm container pool and `PG_POOL_MAX=1` PgBouncer budget.
4. **Atomic Postgres Lease Lock (`withCronLock`).**
   - `lib/cron/with-cron-lock.ts` acquires a Postgres lease on `SystemJobExecution` backed by the partial unique index `CREATE UNIQUE INDEX "SystemJobExecution_running_jobName_key" ON "SystemJobExecution"("jobName") WHERE status = 'RUNNING'` (`prisma/sql/partial-indexes.sql`) and atomic single-`UPDATE` CAS takeover for expired leases.
   - `app/api/health/route.ts` evaluates the fresher of the Redis heartbeat key and the latest `SystemJobExecution.startedAt` timestamp (`pickFresherTimestamp`) so active Netlify ticker runs keep cron health green 24/7.
5. **Automated Outbox & Execution Retention Pruning.**
   - `scripts/cleanup/prune-system-job-executions.ts` nulls `htmlBody`/`textBody` on `SENT` `FailedEmail` rows after 7 days and deletes terminal rows (`SENT`/`DELIVERED`/`CANCELLED` > 30 days, `DEAD_LETTER` > 90 days) across `FailedEmail`, `FailedEmailBatch`, `NotificationOutbox`, `EmailEvent`, and `SystemJobExecution`.

---

## Architecture Evolution: Old vs. New Production Architecture

### 1. Previous Post-`c4e85c003` Architecture (Audited Failure Modes)

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
|                     CRON & MAINTENANCE INFRASTRUCTURE (Pre-Hardening State)                       |
+===================================================================================================+
  Netlify `cron-tick.mts` (*/5 * * * *)                      GitHub Actions (Scheduled Workflows)
  - Used `minute % every < 5` (ZERO stagger):                - `cron-heartbeat.yml` ran 1x/day at 04:40 UTC as
    * `:00` & `:30` -> fired ALL 18 targets at once!           the ONLY writer of `redis.set("cron:heartbeat:last")`!
    * `:15` & `:45` -> fired 16 targets at once!             - `/api/health` checked `cron:heartbeat:last` with
    * `:05, :25, :35, :55` -> fired ZERO targets (33% idle!)   6h threshold -> `cron.stale: true` 18h/day!
  - Warm container bug: 1 failed tick loaded `@sentry/node`  - `withCronLock` in Postgres (`SystemJobExecution`)
    and patched global `fetch` for all future warm ticks!      used non-atomic `updateMany + create` on stale locks!
```

### 2. Target Production Architecture (Hardened in `#1930`–`#1937`)

```text
+===================================================================================================+
|                     PRODUCERS (API Routes, Webhooks, Server Actions, Jobs)                        |
+===================================================================================================+
   |
   | 1. Single-pass React Email render (`render` + `toPlainText(html)`) wrapped in `email.render` span
   | 2. Evaluate User & Org NotificationPreferences in Postgres (`resolveRecipientBellPolicy`) BEFORE staging
   | 3. Declarative sender/notifier descriptors (`defineEmailSender`, `defineSingleNotifier`, `defineOrgRosterNotifier`)
   | 4. Inside `$transaction(tx)` (or outbox stage): write lightweight Outbox row with:
   |    - `status: "PENDING"`, `nextRetryAt: NOW() + 60s` (inline lease grace window — prevents relay race!)
   |    - RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` reconstructed on relay retries
   |    - `transactionId: derivedKey ?? row.id` (guaranteed idempotency key for every single/org workflow)
   |    - `NotificationScope` (`scope: "org", organizationId`) stamped on all `ORG_*` workflows
   v
+---------------------------------------------------------------------------------------------------+
|                        CONSOLIDATED OUTBOX LAYER (Postgres + Partial Indexes)                     |
|  1. `FailedEmail` & `FailedEmailBatch` (Resend Email Outbox)                                      |
|  2. `NotificationOutbox` (Novu In-App Feed Outbox)                                                |
|  3. `OutboundWebhookDelivery` (Enterprise Customer Webhooks)                                      |
|  * Bounded concurrency (`CONCURRENCY = 5`) + multi-recipient `resend.batch.send` (up to 100/call) |
|  * Outbox-row-scoped `Idempotency-Key: <EMAIL_TYPE>/<row.id>` (never drops legitimate repeats)    |
|  * Automated retention pruning in `prune-system-job-executions.ts`:                               |
|    - Null `htmlBody`/`textBody` on `SENT` emails after 7d; delete terminal outbox rows after 30d  |
+---------------------------------------------------------------------------------------------------+
   |
   v
+===================================================================================================+
|                  STAGGERED CRON & LOCKING ENGINE (Netlify Ticker + GitHub Actions)                |
+===================================================================================================+
  Netlify `cron-tick.mts` (Every 5m, Phase-Staggered via `TARGET_OFFSET_MINUTES`):
  - Slot `:00, :15, :30, :45` (6 targets) | Slot `:05, :20, :35, :50` (6 targets) | Slot `:10, :25, :40, :55` (6 targets)
  - Max 6–7 concurrent targets per tick (matches warm pool + PgBouncer budget); 0% idle ticks!
  - Per-target timeout raised to 15s; `tracePropagationTargets: []` prevents warm-container fetch pollution
  - Atomic Postgres lock: `SystemJobExecution_running_jobName_key` partial unique index + single-UPDATE CAS takeover
  - `/api/health` uses `pickFresherTimestamp` across Redis & `SystemJobExecution` -> 0% false-stale rate!

+===================================================================================================+
|                CONSOLIDATED SENTRY v10 OBSERVABILITY (Errors + Traces + Logs + Metrics)           |
+===================================================================================================+
  - `tracesSampler`: 0% `/api/health` & `/_next`, 2% `/api/cleanup/*`, 10% default, 50% `/api/webhooks/*` & `/api/payments/*`
  - `beforeSend`, `beforeSendTransaction`, `beforeSendSpan`, `beforeSendLog`: unified `sentry-scrubber.ts`
    (strips `NovuError.body`/`rawValue`, regex-redacts emails/tokens in messages/breadcrumbs, strips `culture.timezone`)
  - `Sentry.startSpan({ op: "queue.process" })` + `Sentry.metrics` (`outbox.lag_ms`, `outbox.batch_duration_ms`)
  - P0 Alerting: `level: "error"` (`outbox_dead_letter: "true"`) whenever `FailedEmail` or `NotificationOutbox` hits `DEAD_LETTER`
```

---

### Who uses this pattern

The table below lists every side effect that rides an outbox row and a ticker-driven relay under this decision:

| Side effect                          | Outbox row                                               | Written where                                                                              | Relay (ticker target)                                                        | Since |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----- |
| Partner webhook delivery             | `OutboundWebhookDelivery`                                | The emitting service, before any POST                                                      | `dispatch-outbound-webhooks`, every 5m tick (`CONCURRENCY = 5`, 4.5s timeout)| #1019 |
| Stream chat channels after a capture | `Appointment.chatChannelEnsuredAt` (a stamp)             | The payment pipeline, as a NULL that the sweep re-drives                                   | `reconcile-orphaned-confirmations`, every 5m tick                            | #1356 |
| Transactional email                  | `FailedEmail` (`PENDING`, `nextRetryAt = now + 60s`)     | `stage()` in `lib/email/deliver.ts`, inside the caller's transaction where it has one      | `retry-failed-emails`, every 15m (offset `:05`), Actions as backstop         | #1654 |
| Novu in-app triggers                 | `NotificationOutbox` (`PENDING`, `nextRetryAt = now+60s`)| `stageTrigger()` in `lib/novu/outbox.ts`, gated by `resolveRecipientBellPolicy()`          | `drain-notification-outbox`, every 5m tick                                   | #1654 |
| Capture-webhook auto-refunds         | `Payment.description` (`Auto-refund pending:` prefix)    | The capture webhook's Phase 1 transaction, on all five refund branches                     | `retry-auto-refunds`, every 15m (offset `:10`), Actions hourly as backstop   | #1853 |

## Related

- ADR 05 (GitHub Actions crons), ADR 14 (queue posture), ADR 22 (measurements) — this ADR narrows their remedy, it does not reverse them.
- ADR 21 (single writer for payment confirmation) — the ticker never writes payment status; it only re-invokes the pipeline.
- #866, #1010 (QStash plan), #1356 (the outbox request this answers), #1926, #1930, #1931, #1932, #1935, #1937 (2026-10-02 architecture audit & simplification wave).

