# ADR: Triage of the GPT-6.1 durable-jobs issues

- **Status**: Decision recorded (owner, 2026-10-31). One scope is still pending: the manual-run acknowledgement fix (PR B below).
- **Date**: 2026-10-31
- **Author**: Platform engineering
- **Related**: [Job-runtime experiments and the launch runtime decision](2026-10-31-job-runtime-experiments.md), [Ticker through launch, the scale path, the phase 2 queue and the database plan](2026-10-31-ticker-scale-path-and-queue.md), [Background-job runtime options](../maintenance/14-background-job-runtime-options.md), issues #2488 (durable jobs: runtime choices, failure recovery and costs), #2489 (stage overdue notices atomically with dunning), #2490 (durably accept admin background runs before returning 202)

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
3. **Order after the evidence PR (#2486) merges.** PR A first, then PR B (the manual-run acknowledgement, #2490). PR C is a reminder for after launch: recording-transfer throughput above one item per run, a test that retention never prunes the newest checkpoint-bearing row of a job, and stale ownership docs. Its scope is still pending.

## Pending

- **PR B scope.** Three options were presented: write an ACCEPTED ops row before returning 202 with honest copy, a full durable request table with a worker, or a copy-only change. The owner asked for examples first, so no option is chosen. The reduced option leaves the existing ticker as the recovery path and adds no table, which is what `AGENTS.md` rule 2 favours.

## Consequences

- No code changes follow from this record. PR A and PR B are separate pull requests.
- `AGENTS.md` rule 4 on `dev` already says no GitHub Actions workflow schedules a registry job. The stale ownership text elsewhere (the maintenance README, worker recovery, the start-here and Stream docs, the observability and compliance pages) is corrected in the same docs PR: the ticker owns all of about 76 targets and GitHub Actions keeps only CI, the cron heartbeat, the live-database drift check and the security audit.

## Deprecated & Superseded Approaches

- The issue text's picture of eleven Actions-owned, budget-blocked jobs is superseded by the ticker owning every registered job.
- A durable admission table or a workflow-only state for manual runs is not adopted; it would be a speculative state machine for two self-healing jobs.
