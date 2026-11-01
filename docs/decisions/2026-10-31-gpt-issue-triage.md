# ADR: Triage of the GPT-6.1 durable-jobs issues

- **Status**: Decision recorded (owner, 2026-10-31). The scope of the manual-run acknowledgement fix (PR B) was chosen later the same day: a full durable request table.
- **Date**: 2026-10-31
- **Author**: Platform engineering
- **Related**: [Job-runtime experiments and the launch runtime decision](2026-10-31-job-runtime-experiments.md), [Ticker through launch, the scale path, the phase 2 queue and the database plan](2026-10-31-ticker-scale-path-and-queue.md), [Background-job runtime options](../maintenance/14-background-job-runtime-options.md), issues #2488 (durable jobs: runtime choices, failure recovery and costs), #2489 (stage overdue notices atomically with dunning), #2490 (durably accept admin background runs before returning 202), #2492 (job backlog starvation)

## Context

Three issues written by the GPT-6.1 model were posted to the repository: an architecture issue on durable jobs (#2488, with five appendix comments) and two focused issues split from it (#2489 and #2490). Their claims were validated against `origin/dev` and against the measured evidence of the 2026-10-31 job-runtime experiments. The issue text cites a snapshot of the booking-megafix branch, which is not an ancestor of `dev`, so some of its facts are stale.

## Validation result

About 11 claims were confirmed, 1 was wrong, 3 were superseded or only partly confirmed, and 5 were unverified.

- **Confirmed.** The first overdue notice is staged after the transaction that moves an org invoice from ISSUED to OVERDUE commits (`dunning()` in `jobs/billing/dunning.ts`), so a crash between the two loses it. The stage-one selector requires `markedOverdueAt: null`, so a transitioned row is never re-selected. The loss is bounded, because stage two later sends a reminder about 7 days late. A roster read failure in the email path is also swallowed and dropped without a retry. Admin manual runs for jobs with `manualRun: "after"` return 202 before any audit row is written, but only two jobs use that mode (`create-payout-batch` and `process-payouts`), and both also run hourly on the ticker, so a dropped nudge self-heals. Recording transfer takes one item per 15-minute run. The Netlify lease cap, the 12-targets-per-tick cap, the two native background adapters and the RazorpayX egress-proxy refusal all match the code.
- **Wrong.** The claim that 11 registered jobs sit outside the ticker, owned by GitHub Actions, with 65 ticker targets, came from the stale branch. On `dev`, all 11 are ticker targets in `lib/cron/schedule.ts`, and `.github/workflows` has no cleanup schedulers; it schedules only the cron heartbeat, the live-database drift check and the security audit.
- **Superseded or partly confirmed.** Non-production runs are now refused on `dev` (`jobsMayRunHere` in `lib/cron/dispatch-refusal.ts`). Missing a whole calendar window has no automatic backfill, but whether that matters per job is unverified. Lease-renewal loss is observed but not traced to an abort.
- **Unverified.** The dispatch-volume arithmetic (it used the stale 65-target catalogue), the paging-requirement counts, the vendor facts taken from web research without an experiment, and the cost sensitivities, which are rate-card arithmetic and not bills.
- **Against measurement.** The issues rank a QStash pilot and Netlify Async Workloads highly. Measured: QStash EU delivers in a median 1.37 s, redelivers at about 12 s, 160 s and 33 min with three side effects from one message, and publish-after-commit leaves a row without a message. Async Workloads delayed work 50 to 94 s late and repeated steps in a crash run. Netlify Singapore costs 62 to 64 ms per statement, a number the issues never use.

The full review is kept with the working papers. This record keeps only the outcome.

## Decisions

1. **The org invoice rail is not live at launch.** The fix for #2489 (PR A: stage the overdue bell and email inside the winning OVERDUE transaction, and fix the swallowed roster error) gates enabling org invoicing. It is not a launch blocker, because nothing sends org invoices until the rail is enabled. Enforcer: the rail stays off until PR A merges.
2. **No QStash or second-scheduler pilot before launch.** The Netlify decision stands: the ticker plus Background Functions for jobs over 30 s ([the job-runtime decision record](2026-10-31-job-runtime-experiments.md)). A second trigger layer would conflict with `AGENTS.md` rules 1 and 4. A validation comment was posted on #2488.
3. **Order after the evidence PR (#2486) merges.** PR A (#2489) first, then PR B (#2490). PR C is filed as issue #2492 (job backlog starvation: recording-transfer throughput above one item per run, a test that retention never prunes the newest checkpoint-bearing row of a job, and a per-job throughput and poison-row audit) and comes after launch.
4. **PR B uses the full durable request table.** The admin "Run now" route inserts a request row and returns 202. The ticker, or the background worker, claims the row and retries it until it reaches a terminal state, and the UI polls its status.

## PR B design (decision 4)

The shape is a new `AdminRunRequest`-style model with a status that moves REQUESTED, then CLAIMED, then DONE or FAILED, plus `attempts` and `requestedBy`. The flow has four steps.

1. The admin route (`app/api/admin/system-jobs/run/route.ts`) inserts the request row, then returns 202, so an acknowledged run is always a persisted run.
2. The existing ticker, or the background worker, claims a row with a compare-and-swap-in-WHERE update from REQUESTED to CLAIMED, as `AGENTS.md` section 2.2 requires for status transitions.
3. It runs the job through the registry handler, which still takes the job lease (`withCronLock`), and retries the request until it reaches DONE or FAILED. `attempts` bounds the retries.
4. The console polls the row's status.

The constraints are these.

- **Schema change during the schema freeze.** The freeze is the launch gate. The owner accepted the change, so it goes through the human-run `db:push` preflight, and nobody runs `db push` autonomously (`AGENTS.md` section 2.3).
- **Sidecar for integrity.** Any status CHECK constraint or partial unique index, for example one open request per job, lives in a `prisma/sql/` sidecar, because `db push` would drop it otherwise.
- **Not a second scheduler.** The existing ticker drains the table. No new cron, no Redis lock and no workflow engine (`AGENTS.md` rules 1, 2 and 4).

Alternatives rejected, with reasons:

- **An ACCEPTED ops row plus honest copy.** It is smaller and adds no table, but a lost dispatch only becomes visible. It is not retried.
- **A copy-only change.** It leaves a lost dispatch invisible.

## Consequences

- No code changes follow from this record. PR A and PR B are separate pull requests; PR B needs a reviewed schema change.
- `AGENTS.md` rule 4 on `dev` already says no GitHub Actions workflow schedules a registry job. The stale ownership text elsewhere (the maintenance README, worker recovery, the start-here and Stream docs, the observability and compliance pages) is corrected in the same docs PR: the ticker owns all of about 76 targets and GitHub Actions keeps only CI, the cron heartbeat, the live-database drift check and the security audit.

## Deprecated & Superseded Approaches

- The issue text's picture of eleven Actions-owned, budget-blocked jobs is superseded by the ticker owning every registered job.
- A workflow-only state for manual runs is not adopted. The durable request table is the owner's chosen design for PR B; the smaller ACCEPTED-row option was rejected because it does not retry a lost dispatch.
