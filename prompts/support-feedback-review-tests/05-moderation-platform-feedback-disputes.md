# Lane 05 — Moderation, platform feedback and disputes

> **Required reading:** [`_shared/shared-setup.md`](./_shared/shared-setup.md) and [`_shared/complaint-catalogue.md`](./_shared/complaint-catalogue.md). Output: `{AUDIT_DIR}/05-report.md`. Staff and admin must still be enrolled for two-factor from lane 03.

## Purpose

Prove that a review report is a fair, transparent process: an expert can file it with the right reason, staff see the context to decide, an exclusion from the rating is applied, labelled and told to both parties, removal of a review is an admin decision, and every action is audited. Then prove the two adjacent queues: platform feedback (including whether the submitter hears back) and payment disputes (staff and admin reads, evidence redaction, the evidence form, deadline visibility, organisation scoping).

## Personas and accounts

| Persona | Use |
| --- | --- |
| Consultant X | Files the report against a review |
| Reviewer | Author of the reported review (a consultee account) |
| Staff operator | Moderation queue, platform feedback, dispute read |
| Admin operator | Admin-only gates, dispute detail and evidence form |
| Organisation owner | Organisation disputes tab; the owner of an organisation that has a dispute, picked by query |

## Preconditions and fixture setup

1. Never report or act on a real customer's review. Create tagged reviews through the review API as a consultee for a consultant who is not at the five-client gate, or for the gate consultant only when you have recorded the restore values.
   Review plan: the lane needs three live tagged reviews on three different pairs. R1 hosts reporting, exclusion, repeat, feedback exclusion and dismissal (SFR-05-01 to SFR-05-08, SFR-05-11 to SFR-05-13); R2 hosts the staff and admin removal (SFR-05-09); R3 hosts the direct admin delete (SFR-05-10). Only held occurrences are rateable, so if lane 01 found fewer than three pairs, set a `NOBODY_JOINED` occurrence outcome to NULL temporarily, record it, and restore it. A review removed by moderation cannot be reused, so never share R2 or R3 with another case.
2. Record before values:

```sql
-- gate consultant, if used
select id, "publishedRatingOneToOne", "ratedClientsOneToOne", "ratingAggregatedAt", "updatedAt"
from "ConsultantProfile" where id = '<consultant>';
-- dispute to flip, if no Razorpay NEEDS_RESPONSE dispute exists
select id, gateway, status, "dueBy", "evidenceSubmittedAt", "updatedAt" from "Dispute" where id = '<dispute>';
select count(*) from "ConsultantReview" where "excludedFromAggregateAt" is not null;
select count(*) from "AppointmentFeedback" where "excludedFromAggregateAt" is not null;
```

3. Flip the `WON` Razorpay dispute picked by query in lane 01 to the response-needed state only for SFR-05-15 and SFR-05-20, with a near `dueBy`. Clear `evidenceSubmittedAt` as well, otherwise the page keeps an "Evidence Submitted" banner on a dispute that needs a response:

```sql
update "Dispute" set status = 'NEEDS_RESPONSE', "evidenceSubmittedAt" = null, "dueBy" = date_trunc('milliseconds', now() + interval '2 days') where id = '<dispute>';
```

4. Never submit dispute evidence and never ban or suspend a seed account.
5. `/api/report` has its own rate-limit key (read the budget from code); use separate reporter accounts for separate reports.

## Case table

