# Canonical support schema

| Model                            | Invariant                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SupportCase`                    | One scoped request; unique reference; receipt/deadline snapshots; assignment and lifecycle                    |
| `SupportCaseCounter`             | Atomic year-scoped reference allocator                                                                        |
| `SupportCaseSubject`             | Links account, appointment, occurrence, payment, refund, invoice or organization; at most one primary subject |
| `SupportCaseMessage`             | Ordered transcript with sender, author, private-note flag and client retry identity                           |
| `SupportCaseEvent`               | Required `caseId`; actor and typed audit event (`toValue` names the target row); no alternative parent        |
| `SupportCaseEvidenceRequest`     | Recipient prompt/deadline; final response and cancellation state                                              |
| `SupportCaseAttachment`          | Private stored evidence attached to a case, message or evidence request                                       |
| `SupportCaseDecision`            | Immutable explanation/outcome and appeal deadline                                                             |
| `SupportFinancialRecommendation` | Paise, payment, author, `releaseSeat`, decision, void and stable refund association                           |
| `SupportFlowOutcome`             | Body-free terminal self-service analytics                                                                     |

Ownership is PERSONAL, ORG_OPERATIONS or ORG_BILLING. Organization ownership
requires an organization. A case may appeal a case decision or moderation action,
never both. Retry identity is scoped to the submitter. Appeals are unique per
original decision/action and submitter.

SQL sidecars enforce one non-closed case per ownership/organization/subject/
requester/submitter/category, one primary subject, the recommendation decision
and void shape, and one undecided recommendation per payment. Support payout
holds are `EarningsHold` rows with reason `SUPPORT_CASE` and the case id as
`sourceRef`; their intent is the case's `HOLD_APPLIED` / `HOLD_RELEASED` events. Messages have unique
`[caseId, seq]` and `[caseId, clientTurnId]`. Case decisions reject UPDATE/DELETE.
Prisma represents the normal FKs and indexes; partial indexes and checks live in
`prisma/sql/check-constraints.sql`.

Evidence, decisions and financial recommendations use restrictive FKs to
retain investigation records. Authors/assignees that may depart use SetNull where
permitted; access always rechecks the current actor. IDs remain first in models.

## Deprecated & Superseded Approaches

SupportTicket, SupportResponse, SupportTicketAttachment, AppointmentSupportThread,
SupportMessage, SupportCaseLegacyAlias and legacy attachment IDs were removed.
`SupportPaymentHold`, a second payment-scoped hold table gated by hand in each
payout query, was folded into `EarningsHold` (`SUPPORT_CASE`).
Events cannot target a second legacy parent. Fresh seeds write the current models.
