# Lane 01 — Preflight: schema drift, sign-in, two-factor status and fixtures

> **Required reading:** [`_shared/shared-setup.md`](./_shared/shared-setup.md) and [`_shared/complaint-catalogue.md`](./_shared/complaint-catalogue.md). This lane is read-only: it makes no database writes. Its output is `{AUDIT_DIR}/L1-report.md` and `{AUDIT_DIR}/fixtures.json`.

## Purpose

Prove the environment can support the run before any lane spends a rate-limit token. On 2026-10-09 the live database lacked a whole earlier schema change, every dispute read returned 500, and production pages that read full `Payment` rows failed too. A schema-drift check is therefore the first case of the suite. The lane also confirms health, sign-in for every persona, the two-factor state of every operator, and discovers the fixtures the later lanes need.

## Personas and accounts

All seed accounts come from [`docs/team/mock-credentials.md`](../../docs/team/mock-credentials.md): one admin, one staff operator, three consultee accounts, one or two consultants with published scores, and one organisation owner. Sign in with curl jars (shared setup section 4). The sign-in limiter allows 30 per 15 minutes per IP, so sign each persona in exactly once.

## Preconditions

- The preview answers `GET {PREVIEW_URL}/api/health`.
- The Supabase MCP is connected to the same database the preview uses (the preview shares the production database).
- You can read the pull-request head with `git show origin/{BRANCH}:<path>`.

## Case table

| ID | Actor | Steps | Expected | Tag |
| --- | --- | --- | --- | --- |
| SFR-01-01 | Agent (read-only SQL) | Run the drift procedure in the Drift section for `Payment`, `Dispute`, `SupportTicket`, `SupportResponse`, `SupportMessage`, `AppointmentSupportThread`, `SupportFlowOutcome`, `SupportTicketAttachment`, `ConsultantReview`, `ConsultantReviewRevision`, `AppointmentFeedback`, `ModerationReport`, `ModerationAction`, `PlatformFeedback`, `NotificationOutbox`, `OrganizationEarnings`, `CreditPoolConfig`, `organizations`, `ConsultantProfile`, `twoFactor`, `users`. | Every column the Prisma schema declares exists in the live table with a compatible type; every sidecar unique, check and trigger named in `prisma/sql/*.sql` exists; every foreign-key delete rule matches the schema. Any gap is a P0 `[ENV]` finding with the exact missing objects listed. | [SUBSYSTEM] |
| SFR-01-02 | Agent | If SFR-01-01 found drift, probe read paths without writing: the dispute list and detail endpoints as admin, and one full-row `Payment` reader on the preview (for example the consultee pending-payments route). Record statuses and the response error text. | The probe shows exactly which routes break, so the orchestrator can decide whether to continue. With no drift every probe returns 200. | [SUBSYSTEM] |
| SFR-01-03 | Agent | `GET {PREVIEW_URL}/api/health` twice. | 200 both times; the second is faster (warm). Record both latencies. | [SUBSYSTEM] |
| SFR-01-04 | Browser | Open the sign-in page in the chrome-devtools MCP and take a snapshot. | The page renders and the MCP drives it. If the profile is locked, switch to the `puppeteer-core` fallback and say so in the report. | [SUBSYSTEM] |
| SFR-01-05 | Each persona | Sign in once per persona with the curl recipe and store the jars. Call one cheap authenticated read per persona (consultee: `GET /api/user/support-tickets`). | Every sign-in returns 200 and the read returns 200. A staff or admin account may return `428 TWO_FACTOR_REQUIRED` on back-office routes; that is recorded in SFR-01-06, not a failure. | [SUBSYSTEM] |
| SFR-01-06 | Staff and admin jars | Call `GET /api/staff/support-inbox` for each operator, then `select id, email, role, "twoFactorEnabled" from users where role in ('ADMIN','STAFF')`. | The report lists, per operator, whether two-factor is enabled. If none is enabled the back-office lanes need enrolment (shared setup section 5); record that as a planned fixture. | [SUBSYSTEM] |
| SFR-01-07 | Agent | Search for leftover rows of the run tag in the support, review, moderation and feedback tables (the same sweep as lane 06, restricted to those tables). | Zero rows. A non-zero result means a previous run did not clean up; list the rows and stop. | [SUBSYSTEM] |
| SFR-01-08 | Agent | Inventory tickets: counts by status, how many have a reference number, how many are `ON_HOLD`, how many carry the app's reference format. | The inventory is recorded. Seed gaps (no `ON_HOLD` ticket, references missing, legacy `SUP-` format instead of the `FAM-YYYY-NNNNNN` format) are listed as seed gaps, not product failures. | [SUBSYSTEM] |
| SFR-01-09 | Agent | Find review candidates: consultee and consultant pairs with an eligible occurrence and no existing review; consultants whose `ratedClientsOneToOne` is 5 or more (the publish gate); consultants below the gate; any group-track example. Record every score column and `ratingAggregatedAt` for the consultants you will touch. | At least two pairs without a review, at least one consultant exactly at or above the gate, and one below it. Missing examples are listed as BLOCKED prerequisites for lane 04 cases. | [SUBSYSTEM] |
| SFR-01-10 | Agent | Check organisation feedback readiness: count `AppointmentFeedback` rows with a non-null `organizationId`, and the organisation owner's `GET /api/organizations/<org>/feedback-summary`. | If no organisation reaches five respondents the floor-met path needs seeded `organizationId` values, which lane 04 will set and revert. Record the baseline. | [SUBSYSTEM] |
| SFR-01-11 | Agent | Check dispute readiness: counts by gateway and status, and whether a Razorpay dispute in `NEEDS_RESPONSE` exists. | If none exists, lane 05 flips a won Razorpay dispute to `NEEDS_RESPONSE` with a near `dueBy` and restores it; record the original row now. | [SUBSYSTEM] |
| SFR-01-12 | Agent | Confirm the email guard mode: read `lib/email/delivery-guard.ts` at the PR head and the environment mode the preview runs in. | The report states which recipients can receive real mail. Seed addresses are normally held, so email cases are observed through `NotificationOutbox` and `FailedEmail`, not an inbox. | [SUBSYSTEM] |
| SFR-01-13 | Agent | Write `{AUDIT_DIR}/fixtures.json` (gitignored) with discovered ids: operators, consultee pairs, appointments and occurrences, consultant profiles, organisation id, dispute ids. | The file exists and later lanes use it; it is never committed or pasted into a pull-request comment. | [SUBSYSTEM] |
| SFR-01-14 | Agent | Capture baselines for later restores: the ticket reference counter row, the score columns of the consultants chosen in SFR-01-09, the dispute row chosen in SFR-01-11, and the count of excluded rows (`excludedFromAggregateAt is not null`) in `ConsultantReview` and `AppointmentFeedback`. | Baseline values are stored in the report's Fixtures section so lane 06 can verify restores. | [SUBSYSTEM] |