| ID | Actor | Steps | Expected | Tag |
| --- | --- | --- | --- | --- |
| SFR-05-01 | Consultant X, browser and API | Report a tagged review through "Report review"; repeat the report as the same user. | The UI and `POST /api/report` create a `PENDING` `ModerationReport` with a snapshot of the review text and return 201 with a report id; the duplicate is rejected with 400 "already reported". | [SUBSYSTEM] [CX-B6] |
| SFR-05-02 | Consultant X | Read the reason picker and the confirmation after submit. | The picker offers coercion or retaliation as a reason; the confirmation shows a reference, a response-time promise and what happens next, not a bare toast. | [SUBSYSTEM] [CX-B1] [CX-B6] |
| SFR-05-03 | Consultant X | After reporting, look for a place to see the report's status. | The expert can open a list or page of their reports with status and outcome; a report ends with a notification when it is resolved. | [SUBSYSTEM] [CX-B6] |
| SFR-05-04 | Staff, browser | Open the queue card and the detail dialog for the report. | The dialog shows review text and rating, reporter, reported author, consultant, the reason in plain words (not a raw enum), the reporter's description, the audit trail, and the booking, refund, ticket and dispute context of the same appointment; it warns when excluding would drop a consultant below the publish gate. | [SUBSYSTEM] [CX-B2] |
| SFR-05-05 | Staff | `PATCH` the report with an assignee of consultant role, an unknown id, a bad enum, an array body, non-JSON and a wrong field type. | Each returns 400 (Zod) with "Assignee must be a staff or admin user" for the role cases; a staff or admin assignee returns 200. | [PR-specific] |
| SFR-05-06 | Staff | Take the "Exclude from rating" action on the report. Read the review's public page and the expert's dashboard. | Requirement for the expert dashboard explanation (it may not exist yet; record FAIL "absent"). The report becomes `ACTION_TAKEN` with `excludedFromAggregateAt` set and a `REVIEW_EXCLUDED_FROM_AGGREGATE` action by the staff user; the score recomputes. The review stays visible publicly, labelled "Not counted in rating" with the reason; the expert's dashboard shows why a score changed or disappeared instead of a bare dash. | [PR-specific] [CX-B4] |
| SFR-05-07 | Staff | After SFR-05-06, check notifications for the expert and the reporter. | Requirement (the notifications may not exist yet; record FAIL "absent"): `NotificationOutbox` (or the notification vendor) holds a message to the expert and to the reporter stating the decision and the reason in plain words, without the internal moderator note verbatim. | [PR-specific] [CX-B4] [CX-B6] |
| SFR-05-08 | Staff | Repeat the exclusion on the same report. | 409 "This report has already been resolved"; no new action row. | [PR-specific] |
| SFR-05-09 | Staff and admin | Take `CONTENT_REMOVED` on a REVIEW report as staff, then as admin; also call the direct review DELETE as staff. | Removal of a review is admin-only everywhere: staff receive 403 on `CONTENT_REMOVED` for a review report as well as on DELETE; the admin succeeds and the review is soft-deleted with `removedBy = MODERATION`, hidden publicly, and the author is told with a reason written for the author. | [PR-specific] |
| SFR-05-10 | Admin and author | Admin deletes the tagged review R3 directly (a review separate from the one used in SFR-05-09); the author tries to edit, delete and re-review. | `REVIEW_REMOVED` action by the admin, review hidden; author PUT and DELETE return 404; author POST returns 409 "removed by our moderation team and can't be edited"; deleting an already-removed review does not claim a new action. | [SUBSYSTEM] |
| SFR-05-11 | Staff | Take `FEEDBACK_EXCLUDED` with a `feedbackId` that belongs to the report's reviewed appointment, then with a `feedbackId` from another appointment of the same author. | The related feedback is excluded; the unrelated one is rejected with 400 or 409; only feedback tied to the reported subject can be excluded under that report. | [PR-specific] |
| SFR-05-12 | Staff | Exclude feedback that is already excluded, through a second report. The same review can be re-reported by a second reporter after its first report was resolved; use that route. | The conditional write affects zero rows and returns 409; no new audit row claims an effect that did not happen; the report is not flipped to `ACTION_TAKEN` by a no-op. | [PR-specific] |
| SFR-05-13 | Staff | Dismiss a report with `NO_ACTION` and a reason. | The report becomes `DISMISSED` with the resolver recorded; the reporter receives a message with the reason and the policy; dismissal is not silent. | [SUBSYSTEM] [CX-B6] |
| SFR-05-14 | Consultant X | After a decision, look for an appeal route. | The decision notice and the report page state how to appeal (reply to the case, or the grievance appellate route) and the response time. | [SUBSYSTEM] [CX-B10] India IT Rules |
| SFR-05-15 | Admin and staff | Open a Razorpay dispute in `NEEDS_RESPONSE` and its evidence form (do not submit). | The detail page and `GET /api/admin/disputes/<id>` return 200, the form renders with the deadline, the amount and the required evidence fields, and the payment relation loads. With schema drift present, mark BLOCKED and cite SFR-01-01. | [PR-specific] [ENV] |
| SFR-05-16 | Staff | Platform feedback queue: search a tagged phrase, filter by status, pass `status=FOO`, `page=abc` and `limit=1000`. | Counts follow the search; `status=FOO` and `page=abc` return 400; `limit` is clamped to 100; the acknowledged badge renders; status changes through PATCH work and an invalid status returns 400. | [PR-specific] |
| SFR-05-17 | Staff and submitter | Change a feedback item to acknowledged and to resolved, with a response text. | The submitter is notified of each status change; the response text is stored and shown to the submitter, or the field is not offered at all (it must not be silently ignored). | [SUBSYSTEM] |
| SFR-05-18 | Staff and admin | Read a dispute as staff and as admin through the list `GET /api/payments/disputes` and `GET /api/admin/disputes`, and through the detail `GET /api/admin/disputes/<id>`. The lists never carry evidence; the evidence and billing details are on the detail route. | Staff can read disputes, with evidence and billing PII (customer name, email, billing address) redacted on the detail route unless the viewer may manage disputes; admin sees the full evidence; staff `POST` returns 403. | [PR-specific] |
| SFR-05-19 | Admin | Query `/api/admin/disputes` with `status=BOGUS`, `gateway=X`, `limit=10000`, and each valid status including the warning and charge-refunded states. | Bad values return 400 with the option list; `limit` is clamped to 100; the filter lists every status with a label. | [PR-specific] |
| SFR-05-20 | Admin | With a disputed row flipped near its deadline (SFR-05-15 fixture), read the list and detail. Also read any dispute whose `dueBy` is in the past. | A deadline countdown shows on the detail and list; overdue disputes are flagged distinctly; the urgent tile counts disputes due soon; the expert gets an immediate dispute notice with the deadline. | [SUBSYSTEM] [CX-B8] |
| SFR-05-21 | Organisation owner | Open the organisation disputes tab and call the API for another organisation. | Own organisation: 200 with its own disputes only; another organisation: 403 "Not a member of this organization". If no organisation-linked dispute exists, record that positive scoping is unproven. | [SUBSYSTEM] |
| SFR-05-22 | Staff | Read the audit trail on the queue card and in the detail dialog after each action. | Every action has a `ModerationAction` row with actor, time, report, review or feedback id and notes; the card shows "Last action: … by <name>"; a direct admin delete records a reason field. | [SUBSYSTEM] [CX-C6] |
| SFR-05-23 | Staff, two tabs | Open the same report in two tabs, act in one, then act in the stale one. | The stale write fails with 409 and a clear refresh message, because the client sends its expected status or `updatedAt`. | [PR-specific] [CX-C5] |
| SFR-05-24 | Two experts | File two reports on the same review from two accounts, with different descriptions. | `reportCount` is 2 and the moderator can see both descriptions. The report model holds one description field, so record where the second description is kept; if it is not visible anywhere, FAIL "absent" (requirement). | [SUBSYSTEM] |
| SFR-05-25 | Anyone, signed out | Look for the grievance officer's name and contact, and the escalation and appeal steps. | They are public on the help or legal page and linked from the report confirmation. | [SUBSYSTEM] India IT Rules, E-Commerce Rules |
| SFR-05-26 | Consultee and expert | Read the booking flow for the dispute window and the chargeback notice. | The window is shown at booking and at session end; an expert whose payment is disputed is told at once with the deadline and the evidence assembled for them. | [SUBSYSTEM] [CX-A8] [CX-B8] |
| SFR-05-27 | Staff and admin | Try `USER_BANNED`, `USER_SUSPENDED` and unban as staff, and as admin on a throwaway account the run created. | Staff receive 403 "requires an admin" for each; the admin path works only on a throwaway account; no seed account is touched. | [SUBSYSTEM] |
| SFR-05-28 | Consultant X and staff | File a report described as extortion ("refund or I keep the one star") with evidence. | The review is held pending decision, or the moderator sees an extortion flag; the expert is told the review is under review. | [SUBSYSTEM] [CX-B1] |
| SFR-05-29 | Staff | Keyboard-only walk of the moderation dialog: open, focus trap, action buttons, notes field, close. | Focus is trapped and returned, every action is reachable, destructive actions need confirmation, and errors are announced. | [SUBSYSTEM] |
| SFR-05-30 | Anyone | Find the published moderation and exclusion policy. | The page explains what is excluded from ratings and why, that incentivised reviews are labelled and excluded, and that moderation is the same regardless of sentiment. | [SUBSYSTEM] India BIS IS 19000 |

