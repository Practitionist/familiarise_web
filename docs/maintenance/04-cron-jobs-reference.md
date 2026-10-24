# Cron Jobs Reference

The platform runs **seven GitHub Actions workflows that declare a `cron:` schedule**, plus one Netlify scheduled function. The seven are the three job fleets (`cron-intra-day.yml`, `cron-daily.yml`, `cron-weekly.yml`), the dead-man watchdog (`cron-heartbeat.yml`), and three read-only monitors (`db-live-drift.yml`, `stream-webhook-drift.yml`, `security-audit.yml`). Between them they run **70 background jobs** against the Netlify ticker's **28 targets**.

Every CLI job boots a bare Node process with `tsx`, connects straight to PostgreSQL through Prisma, acquires a distributed lock via `withCronLock`, checks `abortIfMaintenance()`, and exits.

Every HTTP cleanup twin is served by the unified dynamic route `app/api/cleanup/[job]/route.ts` backed by `lib/cron/cleanup-registry.ts`.

This page is the **job catalogue**: what each job is, what it mutates, how it locks, and what runs it. The scheduling _mechanics_ — the registry structure, the response-code contract, `?limit=`, lease durations, phase staggering, the Postgres sidecars and the reconciler taxonomy — live in [10-cron-and-reconciliation-reference.md](./10-cron-and-reconciliation-reference.md).

## Universal Cron Locking & Heartbeat

Cron locking is now universal for every job that needs it. Before PR 6 of that train, one scheduled job ran with no mutual exclusion of any kind, and nothing in the repository could tell you that. Today every scheduled job takes a `withCronLock` lease, holds a documented bespoke lock, or is on an explicit exemption list, and `__tests__/maintenance/cron-lock-registry.test.ts` re-derives that claim from source on every CI run, so the next unlocked job fails the build instead of quietly double-running for a year.

The lock is a **Postgres lease on `SystemJobExecution`**, not a Redis lock. Redis is deliberately kept off the cron path: an incident on 2026-09-21 spent roughly 430,000 of the account's 500,000 monthly commands on cron locking alone.

The same train gave the fleet a way to notice its own death. Every locked run refreshes a single Redis key, `cron:heartbeat:last`, and `GET /api/health` reports its age under `cron`. If that key goes stale for more than 45 minutes the scheduled fleet has stopped — the one failure the Actions-API heartbeat cannot report, because it would have stopped too.

## What changed in #1270

Running is not the same as being importable, and until #1270 nothing checked the difference. Five of these workflows had never completed a single run: their entrypoints reached `lib/supabase.ts`, which opens with `import "server-only"` — a marker package whose main entry does nothing but throw. Next resolves it to an empty module under the `react-server` export condition, and every other resolver, including the bare Node process a workflow runs, gets the throw. Each of those jobs therefore died during module evaluation, before a line of its own code ran, on every run it had ever had.

Nothing surfaced it. The workflows went red, but they are low-traffic housekeeping jobs that nobody watches, and the consequences accumulate silently rather than breaking a user-facing path: recordings past their organization's retention window were never tombstoned and their Supabase objects were never deleted, which is a DPDP erasure gap; permanent-storage transfers never ran, so `STREAM_ONLY` recordings simply lapsed when Stream's fourteen-day URL expired; soft-deleted documents were never purged from storage; and the sweep that re-drives stuck webhook events was itself stuck.

Building that guard immediately turned up a second, larger instance of the same class. Eight further workflows — `process-payouts`, `handle-stuck-payouts`, `reconcile-payout-status`, `reconcile-payment-status`, `sync-payment-earnings`, and three more — reached `lib/auth-server.ts`, which called React's `cache()` at module scope. The version of React this repository actually pins, 18.3.1, has no `cache` export at all; the call resolved inside the application only because Next aliases `react` to its own vendored React 19 in the RSC layer, which `lib/auth-server.ts` already documents. A bare Node process got the declared React and a `TypeError`, so every one of those eight jobs died during module evaluation exactly as the five above did. PR #1281 closed it by building the session memo on first call rather than at import, so the `cache()` call happens on first use inside a request rather than at module load — the correct behaviour for a one-shot cron process, not a degraded one. `KNOWN_UNRUNNABLE` in `__tests__/maintenance/workflow-import-env.test.ts` has been empty since #1281, and the test fails if a job quietly starts reaching an unloadable module again.

Two things now prevent a repeat. The Supabase clients and storage primitives a job needs live in `lib/supabase-storage-core.ts`, which carries no marker, and `lib/supabase.ts` re-exports them so application code is unchanged and still gets its client-import guard. And `__tests__/maintenance/workflow-import-env.test.ts` re-derives every scheduled workflow's import graph on each CI run, failing when one reaches a `server-only` module or when a job that reaches the Supabase client module is not given the two environment variables that module throws without.

## What changed in #1356

