# ADR: Admin background runs are durable requests, dispatched at once with the ticker as backstop

- **Status**: Accepted on 2026-11-01. Ships in the pull request that adds this record.
- **Date**: 2026-11-01
- **Author**: Platform engineering
- **Related**: [GPT issue triage, decision 4](2026-10-31-gpt-issue-triage.md), [The ticker skips targets that have no work](2026-11-01-ticker-skip-idle-targets.md), [Job machinery catalog, section 2.7](../maintenance/11-job-machinery-catalog.md#27-admin-run-requests-dispatch-now-the-ticker-as-backstop), issue #2490 ("Durably accept admin background runs before returning 202")

## Context

The System Jobs page's "Run now" door (`POST /api/admin/system-jobs/run`) runs most jobs inline and answers with the run's outcome. Two jobs, `create-payout-batch` and `process-payouts`, are registered `manualRun: "after"`, because a payout run makes a gateway call per row and would meet the edge timeout. For those, the route used to register a `scheduleAfter` callback and answer 202 "Started in the background" before anything was written. The audit row was written only after the run returned. If the instance stopped before or during the callback, there was no request, audit row or run row to recover, and nothing retried the admin's run. `after()` is best-effort on Netlify: the invocation's execution ceiling still counts it, and a crash ends it.

The review on the issue added five constraints for any fix. The original admin must stay the actor on every retry, because the payout services use that actor for maker-checker. The admitted calendar window must be replayed, not recomputed. A crashed claim must be recoverable, and a stale claimant must not be able to settle a newer claim. The claim must commit before the job runs, with no transaction held across the run. A job outcome is not the same as a transport success.

## Decision

The owner chose the full durable request table, with "dispatch now, the ticker as backstop".

1. **`AdminRunRequest` model** (`prisma/schema.prisma`). Its fields are `id`, `job`, `status` (`REQUESTED`, `CLAIMED`, `DONE`, `FAILED`), `requestedBy`, `attempts`, `lastError`, `windowStart`, `createdAt`, `updatedAt`, `claimedAt`, `finishedAt`, `runId` and `idempotencyKey`. Two fields go beyond the issue's list. `windowStart` lets a late attempt replay the admitted window. `idempotencyKey` (owner decision, a client idempotency key) is unique per job through a Prisma `@@unique([job, idempotencyKey])`, so `db push` creates it and no sidecar is needed. The request's id is also the id of its `OpsActionLog` row. Every run of the request records that id as `result.opsActionLogId`, which links a run row back to its request.
2. **Sidecar** (`prisma/sql/check-constraints.sql`). The partial unique index `admin_run_request_one_open_key` allows one `REQUESTED` or `CLAIMED` row per job. The CHECK constraint `admin_run_request_state` requires `attempts >= 0`, a `claimedAt` on a claimed row and a `finishedAt` on a settled one. `db push` drops both, so `npm run db:sidecars` re-applies them.
3. **Admission before the 202.** The route commits the request row and its audit row in one transaction, answers 202 with the request id and the word "queued", and only then dispatches with `scheduleAfter`. The "Run now" button mints one UUID per click and reuses it when the same dialog retries; the route validates it with Zod and mints one itself when an older client omits it. A retry with the same key returns its original request in any status and never schedules again. A new click carries a new key, so it is a new run once the earlier request has settled; while a request is open, the open-row index still returns that request.
4. **Claim, run, settle** (`lib/cron/admin-run-requests.ts`). Each claim is an `updateMany` that matches the expected `status` and `attempts`, and it increments `attempts`. The job runs in-process through the registry handler, as `admin:<requestedBy>`, with the admitted window. The settling write matches `status = CLAIMED` and that attempt's own `attempts`, which fences out a stale claimant. Outcomes `completed`, `attention` and `partial` settle DONE, and `failed` settles FAILED. A partial run keeps `Run partial (HTTP 207)` in `lastError`, so the console never shows it as a clean DONE. In the same transaction as a settling write that won its CAS, the request's `OpsActionLog` row (same id) moves to the run's audit status (`SUCCEEDED`, `PARTIAL`, `FAILED`, or the stand-down in capitals), with the same mapping as an inline run, and keeps `requestId`. A released retry leaves it at `REQUESTED`. A stand-down (held, skipped, refused, paused) or a thrown dispatch returns the row to REQUESTED until three attempts are spent.
5. **Ticker backstop.** `drain-admin-run-requests` runs hourly at :40 and has an idle probe. It reclaims rows left REQUESTED for over 2 minutes and rows CLAIMED for over 15. A stale claim whose run already finished settles from that run instead of running again. After three attempts the row is FAILED with `lastError`.
6. **DONE/FAILED linkage.** The worker that ran the attempt settles it directly from the response's `X-Run-Outcome` header. That is the simplest correct hook, because the worker already holds the outcome and the claim token. The drain falls back to reading the `SystemJobExecution` row only for a claim whose worker died. No run-record code path changes.
7. **Console.** The System Jobs page lists the last ten requests and polls every 5 seconds while one is open.
8. **Retention.** Settled rows are telemetry and are deleted 30 days after `finishedAt`, as one more page of `prune-system-job-executions`. No new job is added for this.

## The cadence trade-off

The brief asked for a five-minute drain, but no cadence shorter than an hour fits. The busiest ticks already carry 11 targets, and the cadence test pins 11 as the maximum under `MAX_TARGETS_PER_TICK` = 12. A simulation over 400 days found that every 5-, 10-, 15-, 20- and 30-minute cadence, at every offset, puts some tick at 12. Only hourly offsets 40, 45 and 50 fit, so the drain runs at :40, away from `process-payouts` at :00.

Because the route dispatches immediately, the drain only recovers lost dispatches and crashed claims, and it does so within about an hour rather than about 2 minutes. Both payout jobs also run on their own schedules, so their business backlog never waits on the drain. Raising the cap or rebalancing other targets' offsets would allow a faster drain, and both are owner decisions.

## Delivery contract

An accepted request is executed at least once per attempt and attempted at most three times. A crash after the job's domain writes but before settlement can run one more bounded slice. That slice is safe because of the job's own lease, CAS writes and gateway idempotency keys, not because the request id is unique. A client retry of the same click never starts a second request, because it carries the same idempotency key. A failed run is not re-run automatically, so a money slice that failed waits for its schedule or a new click.

## Options considered

| Option                                                             | Verdict      | Reason                                                                                                                                       |
| ------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Full durable request table, immediate dispatch, ticker as backstop | **Selected** | An acknowledged run is always a persisted run, a lost dispatch is retried, and the console can show the status. It adds no second scheduler. |
| An ACCEPTED ops-log row only, with honest copy                     | Rejected     | It is smaller and adds no table, but it only makes a lost dispatch visible. Nothing retries it.                                              |
| Copy-only change ("queued" instead of "started")                   | Rejected     | A lost dispatch would still leave no trace.                                                                                                  |
| Ticker-only pickup (no immediate dispatch)                         | Rejected     | Every manual run would wait for the drain, which is hourly under the cap.                                                                    |
| Synchronous run inside the request                                 | Rejected     | A payout run makes a gateway call per row and would meet the ~26 s edge timeout. That timeout is why these jobs are `manualRun: "after"`.    |

## Consequences

- **Schema change during the freeze.** The change is additive (one table, one enum and the `(job, idempotencyKey)` unique index, all in the same `db:push` preflight) and was accepted by the owner. The owner runs the `db:push` preflight and `npm run db:sidecars` before deploying. Until then, the route's insert fails on a missing table and the console list answers 500.
- **Ticker count.** The ticker now has 77 targets, about 2,897 starts a day (about 84 % of 3,456 slots). The busiest tick still has 11 targets. Idle ticks of the drain cost no invocation.
- **Scope.** Background-worker jobs (`transfer-recordings` and the Stream lifecycle jobs) keep their existing path. Their admission already returns 202 from the worker after the audit row is written, and a failed admission answers 500 inline, so they have no lost-dispatch gap.

## Deprecated & Superseded Approaches

- The `manualRun: "after"` branch that answered 202 from an unpersisted `scheduleAfter` callback, with its ops-log row written only after the run, is gone. Do not reintroduce a 202 for a deferred admin run before its request row commits.
