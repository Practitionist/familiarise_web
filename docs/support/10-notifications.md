---
title: Support notifications
type: reference
band: domain
audience: sde2
status: live
last-reviewed: 2026-10-23
---

# Support notifications

Support never calls Novu or the email provider inside a business transaction. It **stages** a row in a durable outbox inside the same transaction as the change it announces, so a notice exists if and only if the change committed. After the response, the row is attempted once inline; a ticker job then retries anything that did not go out. Every support notice has a stable identity (its dedupe key and `entityRef`), so a retry, a double submit or a second sweep never sends it twice.

## The two outboxes

| Outbox              | Table                                                         | Staged by                                                                                | Retried by                                                                                                                     |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| In-app bells (Novu) | `NotificationOutbox`                                          | `stageBell()` in `lib/novu/stage-bell.ts` (via `stageTrigger()` in `lib/novu/outbox.ts`) | `drain-notification-outbox` on the ticker every 10 minutes (`jobs/notifications/drain-notification-outbox.ts`, up to 50 rows). |
| Email               | `FailedEmail` (it holds every staged email, despite the name) | `deliver()` in `lib/email/deliver.ts`, and the support senders built on it               | `retry-failed-emails` on the ticker every 15 minutes.                                                                          |

**Bell staging.** `stageBell()` filters recipients through the bell policy (workspace routing, channel and category preferences, quiet hours) and returns nothing if no one is left. It upserts on `transactionId`, which is the workflow plus a hash of the post-policy recipients and the dedupe key, so a repeat stage returns the existing row instead of failing the caller's transaction. A new row is leased for 60 seconds so the drain does not race the inline attempt. `notBefore` delays delivery; the CSAT prompt uses it.

**Delivery states.** A row is SENT on success. A terminal 4xx or the fifth relay attempt makes it DEAD_LETTER; other failures retry with backoff. SENT rows are pruned after 30 days and DEAD_LETTER rows after 90 (`scripts/cleanup/prune-system-job-executions.ts`).

**Email guard.** Every email goes through `deliver()`, so the pre-launch guard sees every recipient: unless `EMAIL_DELIVERY_MODE` is `live`, only allowlisted domains are sent and the rest are dead-lettered as `held:pre-launch` (`lib/email/delivery-guard.ts`; see [`docs/email/README.md`](../email/README.md)).

## What support sends

| Event                            | Channel and workflow                                                                                                           | Recipients                                                                   | Identity (`entityRef` / dedupe key)                       | Staged in                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| Case handed to a person          | Staff bell `support-ticket-created`; customer bell and `SUPPORT_TICKET_RECEIVED` email (organization cases get a generic body) | All operators; case correspondents                                           | `case-created:<caseId>` (dedupe `:staff`, `:customer`)    | `stageSupportCaseIntakeTx()` in the intake transaction |
| New message                      | Bell `support-ticket-update`; staff replies also email (`SUPPORT_TICKET_RESPONSE`)                                             | Staff reply: case correspondents. Customer reply: assignee, or all operators | `case-message:<messageId>`                                | `appendSupportCaseTurn()` transaction                  |
| Status change by staff           | Bell and `SUPPORT_TICKET_UPDATE` email                                                                                         | Case correspondents (ESCALATED shown to customers as in progress)            | `case-status:<caseId>:<status>:<updatedAtMs>`             | After the PATCH commits                                |
| Resolution CSAT prompt           | Bell, delivered no earlier than 24 h after resolution                                                                          | Case correspondents (not anonymous grievances)                               | `csat:<caseId>:<resolvedAt>`                              | Resolving transaction                                  |
| Evidence requested               | Bell linking to `/dashboard/evidence/<id>`                                                                                     | The recipient                                                                | `evidence-request:<requestId>`                            | Case action                                            |
| Evidence received                | Bell                                                                                                                           | The assignee, or the operator who asked                                      | `evidence-response:<requestId>`                           | Evidence answer transaction                            |
| Decision recorded                | Bell (email for an anonymous grievance)                                                                                        | Case correspondents; each evidence recipient separately                      | `decision:<decisionId>`, `decision:<decisionId>:<userId>` | Decision transaction                                   |
| Appeal filed                     | Bell                                                                                                                           | Every STAFF and ADMIN except the original decider                            | `appeal:<caseId>`                                         | Appeal transaction                                     |
| SLA warning or breach            | Bell `support-ticket-activity` and `support-sla-alert` email; org escalation email on breach of an org-owned case              | Assignee, or all operators                                                   | `sla:<caseId>:<ack                                        | res>:<warn                                             | breach>`                                         | Sweep, per case |
| Incident resolved by its problem | Bell and email                                                                                                                 | The incident's correspondents                                                | `case-status:<incidentId>:RESOLVED:<epochMs>`             | Cascade, per incident                                  |
| Chargeback deadline              | Bell `DISPUTE_UPDATED` and `dispute-deadline-alert` email                                                                      | Admins                                                                       | `dispute-due:<disputeId>:<72                              | 24>`                                                   | Sweep                                            |
| Moderation deadline              | Bell                                                                                                                           | Assignee, or all operators                                                   | `moderation-deadline:<reportId>:<warn                     | breach>`                                               | Sweep                                            |
| Evidence overdue                 | Bell                                                                                                                           | The operator who asked                                                       | `evidence-overdue:<requestId>`                            | Sweep                                                  |
| Support joined a booking chat    | Bell (intervention branch)                                                                                                     | Case correspondents (`:case`) and other parties (`:party`, no case title)    | `chat-intervention:<grantId>:case                         | party`                                                 | Grant transaction; flushed after the Stream join |
| Staff reviewed booking messages  | Bell (intervention branch), unless withheld                                                                                    | As above                                                                     | `chat-reviewed:<firstGrantId>:case                        | party`                                                 | Sweep, once per decided case                     |