## Drift procedure (SFR-01-01)

1. Read `prisma/schema.prisma` at the PR head (`git show origin/{BRANCH}:prisma/schema.prisma`). For each model listed, write down every scalar field and honour `@map` and `@@map`. Table names are the quoted model name unless `@@map` says otherwise.
2. Pull the live columns:

```sql
select table_name, column_name, data_type, udt_name, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('Payment','Dispute','SupportTicket','SupportResponse','SupportMessage',
    'AppointmentSupportThread','SupportFlowOutcome','SupportTicketAttachment','ConsultantReview',
    'ConsultantReviewRevision','AppointmentFeedback','ModerationReport','ModerationAction',
    'PlatformFeedback','NotificationOutbox','OrganizationEarnings','CreditPoolConfig',
    'organizations','ConsultantProfile','twoFactor','users')
order by table_name, ordinal_position;
```

3. Diff the two lists. A model column missing in the database is drift; so is a type mismatch (for example `int4` where the schema says `BigInt`).
4. Pull indexes and constraints and compare with the schema's `@@index`, `@@unique` and with `prisma/sql/check-constraints.sql`, `prisma/sql/ledger-triggers.sql` and `prisma/sql/payment-legs-triggers.sql`:

```sql
select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in (<same list>);
select conrelid::regclass as tbl, conname, contype, confdeltype, pg_get_constraintdef(oid)
from pg_constraint where connamespace = 'public'::regnamespace and conrelid::regclass::text in (<quoted list>);
```

5. `confdeltype` values: `a` no action, `r` restrict, `c` cascade, `n` set null. A foreign key that is `c` where the schema says `Restrict` is drift with data-loss implications; report it.
6. Optionally run the read-only `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` when a `prisma` binary is available in the checkout. Never run `db push`.
7. In the report, list: missing columns, missing indexes, missing sidecar objects, wrong delete rules, and the code paths that read them (search the PR head for the column name). State the blast radius in one paragraph and say which later cases become BLOCKED.

## Database assertions

- Every assertion in this lane is a read. The lane must end with zero writes: re-run `select count(*)` on `"SupportTicket"` before and after and confirm the same count.
- `fixtures.json` contains ids but no passwords.

## Cleanup

Delete nothing in the database. Leave the cookie jars in `/tmp/qa-{PR_NUMBER}/` for the next lanes; lane 06 deletes them.

## Report section

Verdict table for SFR-01-01 to SFR-01-14, then the drift findings (missing objects, probes, blast radius), the operators' two-factor table, the seed-gap list, and the baselines.
