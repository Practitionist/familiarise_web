# Worker contracts

Per-worker contracts moved out of the jobs index. Each paragraph states a rule that still binds the named worker. Support attachment cleanup and support auto-close are in the `support` skill, and the compliance retention windows are in the `compliance` skill (`references/retention-windows.md`).

Recording transfer is ticker-owned every 15 minutes through its existing background adapter. Keep 202 admission separate from successful core completion. Its requested fail-closed 15-minute lease is capped on Netlify at 90 seconds, renewed every 30 seconds; renewal loss does not cancel the core, so preserve domain claim and publication fencing. The recording's stale-claim threshold remains 15 minutes. Session recovery runs via HTTP at :10/:40. The five daily lifecycle targets queue the narrow `stream-maintenance-background` worker in staggered daily windows; their Actions steps are removed. All six migrated cores fail closed, and each daily lifecycle job has a 28.5-hour freshness budget. See `docs/stream/09-background-sync.md` for slice bounds and continuation.

Appointment reminders require a Postgres lease before staging email. If lease
acquisition fails, the run fails without delivery; the next ticker run retries
within the existing reminder window. Staged email reads prevent sequential
replay, but do not provide atomic deduplication for overlapping unlocked runs.

Support attachment cleanup and auto-close progress: see the `support` skill (the attachment and auto-close gotchas).

For shared storage deletion, preserve `removeObjects()`'s receipt-or-`NoSuchKey`
metadata contract. The installed SDK can return `exists().data=false` for an
ambiguous HTTP 400; this deployment also uses 400 for a genuine missing key.
HTTP status or that boolean alone is insufficient. Preserve caller retry/error
handling when confirmation fails. Plan-material removal commits its row first,
so unresolved vendor cleanup remains a separate obligation; see
`docs/storage/management-strategy.md`.

Maintenance bypass cookies remain short-lived HMAC-SHA256 tokens verified via Web
Crypto. Follow the active maintenance implementation and recovery instructions;
never infer that a cached phase quiesces work already in flight. See the linked
references for transaction-client, deployed-runtime and environment constraints.

PATCH updates require a validated non-empty reason, including ETA-only changes; use that value for incident and audit text. Maintenance retries preserve the active window's configuration and repeat OFFLINE setup until its completion stamp exists. Recovery checks database, Redis and chat before incident resolution and phase change. Preserve sequential session and channel-batch admission checks, paced vendor batches, transaction-client writes and ordered sidecar statements; a loop await is required when the next step depends on its predecessor or remaining budget.


Revalidate a confirmed booking’s live overlap inside the cancellation transaction before loading its full graph. Bootstrap missing maintenance edge state from the durable platform state before deploying fail-closed readers; never overwrite an active window with OFF. The release owner applies the exact reviewed SQL and performs the conditional no-TTL edge bootstrap immediately before merge; coding agents do not perform either operation. Unreadable-state GET protection on checkout verify applies only to `sync=true`, because the plain status poll is read-only.

The 48-hour paid-unallocated arm of `expire-stale-requests` commits EXPIRED,
history, `sub-unalloc:<paymentId>` full-refund markers and its bell together.
It stages new obligations only in a winning current expiry transaction; it
never stamps already-expired unmarked rows. Keep existing markers/attempts, hold an oversized payment envelope
without partially expiring its liabilities, and preserve visible backlog on
errors or deadline truncation. Exhausting only the remaining invocation allowance
is a deferral, not an envelope error; stop the ordered page for the next run. Its shared 16-second admission budget covers
only this family; earlier expiry arms and nudge fairness remain separate work.
Do not describe the entire worker as deadline-bounded or its backlog as drained. `unallocatedHasMore` includes retired/foreign-owned obligations needing operator review; it is not a signal to keep automatically driving retries.
When extracting these phases, retain the same deadline closure and ordered fresh
payment allowance; keep earlier staged markers available for the delivery phase.

Raw SQL must follow Prisma's physical `@map`/`@@map` identifiers; the subscription
status column is `requestStatus`. Derive disposable SQL fixture identifiers from
the generated schema metadata, and verify query planning read-only before making
production capacity claims.

## Worker recovery contracts

Credit-note and bank-receipt adjustments retain invoice checkout references for
gateway inspection, including bank-paid invoices. Retire only the exact inspected
PAID pointer with its audit after captured liability commits or an empty/unpaid
order is confirmed. Provider reads stay outside transactions and within the
existing budget. An empty read does not revoke an old checkout; audit history is
for operators, not an automatic recovery queue.

