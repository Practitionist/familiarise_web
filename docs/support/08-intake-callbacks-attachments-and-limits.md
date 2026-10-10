# Intake, callbacks, receipts, attachments and rate limits

This page covers what happens around a support case or ticket rather than inside its status transitions: how a customer's request enters the system, how callback phone numbers and windows are validated, who may escalate to engineering, what receipts and notices are sent, how attachments are stored and served, and which routes consume which rate-limit buckets. Lifecycle rules are in [07-ticket-lifecycle-and-concurrency.md](07-ticket-lifecycle-and-concurrency.md), clocks and sweeps in [03-ticket-references-and-sla.md](03-ticket-references-and-sla.md), and unified `SupportCase` APIs in [09-support-case-and-sla-sweep.md](09-support-case-and-sla-sweep.md).

## How a request becomes a ticket or case

All intake doors mint an IST-year reference from `allocateTicketReference`, store initial SLA deadlines from `slaDeadlinesFor`, and initialize `lastMessageAt` to the creation timestamp inside one transaction:

- **Unified support cases (`POST /api/support/cases`)** validate payloads against `CreateSupportCaseInputSchema` (enforcing operator 2FA via `requireApiAuth` -> `428`), deduplicate idempotently via `clientIntakeId` or active `(appointmentId, appointmentOccurrenceId, requesterUserId, submitterUserId, category)` scope (`support_case_open_scope_key`), and persist structured `callbackPhone` + `callbackWindow` columns alongside `SupportCaseSubject`, `SupportCaseMessage`, and `SupportCaseEvent`.
- **The ticket form (`POST /api/user/support-tickets`)** validates bodies with `CreateSupportTicketSchema`, refuses session-scoped issue types with HTTP `422` (`SESSION_SCOPED_ISSUE`), verifies linked bookings, payments, or organizations against the caller's own records, and reuses an already-open ticket for the same payment.
- **The platform bot (`POST /api/support/platform`)** runs statelessly until an escalating terminal turn, reusing the caller's recent `OPEN` ticket for the same outcome within 30 minutes (`findRecentOpenEscalation`).
- **The booking bot (`POST /api/appointments/[appointmentId]/support`)** advances a persisted `AppointmentSupportThread`. Escalating turns construct a structured hand-off brief via `escalationBrief` (last substantive user message excluding bare trigger words like `"agent"` or `"talk to a human"`, topic, flow path, last bot reply, and escalation reason).

> [!IMPORTANT]
> **Explicit Owner Decision (`2026-10-10`) — Three-Strikes Bot Auto-Escalation & Unthrottled Booking Turns (`SFR-02-04`)**:
>
> 1. After **3 consecutive unrecognised user turns** without flow cursor progress, `walkFlow` (`lib/support/flow-walk.ts`) automatically escalates (`escalate: true`, `reason: "repeated_unrecognized"`).
> 2. Booking-bot turns (`POST /api/appointments/[appointmentId]/support`) spend **zero** rate-limit budget — protected by `assertBodySize(req)` and appointment participant auth only — so multi-step guided trees and typed clarifications never hit HTTP `429`.

Malformed JSON and invalid inputs return HTTP `400` in the standard envelope `{ error, code: "VALIDATION_FAILED", detail }` using Zod `flatten()`. On ticket creation, the client displays a toast with `referenceNumber` and the acknowledgement deadline formatted from `ackDueAt` (`describeWait`). Flagging an escalating turn with `urgent: true` files the ticket at `HIGH` priority (or tightens an existing deduplicated ticket via `tightenDeadlinesForPriorityRaise`, never lowering priority or reopening `CLOSED` rows). Human hand-off options remain one tap away at every prompt node.

## Callback requests

A customer may request a callback when filing a request. Phone numbers and schedules are untrusted input and are strictly validated on the server:

- **Phone number canonicalisation (`callbackPhoneSchema` / `phoneField`):** Accepts Indian mobile numbers (optional `+91`, `91`, or `0` prefix, starting `6–9`) or international E.164 numbers (`+[1-9]\d{7,14}`), strips whitespace/brackets/hyphens, rejects runs of 10+ identical digits, and canonicalises to E.164 (`+91XXXXXXXXXX`). On unified `SupportCase` rows, `phoneField` and `CallbackWindowSchema` validate and persist `callbackPhone` and `callbackWindow` directly on dedicated columns.
- **Tag spoofing guard on legacy tickets (`stripCallbackTags`):** On `SupportTicket`, `[Callback Requested: <phone>]` is prepended only by `createSupportTicket`. Every free-text user or operator input passes through `stripCallbackTags` iteratively until no tag sequence remains, and `extractCallbackInfo` honours only a valid start-of-description marker.

## Escalating to engineering

The staff case panel renders an **Escalate to Engineering** link strictly for operators with `engineering.escalate` (`ADMIN` only in `BACKOFFICE_PERMISSIONS`). Because the issue tracker repository is public, `buildEngineeringEscalationHref` populates only the case key and `FAM-` reference number, excluding all customer PII, appointment details, and payment identifiers.

## What the requester is sent

Creating a ticket or case stages two notifications:

1. **Staff notification (`notifySupportStaff`):** Alerts operators of the new intake.
2. **Requester intake receipt (`notifyRequesterOfTicket`):** Stages an outbox bell on `SUPPORT_TICKET_RECEIVED` (`dedupeKey: ticket-received:<ticketId>`) and sends an intake receipt email (`sendSupportTicketReceivedEmail`) carrying the `FAM-` reference and acknowledgement window computed from `ackDueAt`. System-generated intakes (`filedBy: "system"`) notify staff only. Automated receipts never set `acknowledgedAt`; only a public operator reply stops the acknowledgement clock.

