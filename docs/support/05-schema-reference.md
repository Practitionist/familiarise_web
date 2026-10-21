# Canonical support schema

| Model                            | Invariant                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SupportCase`                    | One scoped request; unique reference; receipt/deadline snapshots; assignment and lifecycle                    |
| `SupportCaseCounter`             | Atomic year-scoped reference allocator                                                                        |
| `SupportCaseSubject`             | Links account, appointment, occurrence, payment, refund, invoice or organization; at most one primary subject |
| `SupportCaseMessage`             | Ordered transcript with sender, author, private-note flag and client retry identity                           |
| `SupportCaseEvent`               | Required `caseId`; actor and audit event; no alternative parent                                               |
| `SupportCaseEvidenceRequest`     | Recipient prompt/deadline; final response and cancellation state                                              |
| `SupportCaseAttachment`          | Private stored evidence attached to a case, message or evidence request                                       |
| `SupportCaseDecision`            | Immutable explanation/outcome and appeal deadline                                                             |
| `SupportFinancialRecommendation` | Paise, payment, author, decision and stable refund association                                                |
| `SupportPaymentHold`             | Admin-applied payment scope and explicit release audit                                                        |
| `SupportFlowOutcome`             | Body-free terminal self-service analytics                                                                     |

Ownership is PERSONAL, ORG_OPERATIONS or ORG_BILLING. Organization ownership
requires an organization. A case may appeal a case decision or moderation action,
never both. Retry identity is scoped to the submitter. Appeals are unique per
original decision/action and submitter.

SQL sidecars enforce one non-closed case per ownership/organization/subject/
requester/submitter/category, one primary subject, recommendation decision shape,
hold release shape and one active hold per case/payment. Messages have unique
`[caseId, seq]` and `[caseId, clientTurnId]`. Case decisions reject UPDATE/DELETE.
Prisma represents the normal FKs and indexes; partial indexes and checks live in
`prisma/sql/check-constraints.sql`.

Evidence, decisions, financial recommendations and holds use restrictive FKs to
retain investigation records. Authors/assignees that may depart use SetNull where
permitted; access always rechecks the current actor. IDs remain first in models.

## Deprecated & Superseded Approaches

SupportTicket, SupportResponse, SupportTicketAttachment, AppointmentSupportThread,
SupportMessage, SupportCaseLegacyAlias and legacy attachment IDs were removed.
Events cannot target a second legacy parent. Fresh seeds write the current models.