The 2026-09-03 financial audit re-measured GitHub Actions' sub-hourly schedules and confirmed the finding ADR 22 first recorded: GitHub throttles scheduled workflows rather than dropping them outright, so a sub-hourly cron delivers far less often than it declares. `netlify/functions/cron-tick.mts` closes that gap for the recovery sweeps where the delay matters most.

The ticker fires every five minutes and POSTs its due targets (the `TARGETS` array) to `/api/cleanup/<slug>?limit=N` with a `CRON_SECRET` bearer token and a per-target abort timeout. ADR 27 records why this is a scheduler fix rather than a new outbox table: the durable state an outbox exists to provide already lives on the domain rows — `Payment`, `Appointment`, `Refund`, `WalletTopUp`, `WebhookEvent`, `OutboundWebhookDelivery`, `FailedEmail` — that these sweeps already walk.

Ticker requests carry per-job limits where supported, with smaller batches for vendor-bound work. A limit bounds selected primary entities, not every related row or the duration of an accepted vendor call. Later scheduled or manual slices continue eligible work. GitHub Actions is not an unbounded money-job fallback; review each worker’s actual continuation and timeout behavior.

That paragraph was true of the ticker and false of five of its targets until #1846. `expire-stale-requests`, `reschedule-proposals`, `appointment-reminders`, `tentative-occurrences` and `expire-unpaid-trials` all wrote `run: () => core()` — a callback that never receives the request — so the limit was appended to the URL and thrown away, and each tick ran the Actions-sized cohort inside an abort. `appointment-reminders` was the worst of them: its cohort read had no `take` and no `orderBy` at all, in either the ticker path or the Actions one. All five now read the parameter, and each route supplies its own floor through `parseLimitParamOrDefault` so that a caller with no `?limit=` — a hand-rolled `curl`, an operator probe, a future scheduler — is bounded too. A limit enforced by one caller is a limit that disappears with that caller.

The bites are per-target and small relative to each core's own Actions figure. They are budgets rather than drops, and the property that makes them so is worth stating because it is not universal: each is ordered (soonest-first for reminders, oldest-first for the rest), capped, holds no persisted cursor, and writes rows that LEAVE its cohort — `EXPIRED`, `CANCELLED`, a soft-cancel tombstone, or a staged `FailedEmail` for a reminder. A cap on a read with no such exit would silently truncate the backlog on every run.

`appointment-reminders` is the one that is only conditionally resumable, and it says so in the log. The `FailedEmail` row its email twin stages is read back to skip an appointment already reminded for that window, so a re-read of a capped batch is a no-op rather than a repeat — but the cohort has no persisted position, so a window holding more sessions than the cap loses the tail of that window's reminders. The run logs `appointment_reminders_window_capped` when that happens. The alternative — no cap — loses every reminder in a window that overflows an abort, which is strictly worse and much harder to notice.

A tick and a GitHub Actions run of the same job cannot both proceed: both go through the same `withCronLock` every entrypoint already shares, so the loser answers 409. The ticker records a 409 as `lockHeld`, not a failure, because the run that lost the lock is a run that did not need to happen. A target that refuses with a 503 whose body carries the maintenance `phase` — a healthy hold, not a broken target — sorts into the same `held` bucket; a bare 503 with no `phase` marker stays `failed`. Only a response outside `200`, `207`, `409` and a maintenance-marked `503` counts as `failed`.

Three ticker sweeps — `sweep-stuck-webhook-events`, `reconcile-orphaned-confirmations` and `sweep-orphaned-topup-captures` — do move money, but they do it by re-driving a webhook that DEGRADED already exempts rather than by opening a new financial object, so they are deliberately absent from `FINANCIAL_JOB_NAMES` (`lib/cron/financial-jobs.ts`) and keep running in DEGRADED.

GitHub Actions still owns every daily and weekly business cron, but it is **not** a backstop for ticker targets: a job listed in `TARGETS` in `netlify/functions/cron-tick.mts` runs only on the ticker unless a workflow also names it, and `__tests__/maintenance/cleanup-job-scheduler-drift.test.ts` fails for any registry job with no scheduler. Only `alert-orphaned-payments` among the ticker targets is also named in a fleet workflow; the rest have no Actions workflow at all.

## Resumable ledger reconciliation

The ledger auditor uses set-based comparisons inside persisted pages of at most 100 primary entities. `POST /api/cleanup/reconcile-ledgers` advances a bounded slice: 200 with `summary.status: RUNNING` means continuation, while completed results return 200 when clean or 207 for findings. The ticker offers hourly `:55` capacity, yielding to settlement and statutory work at the design bound. Every door shares the fail-closed `reconcile-ledgers` lease, immediately freezes drifted wallets after their page, and retains an unfinished checkpoint for retry. The dedicated admin door advances one bounded slice; the console shows Continue audit until completion and distinguishes failed attempts from completed findings. See [ledger integrity](../finance/20-ledger/06-integrity-and-reconciliation.md).

## Outbox-First Email & Notification Relays

