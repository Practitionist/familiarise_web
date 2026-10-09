# Lane 03 — Staff support operations

> **Required reading:** [`_shared/shared-setup.md`](./_shared/shared-setup.md) (especially section 5, two-factor enrolment) and [`_shared/complaint-catalogue.md`](./_shared/complaint-catalogue.md). Output: `{AUDIT_DIR}/L3-report.md`.

## Purpose

Run the back office as a support agent would: enrol two-factor, triage the inbox, read a case with its full context, reply publicly and privately, move a ticket through its statuses, assign it, escalate to engineering, and be notified. The lane proves that races do not corrupt a ticket, that staff cannot be fooled by customer-supplied text, and that an agent has what they need in one click. Cases for the staff-side complaint patterns (ping-pong, lost context, invisible breaches, duplicates, clobbering, audit, PII) are included.

## Personas and accounts

| Persona | Use |
| --- | --- |
| Staff operator | The main agent; enrolled for two-factor in SFR-03-01 |
| Admin operator | Admin-only gates; enrolled for two-factor in SFR-03-01 |
| Customer A | Observes what the agent's actions look like from the customer side |
| Organisation owner | Verifies that the organisation triage view shows metadata only |

## Preconditions and fixture setup

1. Lane 02's handoff tickets exist: an escalated booking case, an URGENT ticket with a valid phone, and a ticket with a forged marker or invalid phone attempt.
2. Operators are not enrolled unless lane 01 said so. Enrolment is a write: record it.
3. Back-dating SLA timestamps is a write: record the originals and restore them.

```sql
-- record before
select id, status, priority, "ackDueAt", "resolutionDueAt", "awaitingUserSince", "pausedSeconds", "acknowledgedAt", "firstAgentReplyAt", "assignedToId"
from "SupportTicket" where id in ('<handoff ids>');
-- back-date one tagged ticket for the breach cases (truncate to milliseconds)
update "SupportTicket"
set "ackDueAt" = date_trunc('milliseconds', now() - interval '3 days'),
    "resolutionDueAt" = date_trunc('milliseconds', now() - interval '1 day')
where id = '<tagged ticket id>';
```

## Case table

