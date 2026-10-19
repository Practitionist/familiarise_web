# Support and trust

`SupportCase` is the active support record across personal, organization and
operator dashboards. It owns a reference, ordered messages, assignment, lifecycle,
absolute deadline and audit events. Legacy tickets/threads are migration sources;
old links resolve through aliases and old mutation APIs return `410`.

Start with [production architecture and cutover](10-productionization-and-cutover.md)
for ownership, evidence, decisions, refunds, payout holds, appeals, storage,
concurrency and the deployment sequence. The [intent grid](02-the-grid.md) explains
why learning questions, support, private ratings, public reviews, product feedback,
moderation reports and gateway chargebacks remain distinct.

Staff investigate and communicate; admin executes money and restricted sanctions.
Organization operators collaborate within their finance/operations scope, while
member-private correspondence remains private. Evidence recipients receive a
neutral request rather than access to the customer's conversation. Notifications
resolve through `/dashboard/support/<caseKey>` to the authorized workspace.

Case actions reuse the existing financial reservation, ledger and payout services.
Category deadlines never extend merely because the customer owes information.
The existing SLA sweep and notification outbox provide recovery. PostgreSQL
constraints and conditional updates arbitrate concurrent writes.

The service entry points are `/api/support/cases`, `/api/support/requests`,
`/api/support/evidence` and `/api/support/appeals`. Public grievances retain
external contact identity and guarded email correspondence. Attachments use
private storage with direct signed transfers and authorization on every read.

## Deprecated & Superseded Approaches

Separate live ticket and appointment-thread queues, drawer-only conversations,
and a shared report identity for multiple reporters are superseded. Older domain
references describe the former deployment; the cutover document is authoritative
for the current application and its migration requirements.