Read [worker recovery](../../../../docs/maintenance/12-worker-recovery.md) before changing export claims, artifact expiry or booking-expiry refunds. Export attempts use the exact `startedAt` token for claim and finalization CAS, an independently retained exact storage owner before upload, and immutable paths. Preserve READY with its audit and existing notification outboxes; never let postcommit delivery write FAILED or expose raw errors. Its logs carry only operation/export identifiers, never provider exceptions or transport payloads. Expiry requires successful exact remote absence evidence before retiring the owner. The operator applies only the reviewed additive schema before deploying the new reader. The cutover resets mock data; never adopt old artifact pointers or retrospectively stage old expiry rows.

Pending-consultation and approved-unallocated expiry commit full-remaining owed-refund markers in the same transaction as the winning EXPIRED transition. Reuse existing arm keys and refund retry ownership. Unpaid pending-subscriptions still exclude successful payments; do not broaden money eligibility. Completion freshness for these workers is not proof of backlog drain or actual alert receipt.

Keep a short marker-count race local to its request: roll back its transition and
history, preserve the competing writer's marker/retry state, and continue later
requests. Existing partial markers also hold only their own request; retain
their fields and exhausted retries, and report the aggregate hold as unsuccessful
completion while later requests proceed. Exclude these holds before the oldest
page limit, checking their presence after selection and rechecking each request
transactionally for races.
Do not turn unrelated staging failures
into successful skips. Preserve retry of already-persisted obligations without
creating retrospective markers from old expiry history. Export
expiry requires exact metadata `NoSuchKey` after removal; a generic 404 or an
`exists()` false value with an error is insufficient. Download lifetimes use a
fresh post-lookup clock and must be rechecked after signing and audit latency.

Invoice capture recovery runs through the registered `reconcile-org-invoice-payments` core, its fail-closed Postgres lease and execution-result checkpoint. It rotates at most five retained order references per four-hour slot, with ten-second row admission and five-second provider waits. Existing settlement stages durable notices; relays deliver them. Preserve the six spare calendar slots and test every tick across 400 days when changing this schedule. Twelve-hour completion health is execution evidence, not a per-invoice recovery SLO; lost order references and cohort capacity remain separate gates. See `docs/maintenance/12-worker-recovery.md` and `13-readiness-and-operating-gates.md`.

Destructive retention must be bounded for every caller, repeat eligibility in the final write, and preserve active obligations and retention timestamps. See [job history and messaging retention](../../../../docs/maintenance/messaging-retention.md): a page per table per call, at most 500 rows per page (run history drains in 1,000-row batches within the budget), a shared 16-second caller start budget across driver slices and lease admission, and explicit `hasMore`. A missing heartbeat is not proof that an old process has stopped. Verify concurrency with the guarded disposable database tier; never run it against the shared database.

Auth tokens/invitations, webhook archive, onboarding drafts and audit retention have bounded canonical defaults and a shared 16-second admission budget per invocation. Every destructive write repeats current age/status eligibility. Read `docs/maintenance/housekeeping-bounds.md` for per-phase versus global limits, continuation and the existing bounded audit CLI. Keep deadline checks before continuation probes and process organisation transactions sequentially so the next admission check includes prior commit time. Preserve category retention and expiry policy; a work bound is not permission to shorten retention. The windows are in the compliance skill's `references/retention-windows.md`; fold a new prune into `prune-audit-logs` or `prune-system-job-executions` instead of adding a ticker target, and never prune a live booking's `BookingStatusHistory` rows. Failures or time-budget holds retain `hasMore`; a failed oldest page needs repair rather than silent skipping.

Auth-token Verification and IdempotencyRecord pages and the audit pages share `deleteBoundedPage`: preserve the shared start budget, caller-owned eligibility predicates and committed counts when the continuation probe fails. The auth-token Session and SessionAccessLog phases drain 100-row pages until one is short, one fails or the budget is spent (no probe; `hasMore` only on a budget stop or failure), and a Session page is deleted and its removed rows stamped in one transaction, which a failed stamp rolls back. `archive-webhook-events` instead repeats 2,000-row `DELETE ... WHERE id IN (SELECT ... LIMIT n)` batches until one is short or the budget is spent, like run history.

## Direct upload commit retries

For plan-material commits, check session, rate limit, current plan-management access and payload/file policy before replaying by plan type, plan ID and storage path. Return committed rows before storage probes. Pre-verification policy rejection preserves the upload: a corrected concurrent retry may commit it, and a reference count cannot fence external deletion. Keep the committed-row lookup outside cleanup catches so database errors preserve the upload too. First-attach verification stays outside the transaction, inside its existing refusal-cleanup try/catch; the locked transaction repeats replay before the material cap and insert. Run the full document suites and direct mock dependants with `--maxWorkers=2`; see `docs/documents/README.md` for the replay and orphan-cleanup limits.