Email and Novu triggers became outbox-first: every transactional email is a `PENDING` `FailedEmail` row before Resend is called, and every Novu trigger is a `NotificationOutbox` row before Novu is called, with one inline attempt under a time budget and a relay for whatever that attempt could not settle.

The two relays are ticker targets with different cadence and different entrypoints. `retry-failed-emails` (`jobs/email/retry-failed-emails.ts`) runs every 15 minutes at offset `:00`; `drain-notification-outbox` (`jobs/notifications/drain-notification-outbox.ts`) runs every 10 minutes at offset `:05` and takes a fail-closed lock. Both walk a backoff ladder and dead-letter a row after five attempts. `drain-notification-outbox` has no Actions workflow, so the ticker is its only scheduler. Both answer 500 when the run reported an error such as an unconfigured provider, so the tick's JSON shows them under `failed` rather than `ok`.

The design and the budgets are in [../notifications/01-architecture.md](../notifications/01-architecture.md).

## The fleet at a glance

The ticker's targets are the `TARGETS` array in `netlify/functions/cron-tick.mts`, with the cadence in `TARGET_EVERY_MINUTES` and `TARGET_OFFSET_MINUTES` and the calendar windows in `TARGET_WINDOWS`; at most `MAX_TARGETS_PER_TICK` fire on one tick. The registry of HTTP twins is `lib/cron/cleanup-registry.ts`, and a job's lock mode is in its core module. The totals are not repeated here because they change whenever a job is added: the mechanical claims on this page are re-derived from source in CI by `__tests__/maintenance/cron-lock-registry.test.ts` and its neighbours. The only schedulers are the ticker and the three non-money GitHub Actions fleets (`cron-daily.yml`, `cron-weekly.yml`, `cron-intra-day.yml`).

## How to read the tables

Every job appears exactly once, grouped by the part of the product it serves. The columns mean the following.

**Schedule** is the effective cadence, which comes from one of two places. For a ticker target it is the per-target `every` and `offset` in `netlify/functions/cron-tick.mts`, rendered as `every N min at :MM`; phase staggering means no five-minute tick fires more than eight targets (`:00` fires seven, every other slot eight), and a tick that fires up to four minutes late still counts as its slot. For a GitHub Actions job it is the raw cron expression in UTC, which you should treat as an upper bound rather than a promise. Minutes are staggered across the fleet so simultaneous starts do not stampede the Supavisor connection pool; **that staggering is maintained by hand, not enforced by CI.** `scripts/ci/check-workflow-hygiene.ts` checks something different — that every `secrets.*` a workflow reads is declared in `docs/enterprise/50-operations/07-required-secrets.md`.

**Entrypoint** is the file the workflow or the registry executes. Every HTTP cleanup twin is served by `app/api/cleanup/[job]/route.ts`, which looks the job up in `lib/cron/cleanup-registry.ts` and enforces `CRON_SECRET` authentication and `assertNotInMaintenance()`. The lock lives on the core so every entry point inherits it.

Each row names the job by its **registry slug**, because the slug is the URL path: `POST /api/cleanup/<slug>` is what you curl to run a job by hand, and what the ticker posts to. Where the slug and the cron **job name** differ, both are shown — the job name is the lock key and the `FINANCIAL_JOB_NAMES` member, so it is what appears in `SystemJobExecution` and in the maintenance gate. Eight jobs differ, for example slug `reconcile-refunds` against job name `reconcile-pending-refunds`.

**Lock** records how the job behaves when the Postgres lease table cannot be reached. A **closed** job refuses to run and pages, on the reasoning that a missed money run is recoverable and a silent unlocked double-run is not. An **open** job runs unlocked with a warning, which is correct for work whose side effects are harmless to repeat. **bespoke** means a hand-rolled `acquireLock` in the payout service, predating the wrapper. **none** means deliberately unlocked.

Both closed and open modes flip to **closed** when the error looks like connection or pool exhaustion. The reasoning is that the pool outage which breaks the lease is precisely the window in which two runners would both believe they held it.

**Financial** reflects membership of `FINANCIAL_JOB_NAMES` in `lib/cron/financial-jobs.ts`. These jobs create or cancel financial objects through an external API, or mutate earnings, payouts and refunds, so a partial deployment can leave them inconsistent.

**During maintenance** is derived from the maintenance gate, not asserted per row. A job that calls `abortIfMaintenance()` exits cleanly when the phase is OFFLINE, and a financial job additionally exits when the phase is DEGRADED.

## Appointments and sessions

These jobs move bookings through their lifecycle and hand back the slots that nobody paid for. They are the fleet's most visible half: when one of them stops, consultees see availability that does not exist and consultants see sessions that never close.

