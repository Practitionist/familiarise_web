# Lane 02 — Customer support journey

> **Required reading:** [`_shared/shared-setup.md`](./_shared/shared-setup.md) and [`_shared/complaint-catalogue.md`](./_shared/complaint-catalogue.md). Apply the report format of the shared setup section 10. Output: `{AUDIT_DIR}/02-report.md`.

## Purpose

Walk the support journey as a frustrated customer would, from "I have a problem with this booking" to a human reply: the booking help entry, the bot intents, escalation to a ticket with a reference and a response-time promise, the ticket case page, the create-ticket dialog with its callback option, the platform-support sheet, replies on every ticket status, attachments, concurrency, and the copy shown on errors and rate limits. The lane also holds permanent regression cases for the defects found on 2026-10-09 and new cases for complaint patterns and India's grievance clocks.

## Personas and accounts

| Persona | Use |
| --- | --- |
| Customer A (a consultee picked in lane 01, onboarded, with a held occurrence) | Main UI and API journey, escalation, callback tickets. UI cases need an onboarded account; not every roster consultee is onboarded. |
| Customer B and Customer C | Second and third per-route budgets, forged-marker and invalid-phone tickets |
| Consultant (one with an appointment) | Provider-side intents |
| Organisation operator (a member of the organisation that sponsors an appointment; the owner of one organisation can be only a maintainer of another) | Organisation-operator intents |

## Preconditions and fixture setup

1. Lane 01 produced `fixtures.json`, the jars exist, and the schema check passed.
2. Pick one customer appointment with no existing support thread. Record the appointment id, the customer's `consulteeProfileId` and the consultant profile id.
3. Rate-limit plan: ticket create, ticket reply, attachment upload, attachment delete and the per-appointment support bot each have their own key with five tokens per hour per user (shared setup section 6). Budget per account and per route before starting; do SFR-02-33 last.
4. Record the baseline ticket count and the reference counter row:

```sql
select count(*) from "SupportTicket";
select * from support_ticket_counters;
```

5. Fixture shapes that this lane may insert directly (tag every text field with `{RUN_TAG}`):

```sql
-- a CLOSED ticket owned by Customer A for the closed-reply cases
insert into "SupportTicket" (id, "userId", subject, description, status, priority, "createdAt", "updatedAt", "closedAt")
values (gen_random_uuid()::text, '<customer A id>', '{RUN_TAG} closed', '{RUN_TAG} closed', 'CLOSED', 'LOW', now(), now(), now());
```

   Check the live column list first with `information_schema.columns`; add any required column. Timestamps written by SQL must be truncated to milliseconds, because microsecond values make every optimistic write conflict.
6. For SFR-02-15, insert five `SupportTicketAttachment` rows on one tagged ticket owned by Customer A (copy the live column list, point `url` at a non-existent tagged path) so that the sixth upload meets the cap without five hourly upload tokens being spent first.
7. For SFR-02-26, pick by query a booking of a lane 01 consultee that has a `Refund` in a non-terminal status. Do not insert a refund.

## Case table

