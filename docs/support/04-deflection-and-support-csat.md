# Self-service outcomes and support satisfaction

`SupportFlowOutcome` records a terminal self-service result without message
bodies: scope, flow key, terminal, reason, user, optional organization, outcome and
optional helpful rating. It measures whether a guided flow helped without turning
every resolved walkthrough into an operator case. Recontact analytics read later
outcomes and canonical cases in the reporting window.

Human support satisfaction is stored on `SupportCase.csatRating` and `csatAt`.
The case must belong to the submitting customer and be RESOLVED or CLOSED.
Conditional writes prevent concurrent duplicate submissions. A resolution stages
the delayed support-CSAT notification through the durable outbox, including
incidents resolved by a problem-case cascade.

These signals answer different questions: flow helpfulness rates the guidance;
case CSAT rates support handling; `AppointmentFeedback` rates a private session;
a consultant review is public; `PlatformFeedback` is a suggestion or opinion.
None is a refund instruction. An open support case may soften the session-rating
prompt while still allowing the participant to rate.

Reporting excludes private transcript bodies and respects organization ownership.
Session-quality aggregates never reveal individual members' private feedback and
require the configured minimum distinct-rater threshold.

## Deprecated & Superseded Approaches

Legacy ticket CSAT events and fallback dual reads were removed. Use the canonical
case's CSAT columns rather than inventing a second rating ledger or interpreting
a self-service outcome as an operator response.
