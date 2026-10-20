# Support invariants and CI verification

The implementation is checked through focused regressions and disposable-Postgres
CI races. Tests, typechecking, lint and builds run in CI/CD for this change.

1. SupportCase is the only live correspondence record; booking/account help uses it.
2. Intake deduplicates within ownership and subject scope, with a partial unique index.
3. Every transaction helper queries its passed transaction client, never global Prisma.
4. Message sequence and retry identity prevent reordered or duplicated turns.
5. Metadata uses expectedUpdatedAt; stale writes return a conflict.
6. Public staff replies reject unseen newer customer messages.
7. Private notes never reach the customer or evidence recipient.
8. Organization membership grants operations and billing separately.
9. Evidence submission/cancellation races have one conditional winner.
10. Submitted evidence is final; lateness is visible rather than silently discarded.
11. Decisions are immutable and appeals exclude the original reviewer.
12. Refund recommendations retain one stable reservation/refund identity across retries.
13. Financial execution uses admin step-up, reason, budget, audit and conditional approval.
14. Case holds participate in payout claims and disbursement eligibility.
15. Absolute receipt deadlines cannot be extended by customer waiting.
16. Notifications stage transactionally and dedupe through the durable outbox.
17. Reporter receipts and appeal rights stay reporter-specific.
18. Feedback/reviews do not automatically create cases or money movements.

`__tests__/support` covers case services, authorization, evidence, financial review,
case addressing, SLA sweeps and request presentation. The support-concurrency CI
script verifies actual database uniqueness and race behavior. Existing payment
and payout regressions cover the money boundaries. A rendered preview is visual
and API evidence, not proof that gateway refunds or external filings completed.

## Deprecated & Superseded Approaches

Tests for migration imports, aliases and retired 410 route stubs were deleted with
their implementation. Avoid restoring them as compatibility requirements for a
pre-MVP database whose former rows were disposable.
