# Support cases, deadlines and recovery

`SupportCase` owns every active support conversation. Personal, organization and
operator dashboards read the same ordered timeline, with authorization applied
before message serialization. See [production architecture](10-production-architecture.md)
for the complete workflow and deployment procedure.

## Canonical records

A case has a stable `FAM-YYYY-NNNNNN` reference, requester, submitter, explicit
ownership, subject key, assignment, channel, lifecycle, messages and audit events.
`SupportCaseSubject` links bookings, occurrences, payments, refunds and organizations.
A partial unique index prevents duplicate open intake within the same ownership,
organization, subject and submitting party. Client intake identities are unique
within the submitter; message identities and sequence numbers are unique per case.

Evidence requests, immutable decisions, recommendations, payment holds and private
attachments are separate related records. An appeal references its original
case decision or moderation action and retains that record unchanged.

## Intake and communication

`POST /api/support/cases` parses separate staff and customer schemas. The server
binds authorship and checks actual appointment participation, payment ownership
and current organization membership. Staff intake for a customer creates an
agent-authored message in that customer's personal correspondence. An organization
filing a personal concern about another member does not expose its transcript
to that member; the member receives summary metadata only.

Organization operations and billing cases use separate permission grants. The
original submitter's membership does not grant permanent access after departure;
a current eligible successor can continue organization-owned correspondence.

Public grievances retain external name and email. A queue custodian foreign key
is not a fabricated complainant identity. Their transcript is staff-only, and
external replies use guarded email delivery. Automated receipts do not count as
a human acknowledgement.

The backoffice and customer readers return the newest 200 messages with an older
sequence cursor. Internal notes and private investigation events stay with staff.
Only canonical case references are accepted; the pre-MVP ticket/thread tables,
aliases and retired mutation routes have been removed.

## Clocks and lifecycle

Guided self-service does not start operator SLA clocks. First handoff to a person
sets `receivedAt`, internal acknowledgement/resolution targets and the category
deadline. The formal receipt timestamp remains distinct from the first bot turn.
Formal intake starts those clocks immediately. The category policy is captured
when received, and that absolute deadline never pauses for customer information.
Internal targets may pause; their effective deadline cannot exceed the category
ceiling. A priority increase can tighten internal targets, and a decrease cannot
extend them.

Metadata changes require `expectedUpdatedAt`. Public staff replies also protect
against an unseen customer follow-up. Message allocation and insertion commit in
one transaction; retry identities prevent duplicate turns. Resolution records
its explanation, immutable decision and delayed CSAT prompt atomically. A reply
to a resolved case reopens it; a closed case requires a new intake.

CSAT accepts one score of 1–5 from the submitting party within 28 days of resolution.
Monthly admin reporting uses the IST receipt window, separate grievance and appeal
counts, human acknowledgement times, and absolute category resolution deadlines.
Self-service outcomes remain separate deflection/helpfulness analytics. CSV
exports neutralize spreadsheet formula prefixes.

## Existing recovery sweep

The registered `support-sla-sweep` runs through the existing scheduler and Postgres
job lease. It does not add another scheduler or Redis cron lock. Its bounded work
covers acknowledgement/resolution notices, 28-day resolved-case auto-close,
the resolved-problem cascade, the 180-day evidence purge, provider dispute
deadlines, overdue evidence and moderation deadlines. Its chat-access arm
(`lib/support/chat-sweep.ts`) ends expired grants and grants on cases resolved
outside the staff funnel, retries the Familiarise Support join and leave in
Stream, and sends or records withholding of the post-decision "our team
reviewed messages" bell through the outbox.

Provider dispute reminders scan `now - 24h <= dueBy <= now + 72h`. Threshold
identities (`dispute-due:{id}:{72|24}`) are stored as outbox `entityRef`s so
already-staged pairs do not consume the send limit, even if notification policy
changes the recipient list. The transaction rechecks that identity before
staging. Alerts link to the admin dispute detail. Disputes due within 12 hours or
past due in that window produce one `reportStandingFinding` page per run; repeated
unchanged findings remain quiet for 24 hours.

