# Lane 06 — Cleanup, global sweep and Sentry

> **Required reading:** [`_shared/shared-setup.md`](./_shared/shared-setup.md) section 7. Output: `{AUDIT_DIR}/06-report.md`. This lane deletes and restores; run it after lanes 01 to 05 and read every earlier Fixtures section first.

## Purpose

Leave the shared database exactly as found, prove it with a sweep across every text column, and check whether the failures the run provoked reached Sentry. A silent 500 that never reaches Sentry is a finding in its own right.

## Personas and accounts

An admin session for the Supabase MCP is not needed; the lane works through the Supabase MCP, the Storage API (with the service-role key) and the Sentry CLI or MCP. Staff and admin cookie jars are only needed for the final two-factor verification.

## Preconditions

1. Lanes 01 to 05 each produced a report with a Fixtures section. Merge them into one list of rows to remove and rows to restore.
2. The list of handoff tickets from lane 02, the enrolled operators from lane 03, the touched consultants from lane 04 and the flipped dispute from lane 05 is at hand.

## Case table

| ID | Actor | Steps | Expected | Tag |
| --- | --- | --- | --- | --- |
| SFR-06-01 | Agent | Count the rows to be removed before deleting (tickets, responses, messages, threads, flow outcomes, outbox rows, attachments, reviews, feedback, reports, actions). | Counts match the lane reports; any surprise is investigated before deleting. | [SUBSYSTEM] |
| SFR-06-02 | Agent | Delete support fixtures in dependency order in one statement batch: `SupportResponse`, `SupportTicketAttachment`, `SupportMessage`, `AppointmentSupportThread`, `SupportFlowOutcome` (no tag: match by the run users and the run time window), `NotificationOutbox` (by `entityRef`, and by recipient, time and payload text for rows with a null `entityRef`, such as platform-escalation `refund-requested` rows), `SupportTicket`. | Each statement returns the expected row count; no foreign-key error remains. | [SUBSYSTEM] |
| SFR-06-03 | Agent | Delete review, moderation and feedback fixtures: `ModerationAction`, `ModerationReport`, `ConsultantReview` (revisions go with it), `AppointmentFeedback`, `PlatformFeedback`. | Immutability triggers allow the parent delete; counts match. | [SUBSYSTEM] |
| SFR-06-04 | Agent | Restore every touched `ConsultantProfile` score row by explicit update to the recorded values, including `ratingAggregatedAt`, then re-read. | The row equals the baseline from lane 01 and lane 04. A value that cannot be restored (for example a lost original) is listed under residue. | [SUBSYSTEM] |
| SFR-06-05 | Agent | Restore the flipped dispute and every `excludedFromAggregateAt` flag and organisation id edit. | The dispute row equals the baseline; excluded-row counts equal the lane 01 counts; `AppointmentFeedback` rows with an organisation id equal the baseline count. | [SUBSYSTEM] |
| SFR-06-06 | Agent | Revert two-factor enrolment with the SQL in the shared setup section 5. Operators cannot self-disable by design (the API disable returns 403 `TWO_FACTOR_REQUIRED`), so SQL is the only route. | Zero `"twoFactor"` rows for the operators and `twoFactorEnabled` false; the secrets file and jars are deleted. | [SUBSYSTEM] |
| SFR-06-07 | Agent | Remove uploaded support attachments through the Storage API with the service-role key, by the object paths recorded in the lane reports (including objects whose database row was already deleted), and list the bucket by prefix to confirm none remains for the run. Never delete with SQL on the storage tables. | No object created since the run started remains in the support bucket. | [SUBSYSTEM] |
| SFR-06-08 | Agent | Sweep `"FailedEmail"` for rows referencing the run (recipient, subject, body) and delete them. | A queued retry would re-send mail, so the table must hold no run row. | [SUBSYSTEM] |
| SFR-06-09 | Agent | Global sweep: for every base table in the public schema, find text, varchar, json, jsonb and array columns and count rows that contain `{RUN_TAG}`. | The generated query returns zero rows in every table. | [SUBSYSTEM] |
| SFR-06-10 | Agent | Record residue: vendor in-app notifications, consumed ticket references (read the counter row), sign-in sessions, the public-cache lag. | Residue list is written; the counter value is recorded. | [SUBSYSTEM] |
| SFR-06-11 | Agent | Sentry: list issues active in the last 24 hours for the project and look for the routes the run exercised. | Any new issue from support, review, moderation or dispute routes is reported with its first-seen time; none is expected apart from known background issues. | [SUBSYSTEM] |
| SFR-06-12 | Agent | Sentry: first read the organisation's `stats_v2` outcomes for the window; if the quota is exhausted, nothing can be visible and the case is BLOCKED with that evidence. Otherwise search 14 days for the Prisma error classes (`PrismaClientKnownRequestError`, `P2022`, `P2021`) and for the missing column names found in SFR-01-01. | If lane 01 found drift and the run provoked 500s from it, those errors should be visible. Record whether they reached Sentry; on 2026-10-09 the Prisma `P2022` 500s did not reach Sentry, so an absence is not proof of health and is itself a finding. | [SUBSYSTEM] |
| SFR-06-13 | Agent | Close the browser pages and delete local files: list every `/tmp/qa-*` directory the lanes used (the directory name follows the PR number the lane was given and can differ between lanes), the temporary credential files, and `{AUDIT_DIR}/totp.json`. | One page or none; no secrets remain on disk. | [SUBSYSTEM] |

## Global sweep query shape (SFR-06-09)

One query counts every candidate column through `query_to_xml`, so the sweep needs a single statement instead of one per column:

```sql
select c.table_name, c.column_name, x.hits
from information_schema.columns c
join information_schema.tables t using (table_schema, table_name),
lateral (
  select (xpath('/row/c/text()', query_to_xml(
    format('select count(*) as c from public.%I where %I::text like %L',
           c.table_name, c.column_name, '%{RUN_TAG}%'), false, true, '')))[1]::text::int as hits
) x
where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
  and c.data_type in ('text','character varying','json','jsonb','ARRAY')
  and x.hits > 0;
```

Because `[` and `]` are not special in `like`, the tag matches literally. Report the number of tables and columns scanned (the same `from` and `where` clauses with `count(*)`) and every hit. The sweep cannot match untagged rows such as `SupportFlowOutcome`; those are checked by user and time window in SFR-06-02.

## Database assertions

- `select count(*) from "SupportTicket"` equals the lane 01 baseline.
- Score rows, dispute row and exclusion counts equal their baselines.
- `select count(*) from "twoFactor" where "userId" in (<operators>)` is zero.

## Cleanup

This lane is the cleanup. If any assertion fails, fix it and re-run the sweep before reporting.

## Report section

Verdict table for SFR-06-01 to SFR-06-13, the exact statements run and their row counts, the sweep size and result, the residue list, and the two Sentry results (issues and Prisma errors), each stated as observed.
