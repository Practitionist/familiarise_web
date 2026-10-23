# Bounded housekeeping

These workers preserve existing retention and expiry policy while limiting each invocation. Their single implementations are registered in `lib/cron/cleanup-registry.ts` and served through the cleanup/admin doors. No new clock is enabled. Existing Actions workflows retain their configured ownership; actual successful progression must be verified independently.

| Core / cleanup slug                                                        | Existing policy                                                                                                       | Slice bound                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `lib/auth/cleanup-auth-tokens.ts` / `auth-tokens`                          | Expired Verification, Session and IdempotencyRecord; lapsed PENDING invitations                                       | Up to 100 selected rows per arm, including invitation attempts; maximum explicit limit 500        |
| `scripts/cleanup/expire-onboarding-drafts.ts` / `expire-onboarding-drafts` | Draft idle for 90 days                                                                                                | Up to 100 selected drafts, maximum 500                                                            |
| `scripts/cleanup/archive-webhook-events.ts` / `archive-webhook-events`     | Processed and terminal unreplayable events 30 days; other failed events 90 days; terminal outbound deliveries 30 days | Up to 100 per each of four phases, maximum 500 per phase                                          |
| `scripts/cleanup/prune-audit-logs.ts` / `prune-audit-logs`                 | Existing category lists:7×365 days financial/compliance and 2×365 days operational                                    | Up to 100 eligible audit rows globally, maximum 500; group only that bounded page by organisation |

The limits apply in the core, including callers that omit `?limit=`. HTTP dispatch passes its request start time through the core. Every invocation shares a 16-second start budget across reads, mutation phases and invitation/organisation attempts. Once it expires the worker admits no new database work. An already running statement or transaction may still finish or reach its own timeout; the budget is not cancellation. Audit transactions have a separate 8-second timeout.

## Concurrent refresh and replay

Selection alone grants no deletion authority. Final writes repeat expiry, age, status/category and the selected IDs. A session or idempotency row refreshed after selection survives; a draft saved after selection survives; a webhook delivery requeued from a terminal status survives. These predicates protect cross-job changes independently of the worker’s lease. PostgreSQL rechecks the search condition after a concurrent row update at Read Committed. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

Invitation expiry retains its PENDING/expiry conditional update and atomic INVITE_EXPIRED audit. Audit pruning commits each organisation’s selected eligible deletes with its AUDIT_PRUNED summary in one transaction, through `tx`. Counters change only after commit; a failed commit cannot claim a written summary or deleted rows. No retention policy or legal classification is changed by this work bound.

## Continuation and evidence

After a phase, a bounded existence read checks remaining eligible work. `hasMore` is also true when an error or deadline prevents checking or processing later work. It is continuation evidence, not an exact backlog count or a snapshot guarantee against later arrivals. Results preserve already committed counters when a later read fails. Auth/archive phases and audit organisations isolate failures and continue while the shared budget remains.

The existing `jobs/cleanup/prune-audit-logs.ts` Actions entrypoint calls the same core for at most 40 slices of 500, sharing one 16-second start budget and stopping on failure or zero deleted rows. Its structured log retains `hasMore`; it never announces an unbounded drain. Removed unused GITHUB_OUTPUT formatting after checking the workflow consumes only the step outcome. No new wrapper or scheduling owner is introduced.

A persistent failure in the oldest page can hold later work beyond that page. The worker reports failure/continuation rather than inventing a durable cursor, changing eligibility or skipping evidence. Operators must repair that fault and measure oldest eligible age and throughput before claiming coverage or handing scheduling ownership to another platform. Daily/weekly cadence plus bounded capacity must match actual arrival rate; this PR does not establish that SLO from configuration alone.

Tests cover selected-page bounds, refreshed-row preservation, replay eligibility, shared deadlines, isolated failures and committed summary counters with mocked database boundaries. They do not establish deployed throughput, live deletion, or provider effects. No shared-data retention run is part of validation.

## Deprecated & Superseded Approaches

These workers formerly used unbounded deleteMany/groupBy scans, and onboarding expiry lived inline in the registry. The canonical onboarding core now owns both its bound and lease. Omitting a limit no longer requests an unlimited backlog. An execution lease alone was never a substitute for the final eligibility predicate or atomic audit evidence.