Notice identities live in the durable outbox. Candidate queries exclude already
notified thresholds so old overdue records cannot repeatedly consume the batch.
Warnings and breaches have separate identities; approaching deadlines can still
produce a later breach notice. The case's customer-wait state does not suppress
its absolute deadline. Personal-case organization tagging does not email private
case details to an organization escalation contact.

The auto-close arm examines at most `limit * HELD_OPEN_SCAN_FACTOR` candidates and
closes at most `limit` cases. It selects never-attempted cases first, then the
oldest `autoCloseLastAttemptAt`, with `resolvedAt` and ID as stable tie breakers.
A conditional database stamp commits before each closing transaction, so a held
case or failed transaction rotates across later runs and process restarts. A
stale claim, reopened case or tombstone cannot take that attempt. The stamp changes
only polling metadata; `resolvedAt` and `updatedAt` retain their business meaning.

The existing payout-hold and recommendation checks still decide whether closing
is allowed. An open recommendation or intentional maintenance leaves the case
resolved and appears in
`autoCloseHeldOpen` with at most ten `{ caseId, reason }` samples in
`autoCloseHolds`; these holds do not make the run fail or send a Sentry error.
Unreadable maintenance (`MAINTENANCE_UNKNOWN`), unexpected refusal codes and genuine
exceptions still enter `errors` and the single aggregated error report.
`autoClosedCount` remains the number closed. `autoCloseHasMore` conservatively
reports holds, failures, unstarted selected rows or a cap-sized sample, so a
successful sweep does not mean the resolved backlog is drained.

Auto-close admits no new attempt after 16 seconds from the invocation's start.
It checks before reading candidates and before each progress stamp; reaching the
close limit also leaves later candidates unstamped. This is a start budget for
this arm, not cancellation of in-flight work or a deadline for the complete SLA
sweep. Other arms retain their existing bounds.

### Auto-close schema rollout

Before deploying these readers, an operator must apply
`prisma/sql/support-auto-close-progress.sql` to add the nullable polling column
and its compound index. No backfill is needed: existing rows start unattempted.
Run it with `psql -v ON_ERROR_STOP=1 -f prisma/sql/support-auto-close-progress.sql`
using the operator's configured direct/session connection. The script sets a
five-second lock timeout, commits the column addition, then builds the index
concurrently outside a transaction. A final catalog gate rejects an invalid or
unready index, including an invalid prior build skipped by `IF NOT EXISTS`.
If a build or gate fails, inspect `pg_index.indisvalid`; use `DROP INDEX CONCURRENTLY`
on that invalid index outside a transaction, rerun the file, and verify the gate
passes before deploying. Do not wrap the complete script in a transaction. This
artifact has not been applied to the shared database.
The compound index is not a measured guarantee for the null-first sort or runtime.

Individual failures are accumulated and reported once per run. Notifications use
the universal authorized case resolver; neutral evidence notices link directly
to the recipient's evidence workspace. Submitted storage evidence is retained by
the existing vendor-boundary storage cleanup, and abandoned reservations expire.

## Deprecated & Superseded Approaches

Separate live ticket and appointment-thread queues, legacy CSAT fallbacks and
mixed-table monthly reporting and migration aliases are removed. A universal 15-day clock with customer-wait extensions is replaced by fixed
category deadlines. Backoffice canonical case reads are active; there is no
future cutover flag or dual-read fallback.

The fixed oldest-resolution sample could repeatedly examine held cases while
never reaching later closable ones. Durable attempt ordering replaces that
prefix retry; deeper paging confined to one invocation cannot retain progress
after interruption. Expected money-door and recommendation refusals previously
entered the error collection and triggered failure pages. They now appear as
held-open outcomes while genuine transaction failures retain their error path.
