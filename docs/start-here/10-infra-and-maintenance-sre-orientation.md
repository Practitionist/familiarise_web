---
title: Infra and Maintenance — SRE Orientation
type: explanation
band: index
audience: sde1
status: live
last-reviewed: 2026-10-23
---

# Infra and Maintenance — SRE Orientation

The application uses domain rows as durable work queues, one cleanup registry, Postgres job leases, and a Netlify scheduled dispatcher. GitHub Actions still declares a separate non-money batch fleet. Those configured workflows are not evidence of successful execution. This guide describes the implementation on dev at 702f8bcd3; the productionization work and deployment gates are tracked in [issue 2308](https://github.com/Practitionist/familiarise_web/issues/2308).

## 1. Runtime and database boundaries

Netlify runs the Next.js application in Singapore; Supabase Postgres is in Mumbai. The repository requires PG_POOL_MAX=1 on Netlify. This is an application connection-budget policy, not a Netlify-imposed maximum. Multi-request hosts use a bounded shared pool, sized against fleet-wide database capacity.

Inside a Prisma interactive transaction, every helper must use the supplied transaction client. A global Prisma query waits for the connection held by that transaction and can deadlock. Keep external vendor calls outside transactions; commit the durable obligation first, then attempt delivery.

Development and production currently share one Postgres database. A worktree and a deploy preview do not isolate data. Use mocked tests for crashes and concurrency; a real script, refund, deletion or load test can affect production rows. Never apply schema or sidecar SQL autonomously.

| Component             | Responsibility                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Supabase Postgres     | Domain state, money journals, durable delivery obligations, job lease and execution history              |
| Upstash Redis REST    | Request limits, interactive checkout/payout mutexes, maintenance edge state, active scheduler preference |
| Netlify               | Application compute, five-minute scheduled dispatcher, bounded HTTP workers                              |
| Razorpay / RazorpayX  | External capture, refund, dispute, settlement and payout facts                                           |
| Stream                | External session, membership, recording and channel state                                                |
| Resend / Novu         | Email and notification delivery, drained from persisted obligations                                      |
| Supabase Storage / R2 | Private documents, exports and recording objects                                                         |
| Sentry                | Error reporting, ingest canary and cron observation; it does not schedule jobs                           |

## 2. What belongs on the ticker and on Actions

The ticker is the active operational clock. It should drive recoveries, outbox delivery, session outcomes, money jobs and statutory exports in bounded slices. Latency-sensitive work runs frequently; money batch work uses calendar windows. A long worker needs an appropriate execution runtime, while retaining one scheduling owner.

Actions serves repository automation: CI, security, schema/vendor configuration drift and explicitly invoked isolated tests. It is a poor operational dependency for paid bookings and legal deadlines because scheduling and runner availability can be delayed or blocked. GitHub also documents that queued scheduled jobs can be dropped under load.

The current implementation has 67 registered cleanup slugs and 50 ticker targets. The other 17 registered jobs are named in Actions fleet files. Four further Actions jobs have no registry entry: consent-retention-sweeper, databreach-deadline-alerts, expire-event-channels and prune-system-events. Actions therefore still owns important unfinished coverage; it cannot yet be removed wholesale. See the [job reference](../maintenance/04-cron-jobs-reference.md) and the source registry before running a particular job.

The live GitHub API on 2026-10-23 reports the three fleet workflows active, while CI, Race Condition Tests and Knip are disabled manually. Active means enabled, not executing successfully. Sampled execution history and earlier workflow inspection show the fleet stopped on October 18; verify current runner/billing state separately before claiming recovery.

The scheduling path is:

1. Netlify invokes netlify/functions/cron-tick.mts every five minutes on the published deployment.
2. The ticker reads ops:active_cron_platform once, then selects due targets using cadence, offset and calendar windows.
3. It POSTs /api/cleanup/[job] with a bearer CRON_SECRET and the target's bounded limit/window parameters.
4. lib/cron/cleanup-registry.ts selects one core implementation. The route checks authorization and maintenance admission; the core acquires its named Postgres lease.
5. The core claims domain work, applies conditional transitions, stages delivery obligations and records its result.

The current cadence tests bound the largest planned wave to nine targets. MAX_TARGETS_PER_TICK is a tested design limit, not a runtime queue or truncation rule. Arbitrarily keeping the first nine targets would lose work without a fair deferral mechanism. Per-target batch caps also do not prove that every loop, vendor call or retry fits its deadline.

## 3. Three different concurrency protections

| Protection               | Scope                                                                | What it does not guarantee                                                   |
| ------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Postgres job lease       | One RUNNING owner for a job name, enforced by a partial unique index | Sequential deduplication, cross-job exclusion, cancellation after lease loss |
| Row claim / CAS          | A specific domain transition or worker attempt                       | Cancellation of an external request already accepted by a vendor             |
| External idempotency key | A repeatable vendor operation, within that vendor's contract         | Atomic commit across our database and the vendor                             |

The job lease is stored in SystemJobExecution. Acquisition closes expired rows for that job and inserts a new RUNNING row. Renewal advances startedAt; duration uses the original acquisition time held in memory. Default TTL is 15 minutes; individual long jobs override it. A hard kill leaves ownership until expiry. A 409 means admission was denied, not that the owner is healthy or making progress.

Do not reclaim a lease early merely because an HTTP caller timed out. A client abort stops waiting; the worker and its vendor request may still complete. Runtime limits, transport timeouts, persisted attempt identities and conditional publication must work together. Different jobs touching the same booking or payout also need domain CAS, transactional claims and idempotency; distinct job leases do not serialize them.

There are known execution-safety gaps on this baseline: a failed Prisma import can bypass fail-closed acquisition, and finish writes do not check continued RUNNING ownership. The independent execution-safety fix is under review. Until deployed, neither a COMPLETED row nor a refreshed shared heartbeat should be treated as sufficient correctness evidence.

## 4. Durable obligations, fairness and reconciliation

A background recovery should derive work from persisted domain state. Examples include pending gateway payments/refunds, Payment.refundOwedKey, FailedEmail, NotificationOutbox and OutboundWebhookDelivery. A best-effort callback can attempt delivery immediately; a sweep retries the committed obligation after a crash.

Batching works when processed rows leave the cohort. Polling is different: a gateway may truthfully remain pending for days. An unchanged or failing oldest row can monopolize an oldest-first bounded query. Payment/refund/top-up fairness fixes add separate reconciliation cursors; poll progress must not change business age or business retry counts.

Refund attempts are not refund liabilities. A FAILED row records a failed attempt; several can belong to one payment. Existing retry-auto-refunds drives durable refund-owed markers and capture-refund obligations to a bounded retry budget, then leaves them for an operator. The authenticated admin refund door provides reissue with an idempotency key. Confirm current refundable balance, provenance and provider truth before issuing money again.

Reconcilers compare facts that the database cannot enforce together: local state versus Razorpay/Stream/storage, or independently maintained projections versus journals. Postgres already rejects unbalanced journals, invalid funding-leg sums and immutable-ledger edits at commit. Do not build sweeps to re-prove those constraints. The host occurrence exclusion does not protect tentative holds, co-host/client conflicts or attendee seats; those still require application concurrency checks.

The ledger audit currently writes LedgerReconciliationReport and compares journal-derived balances and business projections. It can freeze wallet spending on drift. Its bounded, resumable replacement is under review; an arbitrary recent-history filter would hide old obligations and is not a substitute for checkpoints. Baselines must identify exact known findings, not bless a count that can conceal a new discrepancy.

## 5. Reading outcomes and health

| Signal                             | Interpretation                                                            |
| ---------------------------------- | ------------------------------------------------------------------------- |
| Cleanup 200                        | Inspect the core result as well as transport success                      |
| Cleanup 207                        | Job-specific attention or partial failure; inspect counters and findings  |
| Cleanup 409                        | Another lease owner; investigate persistent overlap or missing completion |
| Cleanup 503 with maintenance phase | Expected admission hold during that phase                                 |
| Cleanup 503 without phase          | Operational failure; investigate state reads or lease acquisition         |
| Ticker 200                         | Dispatcher returned; it does not establish worker success                 |
| SystemJobExecution COMPLETED       | Historical worker result; current legacy result interpretation has gaps   |
| /api/health cron.stale             | Shared liveness hint; one succeeding job can hide many missing jobs       |

The ticker logs failed, held, lockHeld and ok buckets. Its own status is deliberately unsuitable as an uptime probe. The current public /api/health route computes cron staleness without making stale jobs produce a failing HTTP status. Neither is an independent fleet alarm.

The live Sentry cron-tick monitor was still disabled with no recent check-ins on 2026-10-23. The ticker attempts check-ins, but configuration and accepted ingestion must be verified separately. The Sentry ingest canary sends a real event and alerts through email, so the claim that every failure signal depends on Sentry is too broad. Canary delivery and quota can also fail and need testing.

An independent external monitor must check successful completion of required capabilities and alert on absence. The proposed authenticated /api/health/jobs probe uses environment-scoped COMPLETED results so preview activity cannot establish production freshness. It is a separate draft until deployed; calendar jobs, outstanding obligations and backlog age still need their own expectations. A successful dispatch, an empty pass and a drained backlog are different facts.

## 6. Maintenance admission and remediation

OFF, DEGRADED and OFFLINE control request and job admission. Webhooks remain exempt so captured payments can still be recorded. Financial jobs are held during DEGRADED; all cleanup jobs are held during OFFLINE, subject to explicit current recovery paths. Redis state is mirrored to MaintenanceWindow, with database fallback in the application state reader. The cron phase reader currently fails open on an unreadable Redis read; the safety repair changes that behavior.

The current admin activation route is destructive: an omitted phase defaults to OFFLINE, and OFFLINE calls session draining, booking freezing/cancellation and discount pausing inline. Do not treat activation as a harmless access toggle or infer reversibility from changing the phase back. Use the [pre-maintenance checklist](../maintenance/06-pre-maintenance-checklist.md), inspect affected bookings and preserve operator accountability.

The approved replacement separates access admission from booking remediation. Its independent PR requires an explicit phase/reason, and a separately previewed, confirmed, audited, bounded durable booking action. Vendor acknowledgements and recovery progress must survive timeouts. Until that PR is deployed and verified, its safer semantics are not available on the baseline described here.

## 7. Database sidecars and verification

prisma/schema.prisma does not describe every production invariant. Read prisma/sql/check-constraints.sql, ledger-triggers.sql and payment-legs-triggers.sql before changing money or scheduling logic. Partial uniques, exclusion constraints and deferred triggers belong to the SQL sidecars.

Never run prisma db push or npm run db:* autonomously. A schema push can remove SQL-owned indexes, and the current sidecar runner commits statements separately; a failed ADD after a committed DROP can leave protection absent. The maintenance PR makes dependent replacements atomic under short lock timeouts. New reader columns must exist before preview/deployment; checked-in SQL is not evidence of application.

Local verification uses targeted mocked Jest suites, TypeScript, lint, changed-file formatting and CodeRabbit review. A full-project check blocked by dependencies or memory must be reported as incomplete. Production readiness additionally requires accepted monitor check-ins, independent alert delivery, bounded backlog progress, schema verification and isolated recovery/failback drills.

## 8. Hosting and cost decisions

Keep Netlify as the active host while establishing reliable scheduling and observation. Vercel or Cloud Run can improve database locality, but neither repairs missing job ownership, incorrect outcomes or absent alerts. Measure end-user latency, query count, connection pressure, job duration and provider bills before choosing a host.

Vercel migration requires a protected platform cron adapter, supported worker duration, bounded shared pool, direct large-file storage transfers, host-scoped IP trust, auth/origin/secret parity and a verified failback drill. Keep the Netlify adapter and configuration intact. The [failback runbook](../deployment/emergency-failback-runbook.md) describes the implemented scheduler preference and its limits.

The linked Netlify account API was rechecked on 2026-10-23: Practitionist-Deploys reports orb-pro, credit_features.included=false, functions.included=125000, functions_gb_hour.included=1000 and background_functions.included=true. Capability fields are not current billed usage. SystemJobExecution rows are not invocations: one abandoned-payments call acquires the same named lease three times; lock losers, initialization failures and the ticker itself also distort counts. Minute-deduplication is an estimate, not a billing meter.

Use Netlify's actual usage and invoice for budget decisions. Current general documentation distinguishes legacy request billing from credit-based compute and web-request meters; this account's explicit capability grants still require deployed feature verification. Do not change plans or disable recovery cadence solely from an audit's arithmetic.

## Where to read next

- [Job inventory](../maintenance/04-cron-jobs-reference.md), [reconciliation reference](../maintenance/10-cron-and-reconciliation-reference.md) and [state-as-outbox ADR](../enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md).
- [Maintenance phases](../maintenance/02-degraded-vs-offline.md), [Netlify operations](../deployment/netlify.md) and [deployment portability](../deployment/README.md).
- Official [Netlify limits](https://docs.netlify.com/build/functions/configuration/), [billing models](https://docs.netlify.com/build/functions/usage-and-billing/), [background functions](https://docs.netlify.com/build/functions/background-functions/), [GitHub scheduling caveats](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) and [Vercel cron behavior](https://vercel.com/docs/cron-jobs/manage-cron-jobs), checked 2026-10-23.

## Deprecated & Superseded Approaches

**Redis cron locks.** Cron exclusion now uses the Postgres RUNNING-row unique. Redis still serves interactive mutexes and operational preference/state, so removing Redis entirely would break current request flows.

**Daily money work on Actions.** The ticker already owns payouts, invoicing, contracts and statutory exports in calendar windows. Older diagrams assigning these to Actions are obsolete. Non-money coverage remains a migration task; deleting the fleet files before a replacement proves progress would lose execution.

**Two automatic clocks as a backstop.** A shared lease blocks overlap but does not stop sequential duplicate effects. Cut over one job family deliberately, verify its worker effects and disable its old automatic clock. Preserve manual recovery through the canonical implementation.

**An absent fleet switch.** ops:active_cron_platform exists in the ticker. The opposite claim was incorrect. It is read once per tick with a one-second timeout and fails open; it cannot cancel in-flight work, guarantee exclusivity during Redis failure or promise a sub-millisecond failover.

**Keep-warm requests and generic work probes.** Entry-preloading configuration replaced the old cold-start pinger. Adding a duplicated SQL cohort probe or generic queue would introduce another correctness boundary without repairing the known execution gaps.