| ID | Actor | Steps | Expected | Tag |
| --- | --- | --- | --- | --- |
| SFR-03-01 | Staff and admin | Enrol both operators through the API recipe in the shared setup. Call `GET /api/staff/support-inbox` before and after. | 428 `TWO_FACTOR_REQUIRED` before, 200 after. | [SUBSYSTEM] |
| SFR-03-02 | Staff, browser | Sign a second operator in through the UI and complete setup, then sign out and sign in again. | Setup is about five steps with clear copy ("Staff accounts need an authenticator app"), backup codes are shown once with a copy or download affordance, the later sign-in asks for the authenticator code with a backup-code link and "Start over". A second sign-in elsewhere revokes the first session with a clear message. | [SUBSYSTEM] |
| SFR-03-03 | Staff | Use the inbox filters: view, sort, priority, status, scope and search. | Every filter changes the list as labelled and the tile counts agree with the list. | [SUBSYSTEM] |
| SFR-03-04 | Staff | Back-date a tagged ticket past both clocks and open the inbox with the default sort, then `sort=sla` and the "SLA at risk" view. | The breached ticket shows a distinct "Breached" state and the breach tile counts it. The default sort surfaces breaches near the top. Acknowledgement-due and resolution-due are shown as two separate clocks. | [SUBSYSTEM] [CX-C3] |
| SFR-03-05 | Staff | Open a ticket whose `awaitingUserSince` is set in the past. | The case labels "waiting on customer" and does not show a past resolve-by date next to a future countdown. | [SUBSYSTEM] [CX-C3] |
| SFR-03-06 | Staff | Open the escalated booking case. | One click shows the whole transcript, customer name, email, phone, booking link and payment identity; nothing important sits behind a second click. | [SUBSYSTEM] [CX-C2] |
| SFR-03-07 | Staff | Read the timeline after the customer sent a follow-up that was mirrored between ticket and thread. | Each follow-up appears once, with the customer's name, not twice (once named and once as "Customer"). | [PR-specific] |
| SFR-03-08 | Staff | Open the URGENT ticket with a valid phone. Look at the inbox row and the details panel. | A prominent "Callback requested" indicator is visible in the inbox row itself, and the details panel offers a `tel:` link containing digits and the plus sign only. | [PR-specific] |
| SFR-03-09 | Staff | Open the tickets from SFR-02-10 and SFR-02-11 (rejected phone, forged marker). | No callback badge and no `tel:` link exist for customer-typed text; a script string is never rendered as an element. The badge appears only for a marker the server wrote. | [PR-specific] |
| SFR-03-10 | Staff and admin | Compare what each role sees of requester email and phone, in the inbox list payload and on the case. | Contact fields appear only on the case detail, not on every list row; the difference between staff and admin is documented in the report. | [PR-specific] |
| SFR-03-11 | Staff | Send a public reply and an internal note on the escalated case. | The public reply creates an AGENT `SupportMessage` and a public `SupportResponse`; the internal note exists only as an internal response; the customer's API, UI and bell contain no internal text. | [PR-specific] |
| SFR-03-12 | Staff | Reply through the booking thread API on an `OPEN` ticket. | 201; the ticket becomes `IN_PROGRESS`; a public `SupportResponse` is mirrored; the thread stays `ESCALATED`. | [PR-specific] |
| SFR-03-13 | Staff | Patch the ticket through OPEN, RESOLVED, CLOSED and back, and patch the thread through RESOLVED and CLOSED. | Timestamps are consistent: `resolvedAt` set on resolve, `closedAt` set on close with `resolvedAt` kept, both cleared on reopen; the thread status follows. | [PR-specific] |
| SFR-03-14 | Staff and admin | Open the case in each role and look for "Escalate to Engineering". Decode the generated issue URL without opening it. | Only an admin sees the control. The body carries only the case key and reference, no appointment id, no backoffice path, name, email or phone. The control never submits anything. | [PR-specific] |
| SFR-03-15 | Staff | Send a public reply and an internal note on a `CLOSED` ticket. | The public reply is refused with 400 "Cannot send a public reply to a closed ticket"; the internal note is allowed; the composer is disabled for public replies with a "Reopen to reply" hint instead of failing after Send. | [PR-specific] |
| SFR-03-16 | Staff | Assign the ticket to a consultant id, to an unknown id, to a staff user and to an admin. | The first two return 400 "Invalid assignee - must be staff or admin"; the last two return 200; assignment works on a closed ticket and the timeline is unchanged. | [SUBSYSTEM] |
| SFR-03-17 | Organisation owner | Read the organisation triage view for a thread linked to the organisation (set `organizationId` temporarily and restore it). | An allowlisted payload only: ids, category, status, dates, member name and plan title; no message text; the UI says it is shown as status only. | [SUBSYSTEM] |
| SFR-03-18 | Staff | Fire a Resolve and a public reply at the same ticket in parallel, six times, starting from `OPEN`. After each run read the ticket. | A staff reply never reopens a resolved ticket. The final state is never "in progress with `resolvedAt` set"; either the resolve wins and the reply is still saved and sent, or one side gets a clear 409. The customer is never told "resolved" while the row says otherwise. | [PR-specific] |
| SFR-03-19 | Staff | Reopen a `CLOSED` ticket and reply publicly. Inspect the thread and the customer's conversation. | The thread reopens together with the ticket (or the reply is mirrored regardless of thread status); the customer's conversation never says "closed" while the ticket is open; the thread and ticket routes agree. | [PR-specific] |
| SFR-03-20 | Staff, two tabs | In tab A resolve a ticket; in a stale tab B close it, then change its priority. | A stale write is rejected with a 409 and a refresh message, or the UI shows a "changed by someone else" notice; labels do not stay stale after a mutation; a "claimed by" marker shows the current owner. | [PR-specific] [CX-C5] |
| SFR-03-21 | Staff | Change priority from MEDIUM to HIGH on a ticket. | `ackDueAt` and `resolutionDueAt` are recomputed for the new priority (or the UI says they are unchanged and why). | [SUBSYSTEM] [CX-C3] |
| SFR-03-22 | Staff | After the actions above, read `NotificationOutbox` for the ticket and the customer's bell. | Staff fan-out rows exist for created and activity events; one row per public reply; none for internal notes; the customer's bell shows each reply with the quoted text, ideally grouped when several arrive in minutes. | [SUBSYSTEM] |
| SFR-03-23 | Staff | Read the escalated case for the promises the bot made to the customer (refund time, callback, ETA). | The promises are extracted and shown to the agent as a distinct block, not buried in raw transcript lines. | [SUBSYSTEM] [CX-C8] |
| SFR-03-24 | Staff | Look for two open tickets on the same booking, with the customer's second ticket from SFR-02-24. | The inbox flags the duplicate and offers merge; an agent does not answer both blindly. | [SUBSYSTEM] [CX-C4] |
| SFR-03-25 | Staff | Reassign the same ticket four times between operators. | Reassignment asks for a note; the new owner sees the full timeline and linked entities; an alert shows after three hops. | [SUBSYSTEM] [CX-C1] [CX-C2] |
| SFR-03-26 | Staff | Read the audit trail for the case. | Every status, owner, priority and visibility change shows actor, time and before and after values. | [SUBSYSTEM] [CX-C6] |
| SFR-03-27 | Staff | Open a ticket category of grievance type and check the clocks. | The case shows acknowledgement due within 24 hours and dispose due within 15 days as two distinct states, and enforces the stricter clock for the ticket type. | [SUBSYSTEM] India IT Rules r.3(2) |
| SFR-03-28 | Staff | Put a ticket on hold, if a seeded or created `ON_HOLD` ticket exists. | The hold state, reason and customer-facing wording exist; the clock pause is visible; hold is reversible. If no hold flow exists, mark NOT RUN with the seed gap. | [SUBSYSTEM] |
| SFR-03-29 | Staff | Check accessibility of the staff composer and inbox with the keyboard and a snapshot. | Labels, focus order, announced errors and keyboard operation for filters, row open and send all work; the disabled composer state is exposed to assistive technology. | [SUBSYSTEM] |
| SFR-03-30 | Staff | Send a public reply that includes text that looks like markup. | The customer sees it escaped as text; nothing executes in the customer or staff view. | [SUBSYSTEM] |

## Database assertions

- After SFR-03-18, for every run: `select status, "resolvedAt", "closedAt" from "SupportTicket" where id = '<id>'` never returns `IN_PROGRESS` with a non-null `resolvedAt`, and exactly one public `SupportResponse` exists per reply sent.
- After SFR-03-13: the timestamp matrix of the status transitions matches the expected column.
- After SFR-03-19: thread and ticket statuses are consistent.
- After SFR-03-22: `select template, recipient, status from "NotificationOutbox" where "entityRef" = 'ticket:<id>'` has no row created by an internal note.

## Cleanup

Restore every back-dated timestamp and every changed status, priority, assignee and `organizationId` to the recorded originals, remove temporary SQL edits, and keep the lane's tagged tickets for lane 06 only if later lanes need them. Two-factor enrolment is kept until lane 05 finishes and is reverted in lane 06.

## Handoff to lane 05

State which operators are enrolled and where their secrets are stored locally, and which jars are current.

## Report section

Verdict table for SFR-03-01 to SFR-03-30; detail for each FAIL and PARTIAL (race run counts, ticket states, response bodies); staff-experience observations (how many clicks to full context, how visible urgency is); fixtures and restores.