## Database assertions

- Report state: `select id, status, "reportCount", "resolvedById" from "ModerationReport" where id = '<id>'`.
- Actions: `select "actionType", "takenById", "reportId", notes from "ModerationAction" where "reportId" = '<id>' order by "createdAt"` shows one row per real effect and none for a refused action.
- Exclusion flags: `excludedFromAggregateAt` is set on the exact review or feedback row and on no other.
- Notifications: `select template, recipient from "NotificationOutbox" where payload::text like '%{RUN_TAG}%'` includes the expert and reporter messages (when the feature exists; see SFR-05-07).
- Dispute restore: the flipped dispute equals its recorded original row.

## Cleanup

Delete `ModerationAction`, then `ModerationReport`, `ConsultantReview` (and its revisions through the parent) and `PlatformFeedback` rows the lane created, plus their `NotificationOutbox` rows. Set `excludedFromAggregateAt` back to NULL on the exact review and feedback rows touched and compare the excluded-row counts with the baseline. Restore the flipped dispute with an explicit update of `status`, `dueBy`, `evidenceSubmittedAt` and `updatedAt`, restore the gate consultant's score columns, and verify each by reading.

## Report section

Verdict table for SFR-05-01 to SFR-05-30; detail for each FAIL, PARTIAL and BLOCKED (with the drift reference); the expert's, reporter's and moderator's experience in plain words; fixtures with before and after values.