| ID | Actor | Steps | Expected | Tag |
| --- | --- | --- | --- | --- |
| SFR-02-01 | Customer A, browser | Open the appointment detail page and take a snapshot. Click "Get help". | A visible "Get help" button lands on the case page in one click, showing the intent chips and a booking card. | [SUBSYSTEM] [CX-A1] |
| SFR-02-02 | Customer A | Click the "Session quality" chip. Reload. | A user turn followed by a bot prompt; DB `SupportMessage` has seq 1 USER and seq 2 BOT; the transcript order is identical after reload. | [SUBSYSTEM] |
| SFR-02-03 | Customer A | At a bot prompt that says "type details below", type a paragraph describing the problem. | The reply acknowledges the details and either stores them for the team or offers a human; it must not say it did not understand text the prompt invited. | [SUBSYSTEM] [CX-A1] |
| SFR-02-04 | Customer A | On the first menu of a fresh booking, look for a "talk to a person" option without typing anything. | A visible human option exists on the first menu, and a human is reachable in two taps or fewer from any bot state; after two bot misses a human is offered automatically. | [SUBSYSTEM] [CX-A1] |
| SFR-02-05 | Customer A | Ask for a human (chip, or the word "agent"). | A ticket is created with a `FAM-YYYY-NNNNNN` reference; the UI shows "Our team will reply by <date and time>"; the ticket has `ackDueAt` and `resolutionDueAt`; the thread is `ESCALATED` with `supportTicketId` linked and `lastMessageAt` set. | [SUBSYSTEM] [CX-A5] [CX-A15] |
| SFR-02-06 | Customer A | Inspect the ticket row created in SFR-02-05. | `description` contains the customer's own words about the problem, not just the keyword that triggered escalation; priority reflects stated urgency; title names the booking topic. The agent never needs to re-ask. | [SUBSYSTEM] [CX-A2] [CX-C8] |
| SFR-02-07 | Customer A | Open the `t_<id>` link of the ticket. | It redirects to the booking conversation with the full transcript, the booking card, the reference and a clear "passed to our support team" state. List badge and case badge use the same wording. | [SUBSYSTEM] [CX-A2] |
| SFR-02-08 | Customer A, browser | Open the create-ticket dialog. Choose HIGH, then URGENT, then LOW. | HIGH and URGENT pre-tick the callback option and show the phone box; Create stays disabled until a phone is entered; unticking removes the requirement and hides the phone box; LOW never forces it. | [PR-specific] |
| SFR-02-09 | Customer A | Use the platform support sheet to escalate "Payments - charged twice". Repeat the same request through the API within 30 minutes. | The first call creates a ticket; the replay returns the same ticket with `deduped: true` and creates no row. Note that the replay still spends a rate-limit token. | [SUBSYSTEM] |
| SFR-02-10 | Customer B, API | `POST /api/user/support-tickets` with URGENT priority. The schema has no phone field: the dialog writes the callback number into the description as a `[Callback Requested: <phone>]` marker. Send that marker with each phone value: a valid Indian mobile `+91 98765 43210`, a valid number without spaces, `abc<script>alert(1)</script>`, `123`, `]`, and an empty string. | Requirement: valid numbers are accepted and normalised; every invalid value is rejected with 400 and a field-level message; nothing invalid is stored. The UI shows the same message next to the phone box. | [PR-specific] |
| SFR-02-11 | Customer C, API | Create a LOW ticket through `POST /api/user/support-tickets` whose description contains the text `[Callback Requested: 123]` typed by hand. | Requirement: the server strips or neutralises customer-typed markers, so the stored ticket is not flagged as a callback request and staff see no callback badge; only a marker the server wrote is trusted. | [PR-specific] |
| SFR-02-12 | Customer A | Reply on an `OPEN` or `IN_PROGRESS` ticket through the API and UI. | 201; for a booking-linked ticket the message appears in the booking thread as USER with the thread still `ESCALATED`; exactly one `SupportResponse`; the UI shows "With the team". | [PR-specific] |
| SFR-02-13 | Customer A | Set a ticket to `RESOLVED` (staff or SQL, with `resolvedAt`) and reply as the customer. Repeat once with an assigned ticket. | Current behaviour: unassigned becomes `OPEN`, assigned becomes `IN_PROGRESS`; `resolvedAt`, `closedAt` and `awaitingUserSince` clear and paused seconds are folded in. The composer on a resolved ticket tells the customer that replying reopens it. | [PR-specific] [CX-A6] |
| SFR-02-14 | Customer A | Reply on a `CLOSED` ticket by API and look at the UI. | API 400 "This support ticket is closed and can no longer receive replies."; the composer is hidden or disabled; the copy offers "Start a new request" as a working link. | [PR-specific] [CX-A6] |
| SFR-02-15 | Customer A | On the pre-seeded ticket that already holds five attachments, upload a sixth. Separately upload five files to a fresh ticket and then a sixth, to observe the limiter. | The sixth upload on the full ticket shows the readable "Maximum 5 attachments" message, not a generic 429; the cap is checked before the rate limiter, which is the only way the message is reachable inside an hour. On a closed ticket upload and delete both return 400. | [PR-specific] |
| SFR-02-16 | Customer A | Upload a file, delete it through the API, then request the object's public storage URL. | The delete removes the database row and the storage object; the public URL no longer serves the file (404). If the object stays reachable, record a privacy FAIL with the status code and the object path, so lane 06 deletes it through the Storage API. | [SUBSYSTEM] |
| SFR-02-17 | Customer A | Send three replies in parallel to the same ticket. | Exactly one 201 and the others 409 "Ticket was updated concurrently; please refresh and retry."; one `SupportResponse` row; the draft remains in the UI. | [PR-specific] |
| SFR-02-18 | Consultant and organisation operator | Open booking help as a consultant and as the organisation owner. Try to force a forbidden intent through the API. | Each persona sees only its intents; a forged `RECORDING_ACCESS` intent as an operator returns 403. | [SUBSYSTEM] |
| SFR-02-19 | Consultant | Open the payment-status intent as an expert. | The wording is expert-appropriate (payout, earnings), not "Money was deducted" or "I was charged twice". | [SUBSYSTEM] |
| SFR-02-20 | Customer A | Send malformed JSON to the ticket create, ticket response and attachment delete routes. | 400 with a generic message, never 500; no `details` field, stack or SQL text in any error body. | [SUBSYSTEM] |
| SFR-02-21 | Customer A | After a reference exists, look for a confirmation to the requester: `NotificationOutbox` rows addressed to the requester, and the in-app bell. | The requester receives a confirmation carrying the `FAM-` reference and the response-time promise, in the app and by email (held mail is checked in the outbox or `FailedEmail`). Staff-only fan-out is a FAIL. | [SUBSYSTEM] [CX-A5] |
| SFR-02-22 | Customer A | Submit a ticket from the create-ticket dialog (not the booking bot). | The success state shows the reference and a response-time promise that matches the stored `ackDueAt`. | [SUBSYSTEM] [CX-A15] |
| SFR-02-23 | Customer A | Read the stored `ackDueAt` and `resolutionDueAt` for each ticket type (payment, session quality, account, grievance). | Acknowledgement is due within 24 hours (the IT Rules clock, which is stricter than the 48-hour e-commerce clock) and resolution within 15 days at most; the customer-facing copy states the same times. | [SUBSYSTEM] India IT Rules r.3(2) |
| SFR-02-24 | Customer A | Create a second ticket on a booking that already has an open ticket. | The product dedupes or offers to add to the existing case; it does not silently create a duplicate that two agents would answer. | [SUBSYSTEM] [CX-C4] |
| SFR-02-25 | Customer A | Pick by query an occurrence already in the expert no-show state (`NOBODY_JOINED`) and open help for it. Only if none exists, set one to that state by SQL (record the original) and restore it afterwards. | The help flow offers a refund or reschedule directly without asking the customer to prove the absence, and the refund status shows stage, amount and expected date. Restore the occurrence afterwards. | [SUBSYSTEM] [CX-A3] [CX-A4] |
| SFR-02-26 | Customer A | Open help for the booking with a refund in progress picked in the fixture setup. If none exists, read the flow code for the refund-status line and mark the live part BLOCKED. | The refund line shows the stage, amount and an expected date; a missed date is flagged on the case. | [SUBSYSTEM] [CX-A4] |
| SFR-02-27 | Customer A | Find the grievance officer contact and the appeal route from the help area and the footer. | The grievance officer's name and contact are visible without signing in; the page states the acknowledgement and disposal times and how to appeal. | [SUBSYSTEM] India IT Rules |
| SFR-02-28 | Customer A | Read the help area for a scam warning. | The interface says the platform never asks for a UPI PIN, OTP or screen share, and lists official contacts. | [SUBSYSTEM] [CX-A10] |
| SFR-02-29 | Customer A | Read the dispute window in the booking flow and at the end of a session. | The window length is shown at booking and again at session end. | [SUBSYSTEM] [CX-A8] |
| SFR-02-30 | Customer A | Check accessibility of the case page and composer with a snapshot and the keyboard only. | The composer has a label, the send button is reachable and operable by keyboard, errors are announced in an alert region, bubbles carry a sender name and a timestamp, and focus returns to the composer after sending. | [SUBSYSTEM] |
| SFR-02-31 | Customer A | Read the copy shown when the platform is unreachable (disconnect the network in the MCP and send). | A fallback with an email address or form and a stated response time appears; the draft is kept. | [SUBSYSTEM] [CX-A7] |
| SFR-02-32 | Customer A | Count taps and re-entries from "something went wrong" to a human-owned ticket. | At most three taps and no re-entry of booking or payment details. Record the count. | [SUBSYSTEM] [CX-A1] [CX-A2] |
| SFR-02-33 | Customer B | Exhaust the ticket-create key (`tickets:`) with ticket creates until a 429; capture the UI toast and the API body. (Run last.) | The toast and the API body state the real wait derived from `retryAfterSeconds`, not "a few minutes" when the wait is close to an hour; the draft is kept. | [SUBSYSTEM] |

