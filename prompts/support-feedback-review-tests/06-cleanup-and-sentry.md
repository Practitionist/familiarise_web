# Lane 06 — Cleanup, global sweep and Sentry

> **Required reading:** [`_shared/shared-setup.md`](./_shared/shared-setup.md) section 7. Output: `{AUDIT_DIR}/L6-report.md`. This lane deletes and restores; run it after lanes 01 to 05 and read every earlier Fixtures section first.

## Purpose

Leave the shared database exactly as found, prove it with a sweep across every text column, and check whether the failures the run provoked reached Sentry. A silent 500 that never reaches Sentry is a finding in its own right.

## Personas and accounts

An admin session for the Supabase MCP is not needed; the lane works through the Supabase MCP, the storage API and the Sentry CLI or MCP. Staff and admin cookie jars are only needed for the final two-factor verification.

## Preconditions

1. Lanes 01 to 05 each produced a report with a Fixtures section. Merge them into one list of rows to remove and rows to restore.
2. The list of handoff tickets from lane 02, the enrolled operators from lane 03, the touched consultants from lane 04 and the flipped dispute from lane 05 is at hand.

## Case table

| ID | Actor | Steps | Expected | Tag |
| --- | --- | --- | --- | --- |
| SFR-06-01 | Agent | Count the rows to be removed before deleting (tickets, responses, messages, threads, flow outcomes, outbox rows, attachments, reviews, feedback, reports, actions). | Counts match the lane reports; any surprise is investigated before deleting. | [SUBSYSTEM] |
| SFR-06-02 | Agent | Delete support fixtures in dependency order in one statement batch: `SupportResponse`, `SupportTicketAttachment`, `SupportMessage`, `AppointmentSupportThread`, `SupportFlowOutcome`, `NotificationOutbox` (by `entityRef`), `SupportTicket`. | Each statement returns the expected row count; no foreign-key error remains. | [SUBSYSTEM] |
| SFR-06-03 | Agent | Delete review, moderation and feedback fixtures: `ModerationAction`, `ModerationReport`, `ConsultantReview` (revisions go with it), `AppointmentFeedback`, `PlatformFeedback`. | Immutability triggers allow the parent delete; counts match. | [SUBSYSTEM] |
| SFR-06-04 | Agent | Restore every touched `ConsultantProfile` score row by explicit update to the recorded values, including `ratingAggregatedAt`, then re-read. | The row equals the baseline from lane 01 and lane 04. A value that cannot be restored (for example a lost original) is listed under residue. | [SUBSYSTEM] |
| SFR-06-05 | Agent | Restore the flipped dispute and every `excludedFromAggregateAt` flag and organisation id edit. | The dispute row equals the baseline; excluded-row counts equal the lane 01 counts; `AppointmentFeedback` rows with an organisation id equal the baseline count. | [SUBSYSTEM] |
| SFR-06-06 | Agent | Revert two-factor enrolment with the SQL in the shared setup section 5 (the API disable returns 403 `TWO_FACTOR_REQUIRED`). | Zero `"twoFactor"` rows for the operators and `twoFactorEnabled` false; the secrets file and jars are deleted. | [SUBSYSTEM] |
| SFR-06-07 | Agent | Remove uploaded support attachments from storage through the storage API and confirm none remains for the run. | No object created since the run started remains in the support bucket. | [SUBSYSTEM] |
| SFR-06-08 | Agent | Sweep `"FailedEmail"` for rows referencing the run (recipient, subject, body) and delete them. | A queued retry would re-send mail, so the table must hold no run row. | [SUBSYSTEM] |
| SFR-06-09 | Agent | Global sweep: for every base table in the public schema, find text, varchar, json, jsonb and array columns and count rows that contain `{RUN_TAG}`. | The generated query returns zero rows in every table. | [SUBSYSTEM] |
| SFR-06-10 | Agent | Record residue: vendor in-app notifications, consumed ticket references (read the counter row), sign-in sessions, the public-cache lag. | Residue list is written; the counter value is recorded. | [SUBSYSTEM] |
| SFR-06-11 | Agent | Sentry: list issues active in the last 24 hours for the project and look for the routes the run exercised. | Any new issue from support, review, moderation or dispute routes is reported with its first-seen time; none is expected apart from known background issues. | [SUBSYSTEM] |
| SFR-06-12 | Agent | Sentry: search 14 days for the Prisma error classes (`PrismaClientKnownRequestError`, `P2022`, `P2021`) and for the missing column names found in SFR-01-01. | If lane 01 found drift and the run provoked 500s from it, those errors should be visible. Record whether they reached Sentry; on 2026-10-09 the Prisma `P2022` 500s did not reach Sentry, so an absence is not proof of health and is itself a finding. | [SUBSYSTEM] |
| SFR-06-13 | Agent | Close the browser pages and delete local files in `/tmp/qa-{PR_NUMBER}/` and `{AUDIT_DIR}/totp.json`. | One page or none; no secrets remain on disk. | [SUBSYSTEM] |

## Global sweep query shape (SFR-06-09)

Generate one count query per column from `information_schema.columns`, then run the batch:

```sql
select 'select ''' || table_name || '.' || column_name || ''' as col, count(*) from "' || table_name || '" where "' || column_name || '"::text like ''%{RUN_TAG}%'' having count(*) > 0;'
from information_schema.columns c
join information_schema.tables t using (table_schema, table_name)
where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
  and c.data_type in ('text','character varying','json','jsonb','ARRAY');
```

Because `[` and `]` are not special in `like`, the tag matches literally. Run the generated statements in batches; a table with a quoted camel-case name needs the quotes shown. Report the number of tables and columns scanned and every hit.

## Database assertions

- `select count(*) from "SupportTicket"` equals the lane 01 baseline.
- Score rows, dispute row and exclusion counts equal their baselines.
- `select count(*) from "twoFactor" where "userId" in (<operators>)` is zero.

## Cleanup

This lane is the cleanup. If any assertion fails, fix it and re-run the sweep before reporting.

## Report section

Verdict table for SFR-06-01 to SFR-06-13, the exact statements run and their row counts, the sweep size and result, the residue list, and the two Sentry results (issues and Prisma errors), each stated as observed.