Subsequent public staff replies and status changes notify the requester with the `FAM-` handle leading the subject, while customer replies notify the assigned operator (or the staff roster if unassigned) via `notifyStaffOfTicketActivity`.

## Rate limits

Customer write endpoints isolate traffic across purpose-specific Upstash sliding-window limiters (`spamLimiter` at 5/h, `ticketResponseLimiter` for replies, `reviewWriteLimiter` at 20/h, and `documentUploadLimiter` at 10/m). Staff accounts bypass reply and attachment limiters so queue triage is never throttled. If Upstash is unreachable, `applyRateLimit` fails open and captures a single throttled Sentry alert.

| Route                                                 | Limiter & Identifier                                                     | Enforcement & Exemptions                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `POST /api/appointments/[id]/support`                 | Unthrottled (`assertBodySize` only)                                      | Zero rate-limit budget (`SFR-02-04`); guarded by `assertBodySize(req)` and participant auth  |
| `POST /api/support/cases/[caseId]/messages`           | `ticketResponseLimiter` (`ticket-response:<userId>`)                     | **Skipped for staff**; customers share `ticketResponseLimiter` on `ticket-response:<userId>` |
| `POST /api/user/support-tickets/[ticketId]/responses` | `ticketResponseLimiter` (`ticket-response:<userId>`)                     | Charged after authentication before body parse (customers)                                   |
| `POST /api/user/support-tickets`                      | `spamLimiter` (`tickets:<userId>`)                                       | Charged after authentication before body parse                                               |
| `POST /api/support/platform`                          | `spamLimiter` (`tickets:<userId>`, shared)                               | Charged **only** on escalating terminal turns; flowchart navigation turns are unthrottled    |
| `POST /api/support/cases`                             | `spamLimiter` (`support-cases:<userId>`)                                 | Charged on case creation after `requireApiAuth`                                              |
| `POST /api/support/cases/[caseId]/csat`               | `spamLimiter` (`support-case-csat:<userId>`)                             | Resolution CSAT survey write                                                                 |
| `POST /api/support-tickets/[ticketId]/attachments`    | `documentUploadLimiter` (`ticket-attachment-upload:<userId>:<ticketId>`) | After access, closed-ticket, and 5-attachment checks pass; **customers only**                |
| `DELETE /api/support-tickets/[ticketId]/attachments`  | `documentUploadLimiter` (`ticket-attachment-delete:<userId>:<ticketId>`) | After ownership and closed-ticket checks pass; **customers only**                            |
| `POST /api/appointments/[appointmentId]/feedback`     | `spamLimiter` (`appointment-feedback:<userId>`)                          | Private session rating writes                                                                |
| `POST /api/user/feedbacks`                            | `spamLimiter` (`feedbacks:<userId>`)                                     | Platform product feedback writes                                                             |
| `POST /api/report`                                    | `spamLimiter` (`report:<userId>`)                                        | Moderation abuse/content reports                                                             |
| `POST/PUT/DELETE /api/user/reviews`                   | `reviewWriteLimiter` (`reviews:<userId>`)                                | Public consultant review create, edit, and delete writes                                     |

Every `429` response sets `Retry-After` and returns `{ error, code: "RATE_LIMITED", retryAfterSeconds }`, rendered into an exact wait time by `lib/support/error-copy.ts`.

## Attachments

Attachments reside in the private `support-attachments` Supabase Storage bucket and are never exposed via raw storage URLs:

- **Upload (`POST …/attachments`):** Restricted to ticket owner or staff on non-`CLOSED` rows, capped at 5 files per ticket (`SELECT … FOR UPDATE` row lock) and 10 MB per file across an allow-list of image/document MIME types. Storage errors roll back object writes and surface a generic `400` message without leaking provider internals.
- **Read (`GET …/attachments/[attachmentId]`):** Verifies owner or staff access, mints a 60-second signed URL, and responds with `302` + `Cache-Control: private, no-store`.
- **Delete (`DELETE …/attachments`):** Deletes storage objects via `removeObjects` (verifying removal of every key) before deleting the DB record, answering `502` on incomplete storage deletion so retries remain safe.

## Deprecated & Superseded Approaches

- **Public attachment storage URLs**: superseded by private `support-attachments` storage and 60-second signed `302` redirects (`Cache-Control: private, no-store`). Never render raw `fileUrl` columns directly.
- **Unverified fire-and-forget storage deletes**: superseded by `removeObjects` existence verification before deleting database metadata rows.
- **Regex callback parsing across full description bodies**: superseded by `phoneField` + `CallbackWindowSchema` columns on `SupportCase` and start-of-body validated `[Callback Requested: <phone>]` prefixes on legacy tickets.
- **Hardcoded client 429 retry messages**: replaced by dynamic `retryAfterSeconds` calculated from Upstash sliding-window reset headers.
- **Rate-limiting every guided bot click or staff case reply**: superseded by unthrottled `POST /api/appointments/[id]/support` (`assertBodySize` only, with three-strikes auto-escalation) and staff exemptions on `POST /api/support/cases/[caseId]/messages`.
- **Sharing `spamLimiter` (`5/h`) for public review edits**: superseded by dedicated `reviewWriteLimiter` (`reviews:<userId>`, 20/h) across `POST/PUT/DELETE /api/user/reviews`.
- **Charging `spamLimiter` (`5/h`) on customer case replies**: superseded by `ticketResponseLimiter` (`ticket-response:<userId>`) so active multi-message troubleshooting conversations are not blocked at 5 turns per hour.
