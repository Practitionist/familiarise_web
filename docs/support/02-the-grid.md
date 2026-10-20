# Support ownership and related records

| Record                       | Purpose                                                 | Who can act                                                                      |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Personal `SupportCase`       | A person's appointment, payment or account request      | Customer and platform operators                                                  |
| Organization operations case | The organization's own operational correspondence       | Active OWNER, MAINTAINER, MANAGER, SUPPORT and platform operators                |
| Organization billing case    | The organization's billing correspondence               | Active OWNER, MAINTAINER, BILLING_ADMIN and platform operators                   |
| Evidence request             | A prompt, deadline and response within an investigation | Requested delivery participant or authorized host representative; staff track it |
| Case decision                | Immutable explanation and outcome                       | Eligible platform operator; independent reviewer for an appeal                   |
| Financial recommendation     | A proposed refund linked to the case and payment        | Staff recommend; admin reviews and executes                                      |
| Payment hold                 | Prevent payout of eligible unpaid earnings              | Admin                                                                            |
| Gateway `Dispute`            | Bank/provider chargeback                                | Admin finance workflow                                                           |
| `PlatformFeedback`           | Product suggestion or opinion                           | Author and feedback operators                                                    |
| `AppointmentFeedback`        | Private session quality rating                          | Participant and platform; organization receives eligible aggregates              |
| Consultant review            | Public expert review                                    | Author and moderation operators                                                  |
| Moderation report            | Reporter-specific content/conduct concern               | Reporter and moderation operators                                                |

One person may have personal requests and act for several organizations. Selecting
an organization changes the authorized correspondence scope, not the person's
privacy rights. Member support activity is metadata/quality monitoring; it is not
an organization inbox of member transcripts. Access rechecks active membership.

Feedback or a low rating does not automatically create a case or refund. Context
links connect relevant bookings, payments and moderation actions. An appeal is a
new case linked to a decision, unique per eligible appellant and original decision.
A service dispute is not a request to the bank for a chargeback.

## Deprecated & Superseded Approaches

The old ticket/thread storage split and reporter aggregation no longer represent
current ownership. Do not infer correspondence access from an organization tag,
and do not give evidence recipients the customer's private conversation.
