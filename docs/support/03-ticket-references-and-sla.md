# Case references and response clocks

Every case receives a non-null unique `FAM-YYYY-NNNNNN` reference. The year uses
India time. `allocateTicketReference(tx)` increments `SupportCaseCounter` with an
atomic upsert inside the intake transaction. Concurrent calls serialize on the
counter row; a rollback also rolls back the allocation. References identify cases,
not a separate ticket table. The physical counter table is `support_case_counters`.

Formal intake or human handoff stores `receivedAt`, acknowledgement and internal
resolution targets, `statutoryDueAt` and a deadline-policy identifier. Guided
self-service does not start operator clocks. Category policy is centralized in
`lib/support/deadline-policy.ts`; priority targets and wait arithmetic live in
`lib/support/sla.ts`. Raising priority can tighten pending targets; lowering it
cannot extend them.

A human public reply stamps acknowledgement and first-agent response. Automated
receipts and private notes do not substitute for that reply. Waiting for the
customer records `awaitingUserSince`; their reply banks elapsed seconds into
`pausedSeconds` and clears the wait. Internal resolution targets may pause, but
the effective deadline remains bounded by the absolute category deadline.

The existing leased sweep processes bounded overdue/warning batches, pending
evidence reminders and moderation deadlines. Dedupe keys prevent repeated notices
for the same event. Resolved cases close after the configured 28-day interval.
See [sweep implementation](09-support-case-and-sla-sweep.md).

## Deprecated & Superseded Approaches

Ticket-specific counters and dual-table SLA scans were removed. The universal
15-day deadline with unlimited customer-wait extensions is not current policy.
Never recalculate a received case's absolute deadline from a later policy version.