| Job                                                                                                 | Schedule                      | Entrypoint                                                  | Lock   | Financial | Mutates                                                                                                                                                                                                                                               | During maintenance        |
| --------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Auto-complete appointments**<br>`auto-complete-appointments`                                      | ticker, 30 min at `:15` `:45` | `scripts/appointments/auto-complete-appointments.ts`        | open   | no        | `Webinar`, `Consultation`, `Subscription`, `Class`, `Trial` → COMPLETED; `ActivityLog`; Novu. A consultation the consultant never joined is deferred to the no-show detector instead of completed (#1504)                                             | Skips: OFFLINE            |
| **Detect consultant no-shows**<br>`detect-consultant-no-shows`                                      | ticker, 30 min at `:20` `:50` | `scripts/appointments/detect-consultant-no-shows.ts`        | closed | yes       | `Consultation` cancelled and refunded in full through `refundBookingPayment`, slot release, Novu notifications. Auto-complete hands these bookings over rather than racing it (#1504)                                                                 | Skips: OFFLINE + DEGRADED |
| **Expire stale requests**<br>`expire-stale-requests`                                                | ticker, 15 min at `:10`       | `scripts/appointments/expire-stale-requests.ts`             | closed | yes       | Stale `Consultation` and `Subscription` requests expired, refunding SUCCEEDED payments through the refund front door. Seven cohort arms                                                                                                               | Skips: OFFLINE + DEGRADED |
| **Expire unpaid trials**<br>`expire-unpaid-trials`                                                  | ticker, 15 min at `:05`       | `scripts/trials/expire-unpaid-trials.ts`                    | closed | yes       | `Trial` expiry, which frees the held trial slot, and (#1775) a paid trial unanswered for 48 h cancelled and refunded in full                                                                                                                          | Skips: OFFLINE + DEGRADED |
| **Expire reschedule proposals**<br>`reschedule-proposals` (job `expire-reschedule-proposals`)       | ticker, 15 min at `:10`       | `scripts/appointments/expire-reschedule-proposals.ts`       | open   | no        | Expired `RescheduleRequest` proposals; since #1846 the released slots and the parent request's origin status are restored in the same transaction under the appointment lock                                                                          | Skips: OFFLINE            |
| **Clean up tentative occurrences**<br>`tentative-occurrences` (job `cleanup-tentative-occurrences`) | ticker, 15 min at `:10`       | `scripts/appointments/cleanup-tentative-occurrences.ts`     | closed | no        | Soft-cancels tentative `AppointmentOccurrence` holds that no successful payment has claimed, plus a stale-RESCHEDULED arm that releases slot rows                                                                                                     | Skips: OFFLINE            |
| **Appointment reminders**<br>`appointment-reminders`                                                | ticker, 15 min at `:10`       | `scripts/appointments/send-appointment-reminders.ts`        | open   | no        | Reads bookings; stages 24 h and 1 h reminder emails into `FailedEmail` behind a Redis dedup key. Logs `appointment_reminders_window_capped` when a window overflows the cohort cap                                                                    | Skips: OFFLINE            |
| **Settle cancelled sessions**<br>`settle-cancelled-sessions`                                        | ticker, 30 min at `:25` `:55` | `scripts/appointments/settle-cancelled-sessions.ts`         | closed | yes       | A class session the host cancelled 14 days ago with no make-up: one unit refunded per seat that held it, `seatsSettledAt` stamped (#1780)                                                                                                             | Skips: OFFLINE + DEGRADED |
| **Settle platform incidents**<br>`settle-platform-incidents`                                        | ticker, 60 min at `:30`       | `scripts/appointments/settle-platform-incidents.ts`         | closed | yes       | Sessions overlapping a declared `PlatformIncident` are `VOIDED` with outcome `PLATFORM_OUTAGE`; one `IncidentRemedy` per seat applied once its `dueAt` passes, refunds through the refund front door, one digest email per learner and one ops report | Skips: OFFLINE + DEGRADED |
| **Reconcile occurrence availability**<br>`reconcile-occurrence-availability`                        | `17 * * * *`                  | `scripts/appointments/reconcile-occurrence-availability.ts` | open   | no        | Clears `isTentative` on paid occurrences and **detects** double bookings without fixing them; answers 207 when any are found                                                                                                                          | Skips: OFFLINE            |
| **Reconcile orphaned sessions**<br>`reconcile-sessions` (job `reconcile-orphaned-sessions`)         | `25,55 * * * *`               | `jobs/meetings/reconcile-orphaned-sessions.ts`              | none   | no        | `Meeting` closure and slot state, reconciled against Stream video calls                                                                                                                                                                               | Skips: OFFLINE            |

Two of these jobs read the same cohort and must not race. **Auto-complete appointments** and **Detect consultant no-shows** both scan `APPROVED` and `SCHEDULED` consultations whose slots have ended, and only the detector can cancel and refund a session the consultant never joined. Since #1504 they share one attendance predicate: auto-complete defers a booking in the no-show shape until the detector has had its runs, then completes it after `NO_SHOW_HANDOFF_MINUTES`, so a booking the detector declined is never left live forever.

PR #1846 considered three nightly detectors (double charge, missing Stream provisioning, paid-without-seat) and built none: unique indexes make a double charge unrepresentable, `Meeting` rows are minted lazily on first join, and every seat release either auto-refunds inline with a retry marker or records a `PAYMENT` `SystemEvent` when its refund fails.

## Money jobs

The jobs that move or reconcile money (payment and refund recovery, earnings, payouts and their reconcilers, organisation billing and contracts, the statutory exports and the ledger audit) are listed by schedule in [scheduled money jobs](../finance/70-operations/01-scheduled-jobs.md). That page is generated from `netlify/functions/cron-tick.mts`, `lib/cron/cleanup-registry.ts` and `lib/cron/financial-jobs.ts`, so the schedule, the bite size, the timeout and whether DEGRADED maintenance holds the job are not repeated here.

## Compliance

These jobs exist because a statute or a regulator says they must, and their deadlines are external. Skipping one for a maintenance window is cheap; skipping one for a week is not. The statutory money exports (GST register, e-invoice uploader, TDS return draft, MSME alerts) are in [scheduled money jobs](../finance/70-operations/01-scheduled-jobs.md).

| Job                                                                  | Schedule     | Entrypoint                                      | Lock | Financial | Mutates                                                                              | During maintenance |
| -------------------------------------------------------------------- | ------------ | ----------------------------------------------- | ---- | --------- | ------------------------------------------------------------------------------------ | ------------------ |
| **DPDP data-breach deadline alerts**<br>`databreach-deadline-alerts` | `17 * * * *` | `jobs/compliance/databreach-deadline-alerts.ts` | open | no        | Reads only; emails the DPDP officer inbox                                            | Skips: OFFLINE     |
| **Consent retention sweeper**<br>`consent-retention-sweeper`         | `25 0 * * 0` | `jobs/compliance/consent-retention-sweeper.ts`  | open | no        | Counts expired `ConsentArtifact` rows, deleting only when `DPDP_SWEEPER_DELETE=true` | Skips: OFFLINE     |

## Stream and recordings

Chat channels, video sessions and the recordings they produce all live in Stream's systems as well as ours, so these jobs reconcile two sources of truth and move recording files into our own storage before Stream expires them.

| Job                                                                  | Schedule       | Entrypoint                                              | Lock   | Financial | Mutates                                                                                                                                       | During maintenance |
| -------------------------------------------------------------------- | -------------- | ------------------------------------------------------- | ------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Expire recordings**<br>`expire-recordings`                         | `0 3 * * *`    | `lib/stream/recording-retention.ts`                     | open   | no        | `Recording` → EXPIRED past retention, or READY whose Stream copy lapsed uncopied; R2 and preview objects deleted                              | Skips: OFFLINE     |
| **Transfer recordings**<br>`transfer-recordings`                     | `33 */6 * * *` | `lib/stream/recording-transfer-service.ts`              | open   | no        | `Recording` storage path; copies READY Stream recordings into R2, twelve attempts on a backoff ladder                                         | Skips: OFFLINE     |
| **Reconcile orphaned recordings**<br>`reconcile-orphaned-recordings` | `0 3 * * *`    | `scripts/stream/reconcile-orphaned-recordings.ts`       | open   | no        | Re-syncs meetings aged two hours to fourteen days against Stream; past Stream retention the row is reported unrecoverable rather than retried | Skips: OFFLINE     |
| **Stream user sync**<br>`stream-sync`                                | `0 3 * * *`    | `scripts/stream/stream-sync.ts`                         | closed | no        | Stream Chat users soft-deleted when absent from the database; supports `?dry-run=true`                                                        | Skips: OFFLINE     |
| **Expire event chat channels**<br>`expire-event-channels`            | `35 4 * * *`   | `jobs/stream/expire-event-channels.ts`                  | open   | no        | Stream channels frozen then deleted; no database writes                                                                                       | Skips: OFFLINE     |
| **Wind down deactivated orgs**<br>`wind-down-deactivated-orgs`       | `0 3 * * *`    | `jobs/stream/wind-down-deactivated-orgs.ts`             | open   | no        | Ends calls, freezes event and DM channels, revokes tokens, unpublishes recordings for deactivated organisations                               | Skips: OFFLINE     |
| **Stream webhook drift**<br>`stream-webhook-drift`                   | `15 5 * * *`   | `scripts/stream/ensure-webhook-subscription.ts --check` | none   | no        | Nothing. Reads Stream's app settings and fails on drift; exit 2 means real drift, exit 1 means the check could not run                        | **Runs anyway**    |

The recording transfer matters more than its cadence suggests. Stream's copy expires after fourteen days, so a transfer that has been failing persistently alerts only around day ten to twelve, and the loss is irreversible by the time it does. **The `--apply` path is deliberately never automated**, because it calls `updateAppSettings` on a shared production Stream application with no rehearsal environment.

## Housekeeping and platform hygiene

The long tail: janitors, sweepers, retry drains and the watchdogs. Individually none of them is urgent, which is exactly why they are the ones that can stop firing for a month before anyone notices — the failure the heartbeat exists to catch.

| Job                                                                          | Schedule                      | Entrypoint                                           | Lock   | Financial | Mutates                                                                                                                                           | During maintenance        |
| ---------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Retry failed emails**<br>`retry-failed-emails`                             | ticker, 15 min at `:00`       | `jobs/email/retry-failed-emails.ts`                  | closed | no        | `FailedEmail` and `FailedEmailBatch` status, attempts and `resendId`; re-sends the stored message verbatim rather than re-rendering               | Skips: OFFLINE            |
| **Drain notification outbox**<br>`drain-notification-outbox`                 | ticker, 10 min at `:05`       | `jobs/notifications/drain-notification-outbox.ts`    | closed | no        | `NotificationOutbox` status, attempts, `nextRetryAt`, `sentAt`; triggers Novu under the staged `transactionId`                                    | Skips: OFFLINE            |
| **Process data exports**<br>`process-data-exports`                           | ticker, 10 min at `:00`       | `scripts/cleanup/process-data-exports.ts`            | open   | no        | DPDP §11: picks a pending `OrgDataExportJob`, writes a JSON bundle to Supabase Storage, marks it READY with a seven-day signed URL                | Skips: OFFLINE            |
| **Retry moderation enforcement**<br>`retry-moderation-enforcement`           | ticker, 30 min at `:25` `:55` | `scripts/cleanup/retry-moderation-enforcement.ts`    | closed | no        | Re-drives the `ModerationAction` side-effect outbox: Stream bans and revocations, collaborator revocations, erasure revocations                   | Skips: OFFLINE            |
| **Support SLA sweep**<br>`support-sla-sweep`                                 | ticker, 30 min at `:10`       | `lib/support/sla-sweep.ts`                           | open   | no        | Stages acknowledgement and resolution warn/breach bells, org escalations, auto-closes RESOLVED at 28 days, stages T-72h and T-24h dispute notices | Skips: OFFLINE            |
| **Vest referral credits**<br>`vest-referral-credits`                         | ticker, 30 min at `:05`       | `lib/referrals/vesting.ts`                           | closed | yes       | `Referral` QUALIFYING → VESTED or VOID, `ReferralCredit` PENDING → VESTED with the liability journal                                              | Skips: OFFLINE + DEGRADED |
| **Expire referral credits**<br>`expire-referral-credits`                     | `10 3 1 * *` (monthly)        | `lib/referrals/vesting.ts`                           | closed | yes       | Posts expired credits back to the referral-credit liability ledger as breakage                                                                    | Skips: OFFLINE + DEGRADED |
| **Sweep abandoned overage charges**<br>`sweep-abandoned-overage-charges`     | `0 3 * * *`                   | `scripts/cleanup/sweep-abandoned-overage-charges.ts` | closed | no        | `OverageEvent.chargeStatus` → FAILED, parent `Payment.amount` and `PaymentLeg` restore                                                            | Skips: OFFLINE            |
| **Sweep verification**<br>`sweep-verification`                               | `0 3 * * *`                   | `scripts/cleanup/sweep-verification.ts`              | open   | no        | Unlinked `ProfileVerificationDocument` rows and objects; day-7 reminder stamp, NEEDS_INFO → REJECTED at day 14                                    | Skips: OFFLINE            |
| **Prune audit logs**<br>`prune-audit-logs`                                   | `0 3 * * *`                   | `scripts/cleanup/prune-audit-logs.ts`                | open   | no        | `OrgAuditLog` dual-window retention: seven years for invoice, payout, wallet, contract and consent rows; two for the rest                         | Skips: OFFLINE            |
| **Prune system job executions**<br>`prune-system-job-executions`             | `0 3 * * *`                   | `scripts/cleanup/prune-system-job-executions.ts`     | open   | no        | 90-day retention; stamps stranded `RUNNING` rows older than six hours FAILED rather than deleting them                                            | Skips: OFFLINE            |
| **Prune system events**<br>`prune-system-events`                             | `0 3 * * *`                   | `jobs/cleanup/prune-system-events.ts`                | closed | no        | `SystemEvent` retention. Note that the wallet freeze state is derived from the latest `SystemEvent`, which this prune deletes                     | Skips: OFFLINE            |
| **Archive webhook events**<br>`archive-webhook-events`                       | `25 0 * * 0`                  | `scripts/cleanup/archive-webhook-events.ts`          | open   | no        | Processed events at 30 days, failed at 90, terminal outbound deliveries at 30                                                                     | Skips: OFFLINE            |
| **Cleanup auth tokens**<br>`auth-tokens` (job `cleanup-auth-tokens`)         | `0 3 * * *`                   | `lib/auth/cleanup-auth-tokens.ts`                    | open   | no        | Expired `Session`, `Verification` and `IdempotencyRecord` rows; stale pending `Invitation` → EXPIRED                                              | Skips: OFFLINE            |
| **Purge unverified users**<br>`purge-unverified-users`                       | `0 3 * * *`                   | `lib/auth/purge-unverified-users.ts`                 | open   | no        | Never-verified password-only `CONSULTEE` accounts older than seven days with no profile, booking, payment, invoice, referral credit or membership | Skips: OFFLINE            |
| **Purge deleted documents**<br>`purge-deleted-documents`                     | ticker, hourly at `:35`       | `lib/documents/document-purge.ts`                    | open   | no        | Tombstones documents past the retention window, then purges tombstones past the grace period, versions before roots, objects before rows; the ticker sends `limit=100` (route cap 200) | Skips: OFFLINE            |
| **Reconcile document storage**<br>`reconcile-document-storage`               | `0 3 * * *`                   | `scripts/cleanup/reconcile-document-storage.ts`      | open   | no        | `AppointmentDocument.{isStorageMissing, missingDetectedAt}`; finds orphaned objects and rows with no object, answering 207 on a missing file      | Skips: OFFLINE            |
| **Expire stale collaborator invites**<br>`expire-stale-collaborator-invites` | `0 3 * * *`                   | `lib/collaborators/cleanup.ts`                       | open   | no        | Pending invites unanswered for fourteen days → DECLINED via CAS, both parties notified, limit clamped to 50                                       | Skips: OFFLINE            |
| **Expire onboarding drafts**<br>`expire-onboarding-drafts`                   | `25 0 * * 0`                  | `scripts/cleanup/expire-onboarding-drafts.ts`        | open   | no        | Bounded `OnboardingDraft` expiry after 90 idle days; final deletion rechecks `updatedAt`                                                          | Skips: OFFLINE            |
| **Sentry ingest canary**<br>`sentry-ingest-canary`                           | ticker, every 6 hours         | `lib/observability/ingest-canary.ts`                 | none   | no        | Posts one real error event to prove ingest still accepts errors. Alerts by email, never through Sentry, and rides the 70 % quota warning          | Skips: OFFLINE            |

## Jobs that run regardless of maintenance mode

Two scheduled workflows intentionally do not call `abortIfMaintenance()`, because both are read-only external watchdogs rather than work that touches the database:

- **`cron-heartbeat`** — `scripts/ci/check-cron-heartbeat.ts`. The dead-man switch itself. Silencing the watchdog during maintenance would blind operational monitoring during the exact window when schedules are most critical. It is also deliberately **not** in `withCronLock`: a watchdog must not depend on the resource it is monitoring.
- **`stream-webhook-drift`** — `scripts/stream/ensure-webhook-subscription.ts`. Read-only drift verification against Stream's application settings.

Every HTTP cleanup twin dispatched through `app/api/cleanup/[job]/route.ts` calls `assertNotInMaintenance()`, returning HTTP `503` during active windows rather than terminating the serverless process via `process.exit(0)`. The phase travels in the response body, which is how the ticker distinguishes a healthy hold from a broken target.

`auto-complete-appointments` and `detect-consultant-no-shows` have **no GitHub Actions workflow at all** — the Netlify ticker is their only scheduler — and both enforce bounded oldest-first batches so they complete safely within the serverless function ceiling.

## Locking

`withCronLock` (`lib/cron/with-cron-lock.ts`) provides mutual exclusion keyed by job name, backed by a Postgres lease on `SystemJobExecution` rather than a Redis lock. The lease is a partial unique index permitting only one `RUNNING` row per job name. Default TTL is 15 minutes; `LONG_JOB_TTL_MS` is 35 minutes for the payout and reconcile family; `stream-sync` uses 40 and the recording transfer 45. A running job renews every `ttl / 3`, and a failed renewal logs and increments a metric rather than aborting the job.

Every job can be entered via cron schedule, manual `workflow_dispatch`, or authenticated `/api/cleanup/[job]`, and `withCronLock` prevents concurrent side effects while database state transitions remain strictly atomic (CAS-in-WHERE).

Four jobs sit outside the standard wrapper:

| Job                    | Mechanism                    | Reason                                                                                                                     |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `process-payouts`      | `lock:payout_processing`     | Guards both scheduled runs and interactive HTTP batch approval across batches that exceed the default cron lease duration. |
| `create-payout-batch`  | `lock:payout_batch_creation` | Shares the payout batch lock family across multi-step batch creation.                                                      |
| `cron-heartbeat`       | None, deliberately           | Read-only dead-man watchdog over GitHub Actions and Upstash usage; must never depend on lock acquisition to alert.         |
| `stream-webhook-drift` | None, deliberately           | Read-only single-request drift check against Stream application settings.                                                  |

`expire-onboarding-drafts` owns its Postgres lease in the canonical core; it deletes durable rows and is not an unlocked probe. `sentry-ingest-canary` only posts a probe event.

Auth, invitation, draft, webhook and audit retention bounds, final-write predicates and continuation are described in [bounded housekeeping](./housekeeping-bounds.md).

## Watchdogs

Three independent mechanisms verify cron fleet health:

1. **GitHub Actions schedule audit + Upstash quota check (`cron-heartbeat`)** — runs daily at `40 4 * * *`. For every workflow declaring a `cron:` expression it parses the _shortest_ firing interval, derives a tolerance (`max(interval × 12, 6 h)` under 24 h, otherwise `interval × 3`), and fails if the most recent schedule-triggered run is older than that. It also checks monthly Upstash command utilisation against `UPSTASH_MONTHLY_COMMAND_CAP`, warning at 70 % and 90 %.
2. **Sentry cron monitor on the ticker** — the ticker sends one check-in per tick whose status follows whether any target failed. Note the configuration: `checkin_margin: 3` and `failure_issue_threshold: 3` are calibrated for a five-minute tick, so **a fifteen- or thirty-minute target will never trip this monitor**, because three consecutive misses fit inside its normal interval.
3. **External uptime heartbeat (`GET /api/health`)** — every locked job refreshes `cron:heartbeat:last` in Redis, exposed as:

```json
{
  "cron": {
    "configured": true,
    "lastRunAt": "2026-08-14T04:40:12.000Z",
    "stale": false
  }
}
```

`stale` turns `true` once the key exceeds 45 minutes (`"unknown"` with `probeError: true` when Redis itself is unreachable). Both writes and reads are fail-open so health reporting never blocks application traffic.

## Keeping this page true

The mechanical claims here — how many jobs exist, which are locked, which are fail-closed, which are financial, and which have a scheduler — are re-derived from source on every CI run by `__tests__/maintenance/cron-lock-registry.test.ts` and `__tests__/maintenance/cleanup-job-scheduler-drift.test.ts`, so they cannot drift silently. The prose, the **Mutates** column and the group headings are hand-written and need a human to revisit them when a job's purpose changes.

When adding a scheduled job, register its single implementation in `lib/cron/cleanup-registry.ts` for the cleanup and admin doors, use its canonical Postgres lease with an explicit failure policy, and bound work to the runtime. Keep one automatic scheduling owner. Money work belongs on the active platform ticker; GitHub Actions retains configured non-money batch work and CI/CD. Verify eligible cohorts, continuation, domain CAS/vendor idempotency, environment requirements and completion monitoring before enabling a clock. Regenerate the job inventory after registry or schedule changes.

---

## Deprecated & Superseded Approaches

> [!WARNING]
> Do NOT re-introduce these patterns.

1. **Individual single-job cron YAML files.** Every cron job used to have its own `.github/workflows/<job>.yml`, burning roughly 340 GitHub Actions runner starts a day. They were consolidated into the three tiered fleet files (`cron-intra-day.yml`, `cron-daily.yml`, `cron-weekly.yml`) plus `cron-heartbeat.yml` and the read-only monitors.
2. **Duplicate `jobs/<domain>/<name>.ts` wrappers and individual cleanup route files.** `jobs/` once held 45 thin wrappers forwarding to `scripts/`, and `app/api/cleanup/` held 50 individual route files. All HTTP cleanup endpoints are now served by the single dynamic route. The `jobs/` entries that remain are genuine bare-Node entrypoints for jobs that have no HTTP twin, not forwarding shims.
3. **Redis as the cron lock backend.** Replaced by the `SystemJobExecution` lease. Some stale text survives — `CronLockUnavailableError` in `lib/cron/cron-lock-errors.ts` still says the lock "requires a real Redis lock".
4. **The old row-by-row reconciler and background driver.** Replaced by set-based comparisons within persisted bounded pages; the current report checkpoint is active architecture.
5. **CI live-DB drift polling on every `dev` push.** Removed because CI is forbidden from running `db:push` against the shared live database, so polling drift per push paged Sentry whenever a newly merged PR added a sidecar constraint before an operator had pushed it. Drift is now checked daily and read-only by `db-live-drift.yml`.
6. **The `keep-warm.mts` pinger.** Added to fight cold starts, then deleted once disabling Next.js entry preloading removed the stall it existed to fight. `__tests__/lib/next-config-preload.test.ts` actively asserts the file stays absent.
7. **Job names that no longer exist.** `cascade-refund-earnings` and `release-pending-trust-earnings` were separate jobs that have since been folded into the `reconcile-refunds` and `release-earnings` cores, but both names are still listed in `MONEY_CRITICAL_JOBS` in `scripts/ci/notify-ops-failure.sh`, where they can never match. `cleanup-invalid-appointments`, `alert-dispute-deadlines`, `cleanup-empty-folders` and `deactivate-expired-discounts` are gone entirely and appear in no workflow (dispute deadline alerting now runs inside `support-sla-sweep`). Their rows have been removed from this page rather than left to mislead.
