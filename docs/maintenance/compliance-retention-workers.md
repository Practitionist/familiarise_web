# Compliance and event-retention workers

The cleanup registry exposes consent-retention-sweeper, databreach-deadline-alerts and prune-system-events. The authenticated cleanup route and ADMIN System Jobs door call the same leased domain implementations. The existing Actions fleet steps remain the automatic scheduling owner of the consent and breach workers; `prune-system-events` is a ticker target (hourly at offset 10, in the 20:00 to 23:30 UTC window, limit 500) and its Actions step was removed. Non-money Actions jobs are currently budget-blocked and not running. Use the authenticated operator door until capacity is restored or a scheduler cutover is reviewed, and verify actual completion independently.

## Consent and event retention

Consent retention uses the stored auditRetainedUntil deadline. DPDP_SWEEPER_DELETE must be exactly true to delete; otherwise the slice reports a bounded sample. No new retention duration or legal policy is introduced. The worker selects oldest deadlines and IDs, examines cap-plus-one candidates and deletes only selected IDs whose deadline is still expired. A concurrent extension therefore survives the mutation. Deletion does not depend on a stale preliminary count.

SystemEvent keeps the existing 400-day policy. It selects the oldest expired IDs with the same bounded sample/hasMore pattern and rechecks createdAt in deleteMany. HTTP/admin defaults examine 100 rows, capped at 500. These bounds describe candidate work, not total remaining history. A successful slice is not proof that the backlog is drained.

The cleanup request and retained CLI entrypoints carry one original start time through maintenance checks, lease admission and every core slice. Retention checks this 16-second admission budget before selection and again before deletion; a slow selection leaves `hasMore` rather than admitting another write. The retained CLI entrypoints attempt at most 40 slices of 500 within that shared budget, stopping on no progress. Consent count-only mode takes one slice. This preserves bounded batch draining while the Actions clock remains the owner. A slow in-flight database operation can outlive the start budget; it is not cancellation.

## Breach deadline alerts

The worker preserves the repository's existing 72-hour deadline and 12-hour warning predicates. This is an alerting implementation, not a new legal interpretation. It reads at most 51 candidate breaches and clearly reports sampled counts. It stages up to 5 recipient obligations per HTTP/admin call, with a 16-second start budget; the Actions entrypoint requests 50 recipients and passes its pre-maintenance start time. Officer preflight reads and ops-chat completion also recheck the budget before admitting a transaction or digest update. A timeout leaves the active digest resumable; already committed email/notification obligations are reused.

The oldest unfinished hourly digest resumes across invocations and hour boundaries. FailedEmail.entityRef uses a job-specific active prefix until all currently eligible admin/officer addresses have an obligation, then a completed prefix for that hour. Existing persisted rows are progress evidence, including guarded held/suppressed mail. A completed digest means staging completed, not email delivered. The email relay owns delivery and its failure/dead-letter handling; Novu remains independently optional.

Digest orchestration delegates officer validation, recipient staging, external-officer staging and completion to local helpers. Recipient transactions run sequentially, preserving the per-recipient budget check and recording failures before completion decides whether the digest can advance.

Per-recipient email and notification staging commit in the same transaction. An empty or failed email stage rolls back the notification stage, leaves the recipient eligible and reports a run failure. A missing address is excluded; an address changed since selection is rechecked before staging. The configured external officer mailbox receives guarded durable mail when it has no matching user. Ops chat is best effort, and failures aggregate once per run rather than per recipient. No provider send occurs inside the staging transaction.

An invalid optional officer address records a configuration error while eligible admin obligations still stage. The digest remains unfinished; correcting the address resumes it without duplicating prior admin obligations. Persistent staging failures can keep an old digest active across later hours. Repair the failure and monitor unfinished age; elapsed time alone must not mark an unfulfilled alert complete. Fair progression across persistently failing digests remains a rollout gate.

The existing email delivery guard applies to every staged message. Prelaunch holds must not be bypassed to make a test or a monitor green. Track delivery evidence and pending/dead-letter age separately from a completed staging slice.

## Verification and scheduling handoff

Mocked tests exercise actual registered HTTP handlers and existing CLI entrypoints, including maintenance consuming the budget, repeated slice handoff and expiry between a read and its write. The breach tests also cover slow empty-cohort reads, officer preflight and ops-chat leaving a digest resumable. They cover 25 rows/recipients over three slices, concurrent consent extension, unchanged retention cutoffs, staging rollback, hourly rollover, held mail, missing addresses and expired work budgets. No deletion, provider send, retention-policy update or live job invocation is part of this verification.

Before replacing an Actions step, verify deployed fail-closed lease behavior, bounded progress, appropriate repeat cadence and backlog capacity. Disable the old automatic trigger in the same controlled handoff; a shared lease does not justify dual clocks. Keep remaining fleet steps intact. The native Stream channel-expiry job remains separate and is not migrated here.

Candidate row limits do not bound database scan/sort work. The live catalog read on 27 October 2026 (IST) has no index ordered by `(auditRetainedUntil, id)` for consent or `(createdAt, id)` for system events. Read-only [`EXPLAIN`](https://www.postgresql.org/docs/17/using-explain.html), without `ANALYZE`, chose a consent sequential scan plus sort and an existing severity/time index scan plus sort for events. These plans are not measured latency or a production incident. Before increasing traffic or changing the scheduler, measure backlog/capacity and review suitable [retention-order indexes](https://www.postgresql.org/docs/17/indexes-multicolumn.html) if warranted; an index change needs its own reviewed schema rollout. Do not apply speculative DDL as part of a retention run.

Regenerate the shared cron inventory after integrating registry changes. Do not infer live execution from a YAML file, a manual staging success or an HTTP 200. Use an independent completion/absence monitor plus obligation/backlog checks, including actual deadline alert delivery.

## Deprecated & Superseded Approaches

The former consent worker counted the full expired population before deleting many batches. Bounded samples now state what they measured and recheck retention at deletion. The breach CLI previously attempted every recipient inline and swallowed delivery failures. Durable staging replaces that crash gap; the retained CLI files only dispatch the canonical cores while their current workflows remain in use.