Bells link to the case with `supportRequestHref()` (`lib/novu/resolve-href.ts`), which always points at `/dashboard/support/<caseKey>`; it ignores the organization argument. Organization context is carried in the payload by `notificationScope()` (`lib/novu/workflows.ts`). Sweep arms that must not re-send after a recipient-policy change (SLA and chargeback alerts) match prior sends on `entityRef`, because the derived `transactionId` changes with the recipient list. Organization-owned cases get a generic email body rather than the case text. The moderation and overdue-evidence bells use relative links.

## Anonymous grievances

A public grievance filed without an account has no in-app recipient. `stageExternalRequesterEmail()` (`lib/support/external-requester.ts`) emails the stored address, and only after the requester confirms it: before confirmation the email carries the reference and a confirmation link, never staff text. Every staff reply, decision and cascade notice for such a case goes through it.

## Invariants

| Rule                                                       | Enforcer                                                                              | Test                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A notice exists only if its change committed.              | App: staging inside the business transaction.                                         | `__tests__/notifications/outbox.test.ts`                             |
| A bell is staged once per identity and recipient set.      | The database: unique `NotificationOutbox.transactionId`; upsert with an empty update. | `__tests__/notifications/outbox.test.ts`                             |
| Bell policy (preferences, quiet hours) applies to support. | App: `resolveRecipientBellPolicy()` inside `stageBell()`.                             | `__tests__/notifications/stage-bell-and-subscriber-security.test.ts` |
| Every email passes the pre-launch guard.                   | App: `deliver()`.                                                                     | `__tests__/email/delivery-guard.test.ts`                             |
| Unconfirmed external addresses get no staff text.          | App: `stageExternalRequesterEmail()`.                                                 | `__tests__/support/external-requester.test.ts`                       |

Staff-status notices are the one exception to "staged in the transaction": the PATCH route stages them right after commit, then flushes them.

## Where in code

- `lib/novu/stage-bell.ts`, `lib/novu/outbox.ts`, `lib/novu/workflows.ts`, `lib/novu/resolve-href.ts`, `lib/novu/stage-then-attempt.ts` (`flushNotificationsAfter()`).
- `lib/email/deliver.ts`, `lib/email/delivery-guard.ts`, `lib/email/senders/people.ts` (`stageSupportTicketUpdateEmail()`).
- `lib/support/case-service.ts` (`stageCaseTurnNotificationsTx()`, `stageCaseResolutionCsatPromptTx()`), `lib/support/case-actions.ts` (`stageCaseNotice()`, `stageDecisionNotificationsTx()`), `lib/support/external-requester.ts`.
- `jobs/notifications/drain-notification-outbox.ts`, `netlify/functions/cron-tick.mts`.

## Deprecated & Superseded Approaches

- **Notices staged after commit and lost.** The old in-transaction problem cascade staged its notices after commit, so a crash between the two lost them. Cascade notices are now staged inside each incident's transaction.
- **Copy that promises reopen on reply.** The RESOLVED status email (`supportNextStepText()` in `lib/email/senders/people.ts`) and two saved replies still tell customers that replying reopens the request. Replies no longer reopen ([case lifecycle](02-case-lifecycle.md#resolve-reopen-and-close)); that copy is stale.
- Workflow and email-type names keep the old word "ticket" (`support-ticket-update`, `SUPPORT_TICKET_RESPONSE`); they all describe `SupportCase` events.
- **Organization dashboard links.** The doc comment on `supportRequestHref()` still says organization cases open in the organization dashboard; the code ignores the organization and always links to `/dashboard/support/<caseKey>`.
