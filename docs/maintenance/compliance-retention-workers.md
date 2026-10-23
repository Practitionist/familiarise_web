# Compliance and event-retention workers

The cleanup registry exposes consent-retention-sweeper, databreach-deadline-alerts and prune-system-events. The authenticated cleanup route and ADMIN System Jobs door call the same leased domain implementations. The existing Actions fleet steps remain their automatic scheduling owner; this change does not enable ticker targets or claim those workflows are currently executing. Verify actual completion independently.

## Consent and event retention

Consent retention uses the stored auditRetainedUntil deadline. DPDP_SWEEPER_DELETE must be exactly true to delete; otherwise the slice reports a bounded sample. No new retention duration or legal policy is introduced. The worker selects oldest deadlines and IDs, examines cap-plus-one candidates and deletes only selected IDs whose deadline is still expired. A concurrent extension therefore survives the mutation. Deletion does not depend on a stale preliminary count.

SystemEvent keeps the existing400day policy. It selects the oldest expired IDs with the same bounded sample/hasMore pattern and rechecks createdAt in deleteMany. HTTP/admin defaults examine100rows, capped at500. These bounds describe candidate work, not total remaining history. A successful slice is not proof that the backlog is drained.

The retained CLI entrypoints attempt at most40slices of500 within a16second start budget, stopping on no progress. Consent count-only mode takes one slice. This preserves bounded batch draining while the Actions clock remains the owner. A slow in-flight database operation can outlive the start budget; it is not cancellation.

## Breach deadline alerts

The worker preserves the repository's existing72hour deadline and12hour warning predicates. This is an alerting implementation, not a new legal interpretation. It reads at most51candidate breaches and clearly reports sampled counts. It stages up to5recipient obligations per HTTP/admin call, with a16second start budget; the Actions entrypoint requests50recipients.

The oldest unfinished hourly digest resumes across invocations and hour boundaries. FailedEmail.entityRef uses a job-specific active prefix until all currently eligible admin/officer addresses have an obligation, then a completed prefix for that hour. Existing persisted rows are progress evidence, including guarded held/suppressed mail. A completed digest means staging completed, not email delivered. The email relay owns delivery and its failure/dead-letter handling; Novu remains independently optional.

Per-recipient email and notification staging commit in the same transaction. An empty or failed email stage rolls back the notification stage, leaves the recipient eligible and reports a run failure. A missing address is excluded; an address changed since selection is rechecked before staging. The configured external officer mailbox receives guarded durable mail when it has no matching user. Ops chat is best effort, and failures aggregate once per run rather than per recipient. No provider send occurs inside the staging transaction.

The existing email delivery guard applies to every staged message. Prelaunch holds must not be bypassed to make a test or a monitor green. Track delivery evidence and pending/dead-letter age separately from a completed staging slice.

## Verification and scheduling handoff

Mocked tests cover25rows/recipients over three slices, concurrent consent extension, unchanged retention cutoffs, staging rollback, hourly rollover, held mail, missing addresses and expired work budgets. No deletion, provider send, retention-policy update or live job invocation is part of this verification.

Before replacing an Actions step, verify deployed fail-closed lease behavior, bounded progress, appropriate repeat cadence and backlog capacity. Disable the old automatic trigger in the same controlled handoff; a shared lease does not justify dual clocks. Keep remaining fleet steps intact. The native Stream channel-expiry job remains separate and is not migrated here.

Regenerate the shared cron inventory after integrating registry changes. Do not infer live execution from a YAML file, a manual staging success or an HTTP200. Use an independent completion/absence monitor plus obligation/backlog checks, including actual deadline alert delivery.

## Deprecated & Superseded Approaches

The former consent worker counted the full expired population before deleting many batches. Bounded samples now state what they measured and recheck retention at deletion. The breach CLI previously attempted every recipient inline and swallowed delivery failures. Durable staging replaces that crash gap; the retained CLI files only dispatch the canonical cores while their current workflows remain in use.
