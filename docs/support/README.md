# Support and trust

`SupportCase` owns each support request and its conversation. Appointment,
payment, account and organization entry points reuse the same lifecycle within
explicit privacy scopes. Staff investigate; admins execute financial remedies.

Start with [production architecture](10-production-architecture.md). Domain details:

1. [Architecture](01-architecture.md)
2. [Ownership and scope](02-the-grid.md)
3. [References and deadlines](03-ticket-references-and-sla.md)
4. [Self-service and CSAT](04-deflection-and-support-csat.md)
5. [Schema reference](05-schema-reference.md)
6. [Invariants and CI verification](06-invariants-and-testing.md)
7. [Lifecycle and concurrency](07-ticket-lifecycle-and-concurrency.md)
8. [Intake, callbacks and evidence](08-intake-callbacks-attachments-and-limits.md)
9. [SLA sweep](09-support-case-and-sla-sweep.md)
10. [Production architecture](10-production-architecture.md)

## Deprecated & Superseded Approaches

Historical ticket/thread persistence and import compatibility have been removed.
The pre-MVP database contains disposable mock data; seed canonical cases directly.
