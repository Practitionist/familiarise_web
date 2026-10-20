# Case lifecycle and concurrency

Canonical cases use OPEN, IN_PROGRESS, ESCALATED, RESOLVED and CLOSED. Waiting
for a customer is represented by awaitingUserSince, not another case status.
Assignment and priority are independent metadata.

Intake reuses a matching non-closed case and appends the new message. The partial
unique index arbitrates concurrent creation. Appointment help may continue the
same non-closed case across intents. There is no lifetime one-dispute limit.
A reply to a RESOLVED case reopens it; CLOSED refuses public replies, while staff
can explicitly reopen it. New intake can create another case after closure.

Metadata writes compare expectedUpdatedAt. Staff public replies also compare the
last customer message the operator saw; a newer turn returns a conflict instead
of sending an uninformed reply. Message sequence allocation and insertion are
transactional. ClientTurnId and action identities make retries idempotent.
Problem-case resolution can conditionally resolve linked incidents and stages
notices only after the relevant transitions.

Each decision permits one appeal per eligible person, within its stored deadline.
Case decisions use seven days; moderation actions use six calendar months.
Appeal-of-appeal is rejected. Original reviewers cannot assign or decide their own
appeal. Refund retries remain bounded by the current refundable balance and their
stable recommendation identity; another complaint does not create another refund.

## Deprecated & Superseded Approaches

There is no synchronized ticket/thread state or ON_HOLD status. Retired routes,
legacy link resolvers and read-then-update transitions were removed. A support
conversation is the case's transcript, not a separately managed request.