## Database assertions

- After SFR-02-05: `select id, status, priority, "ackDueAt", "resolutionDueAt", description from "SupportTicket" where id = '<id>'` returns the stored promise and the customer's words; the thread row has `status = 'ESCALATED'` and `"supportTicketId"` set.
- After SFR-02-10 and SFR-02-11: `select count(*) from "SupportTicket" where description like '%Callback Requested%'` increases only for tickets where a valid phone was supplied.
- After SFR-02-12: one `SupportResponse` per customer reply, one `SupportMessage` USER per reply on the thread.
- After SFR-02-17: exactly one new `SupportResponse` for the parallel burst.
- After SFR-02-21: `select recipient, template, status from "NotificationOutbox" where "entityRef" = 'ticket:<id>'` contains a row for the requester. Support tickets may bypass the outbox; if the query is empty, also read `"FailedEmail"` and the create path in code, and report an absent confirmation as a FAIL.

## Cleanup

Delete in this order for every ticket the lane created, keeping the handoff tickets that lane 03 needs (list them in the report; lane 06 deletes them): `SupportResponse`, `SupportTicketAttachment`, `SupportMessage` of the thread, `AppointmentSupportThread`, `SupportFlowOutcome`, `NotificationOutbox` rows by `entityRef`, and finally `SupportTicket`. Remove uploaded objects from storage through the Storage API with the service-role key (lane 06 repeats this for anything left); never delete from the storage tables by SQL. Restore any appointment or occurrence you edited for SFR-02-25 to the recorded values.

## Handoff to lane 03

List: the escalated booking thread and its ticket, the valid-phone URGENT ticket, the invalid-phone attempt result, the forged-marker ticket, the storage object paths still uploaded, and the remaining rate-limit budget per account and per route.

## Report section

Verdict table for SFR-02-01 to SFR-02-33; detail for each FAIL and PARTIAL; psychology observations (taps, dead ends, copy, promises made versus enforced); fixtures with original values and the cleanup performed.
