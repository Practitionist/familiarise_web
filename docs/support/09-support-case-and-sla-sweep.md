# Support cases, deadlines and recovery

`SupportCase` owns every active support conversation. Personal, organization and
operator dashboards read the same ordered timeline, with authorization applied
before message serialization. See [production architecture and cutover](10-productionization-and-cutover.md)
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
Old ticket/thread references resolve explicit migration aliases, while retired
mutation APIs return `410`.

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
provider dispute deadlines, overdue evidence and moderation deadlines.

Notice identities live in the durable outbox. Candidate queries exclude already
notified thresholds so old overdue records cannot repeatedly consume the batch.
Warnings and breaches have separate identities; approaching deadlines can still
produce a later breach notice. The case's customer-wait state does not suppress
its absolute deadline. Personal-case organization tagging does not email private
case details to an organization escalation contact.

Individual failures are accumulated and reported once per run. Notifications use
the universal authorized case resolver; neutral evidence notices link directly
to the recipient's evidence workspace. Submitted storage evidence is retained by
the existing vendor-boundary storage cleanup, and abandoned reservations expire.

## Deprecated & Superseded Approaches

Separate live ticket and appointment-thread queues, legacy CSAT fallbacks and
mixed-table monthly reporting are retired. Their tables remain migration sources
only. A universal 15-day clock with customer-wait extensions is replaced by fixed
category deadlines. Backoffice canonical case reads are active; there is no
future cutover flag or dual-read fallback.
