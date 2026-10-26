# Three layers of operational visibility

Sentry tells you that something failed. It cannot tell you what happened to one customer's refund when nothing threw, and it cannot tell you that a job never ran at all. This platform answers those three questions with three separate layers, and each one is the wrong tool for the other two questions. This page describes the layers, says when to reach for each one, and walks through tracing a missing refund from start to finish.

## The three layers

| Question                                    | Layer                                     | Where to look                                                                         |
| ------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| "Something failed. Which code, which user?" | Sentry                                    | The Sentry project, and the Recent errors section on User 360                         |
| "Did the scheduled work run at all?"        | Better Stack and the Sentry cron check-in | The `/api/health/jobs` monitor and the ticker's `cron-tick` check-in                  |
| "What happened to this payment or booking?" | Entity trace and job run metrics          | `/dashboard/<tree>/trace` and the Run metrics card on `/dashboard/<tree>/system-jobs` |

### Sentry: failures

Sentry receives exceptions and modelled warnings from routes, server actions and jobs. It is the right place to start when a page errored or a job threw. It is the wrong place to ask about a payment that is stuck in a valid state, because a refund that sits in `PENDING` for a day raises no exception. The free plan also caps error ingestion at 5,000 events a month, so the code reports a failed sweep once per run and not once per row. That means Sentry holds evidence of a failure, but not a complete list of the rows it touched. The conventions are in [sentry/02-conventions.md](sentry/02-conventions.md).

### Better Stack and the cron check-in: "it did not run"

A job that never starts produces no error, so Sentry stays silent. Two checks cover that gap. The five-minute Netlify ticker sends a Sentry cron check-in after each dispatch, and Sentry raises a missed-check-in issue when check-ins stop arriving. Better Stack polls `GET /api/health/jobs`, which answers 503 when any job listed in `lib/cron/operational-health.ts` has no successful completion within its completion SLO. Both checks answer "is the scheduler alive and are the critical workers completing". Neither can say which payment a job skipped. The setup and the alert drill are in [the Better Stack guide](../maintenance/00-betterstack-setup.md).

### Entity trace and job run metrics: "what happened to this payment"

The data that answers this question already exists in Postgres, but it is spread across fifteen tables. The entity trace reads those tables for one payment or booking and merges every timestamped write into a single list, ordered from oldest to newest. The job run metrics card does the same for the job execution trail. It shows how each job behaved over the last seven days, so an operator can see which sweep should have moved a row and whether that sweep is healthy.

Both features are read-only. They add no table, no column and no write path.

## The entity trace

### Opening a trace

The trace page sits at `/dashboard/<tree>/trace`. It requires the `payments.read` surface, which is the same gate as the Payments money tab, so both admins and staff can open it. There are four ways in:

- Use the **Trace** action on a payment or booking row in User 360.
- Use the **Trace** action on a row in the Payments or Refunds money tab.
- Use the **Trace** button on the payment detail page.
- Paste an id into the lookup form at the top of the trace page. The form accepts a payment id, a booking (appointment) id or a user id. A user id does not open a trace directly. It opens a picker that lists the user's twenty most recent payments and bookings, and from there you choose which one to trace.

Every trace is a plain URL of the form `?kind=payment&id=<id>`, so you can paste the link into a support case.

### What a trace reads

When the root is a payment, the trace covers that payment and any overage side charges raised against it. When the root is a booking, it covers every payment on that booking, up to twenty. Each source below is read with one bounded query, and the queries run one after another, because the Netlify pool has a single connection.

| Source         | Table and link                                                                                                                     | Rows shown                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Payment        | `Payment`, read as the root                                                                                                        | Created, captured, refund owed, reconciled with the gateway, deleted, and the current status |
| Payment leg    | `PaymentLeg` by `paymentId`                                                                                                        | Each funding leg and its amount                                                              |
| Refund         | `Refund` by `paymentId`                                                                                                            | Created, failed, cascade applied, and the current status                                     |
| Dispute        | `Dispute` by `paymentId`                                                                                                           | Opened, evidence submitted, and the current status                                           |
| Ledger         | `LedgerTransaction` by `paymentId`, with its entries joined                                                                        | One row per transaction: the debit total and the debited and credited account kinds          |
| Earnings       | `ConsultantEarnings` by `paymentId`, and `OrganizationEarnings` when the payment is org-tagged                                     | Recorded, paid, and the current status                                                       |
| Earnings hold  | `EarningsHold`, joined onto the earnings rows                                                                                      | Placed, with its reason, and released                                                        |
| Payout         | `ConsultantPayout` and `OrganizationPayout`, reached through the earnings rows                                                     | Created, approved, processed with its UTR, clawback, and the current status                  |
| Invoice        | `ConsumerInvoice` by `paymentId`, and the `OrganizationInvoice` that the payment was billed on                                     | Issued, and paid for organisation invoices                                                   |
| Credit note    | `ConsumerCreditNote`, joined onto the invoice, and the organisation `CreditNote` by refund or dispute                              | Issued                                                                                       |
| Booking        | `BookingStatusHistory` and reschedule proposals, read through `getBookingTimeline`                                                 | Every booking and session transition                                                         |
| Support        | `SupportCase` linked by booking, by a payment subject or by a refund recommendation, with its events and recommendations joined    | Opened, each case event, and each recommendation proposed or decided                         |
| Console action | `OpsActionLog` by `(targetKind, targetId)` for the payments, booking, sessions, disputes, payouts, cases and recommendations above | Each console action, with the operator and the reason                                        |
| System event   | `SystemEvent` by `correlationId`                                                                                                   | Each event recorded against the payment, its gateway order, the booking or a linked case     |

Each row shows the time, the source, what happened, the amount in rupees, the actor and a short detail. A row whose actor reads "System" was written by a webhook, a sweep or a job. Each row also carries a Sentry search link for its own id. The link is built from the Sentry organisation settings in `lib/observability/sentry-issues.ts` (`sentrySearchHref`), and it is a URL only, so opening a trace never calls the Sentry API. Console action rows also link to the Audit log filtered to their target.

### Caps, failures and visibility

Each source reads at most 50 rows. The reader fetches one extra row so that it knows when it has hit the cap rather than guessing. Support cases are capped at 10, with 30 events each. The Sources table at the bottom of the trace marks a capped source as "Capped; older rows hidden". When a source cannot be read, that source shows "Read failed" and the rest of the trace still renders.

Two rules decide what an operator can see, and both follow the rules of the surfaces that already show this data. Staff see only the console actions that they took themselves, which is the same scoping as the Audit log. System events appear only in an admin's trace, because the system events API is admin-only.

### Sources the trace does not read

The trace leaves out two sources, because reading either one would need a slow, unindexed query.

- **Gateway webhooks (`WebhookEvent`).** A row is keyed `<event type>:<gateway entity id>:<event id>`, and it holds the payment only inside its JSON payload. Matching on the gateway payment id would mean scanning the payload or running a leading-wildcard `LIKE`, and neither can use an index. The webhook's effects still appear in the trace: the capture time, the refund status and the dispute status are all written by the webhook handler.
- **Links to job runs (`SystemJobExecution`).** No traced row records which job wrote it, and up to ten jobs share each five-minute tick. Matching a row to a run by time would therefore usually name the wrong job. To check whether the sweep that should have moved a row is healthy, read the job run metrics described below.

Session rows (`AppointmentOccurrence`) are not read separately. Every session transition is already recorded in `BookingStatusHistory` under the `OCCURRENCE` entity.

### Query budget

A trace issues one statement per source, and it skips any source that has nothing to link to. A consumer payment with no booking costs 10 statements: the root, the legs, refunds, disputes, ledger, earnings, the invoice, support, console actions and system events. A booked consultation with a paid-out earning costs 13. The ceiling is 17, reached by an org-tagged booking that has organisation earnings, both kinds of payout, an organisation invoice and organisation credit notes. The user picker costs one statement. At roughly 95 ms per round trip on production, a typical trace loads in about one second.

## Job run metrics

The Run metrics card sits at the top of the System Jobs page, which requires `systemJobs.manage` and is therefore admin-only. For each job, it reads the last seven days of `SystemJobExecution` and shows the following:

- The number of runs, split into succeeded (`COMPLETED`), failed (`FAILED`) and held (`CANCELLED`). A held run is one that found another run's lease and stood down without doing any work.
- The p50 and p95 duration of finished runs.
- The sum of `itemsProcessed`.
- The time of the last success.
- A window flag, which reads "On time", "Missed" or "Not scheduled".
- A sparkline of runs and failures for each IST day.

The window flag reuses the existing policy and does not duplicate any cadence data. A job listed in `OPERATIONAL_COMPLETION_REQUIREMENTS` (`lib/cron/operational-health.ts`) is judged by its completion SLO, through the same `assessOperationalCompletions` function that `/api/health/jobs` uses. Any other job is matched to its ticker target in `lib/cron/schedule.ts`. A lock name either equals the target's name or ends with `-<target>`, as `cleanup-abandoned-payments` does for the target `abandoned-payments`. An interval job is flagged "Missed" when two of its slots, plus one tick, have passed with no success. A calendar job is flagged "Missed" when its most recent window has been open for its first two slots and has no success since it opened. A job that has no SLO and no ticker target is shown as "Not scheduled". The GitHub Actions batch jobs fall into this group.

The counts include every environment that writes to the shared database. The last success time and the window flag count only runs whose `result.environment` matches this deployment's Sentry environment, which is the same filter that the health probe applies. A job with no run in the last seven days appears only if it has a completion SLO. Jobs that never write an execution row, such as the Sentry ingest canary, are not listed.

The card costs four statements. Two of them are Prisma `groupBy` queries: the counts by job and status, and the last success by job. The other two are parameterised, read-only `$queryRaw` queries: one computes the percentiles with `percentile_cont`, and one buckets runs by IST day. Neither has a Prisma `groupBy` equivalent, and reading the raw rows would mean loading about 20,000 rows a week. The pure functions behind the flag are `assessMissedWindow`, `scheduleForJob`, `latestDueWindowStart` and `buildJobRunMetrics`, all in `lib/backoffice/job-run-metrics.ts`.

## Worked example: a missing refund

Suppose a learner writes in on 26 October: "My consultation was cancelled on the 20th and I still have not got my ₹1,500 back."

1. **Find the payment.** Open the learner in User 360, find the ₹1,500 payment in the Payments section, and click **Trace**.
2. **Read the timeline from the top.** The first rows show the payment being created and captured on the 18th. They are followed by a `BOOKING` ledger transaction, an earnings record for the consultant, an invoice, and the booking moving to `CONFIRMED`. On the 20th there is a booking row `CONSULTATION CONFIRMED → CANCELLED` with the consultant's name as the actor.
3. **Find the refund rows.** There are three possible shapes, and each points somewhere different.
   - The trace shows **no refund row, but the payment has a "Refund owed" row** on the 20th. In that case, the cancellation recorded a debt, but the automatic refund never reached the gateway. The sweep responsible is `retry-auto-refunds`. On the System Jobs page, find that job in the Run metrics card. If it shows "Missed", or a row of red failure bars, open its Sentry link from the job list. If it shows "On time", then the sweep is running but refusing this payment, and the refund-owed reason in the row detail says why.
   - The trace shows a **"Refund created" row on the 20th and "Refund now PENDING"**. The gateway accepted the refund but never confirmed it. The sweep responsible is `reconcile-pending-refunds`, which has a 45-minute completion SLO. If the metrics card shows it as "Missed", the problem is the scheduler, and Better Stack should already have alerted. If the card shows it as "On time", click the **Sentry** link on the refund row. That link searches for the refund's own id and finds any reconcile error that named it.
   - The trace shows **"Refund failed"** with a gateway reason. In that case nothing is stuck. An admin can issue the refund again from the Refunds tab, and the console action will appear in the trace with the operator's name and reason.
4. **Check what the money did afterwards.** When the refund has succeeded, a "Refund cascade applied" row and a credit note row should follow it. If the consultant had already been paid, a payout clawback row should follow as well. If these rows are missing after a successful refund, the earnings and documents were not adjusted, and you should raise this through the money runbooks.
5. **Write down the answer.** Paste the trace URL into the support case, so that the next person who opens the case sees the same timeline.

## Where in code

| Concern                          | File                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Trace reader and `mergeTimeline` | `lib/backoffice/entity-trace.ts`                                                                          |
| Trace types and `traceHref`      | `lib/backoffice/entity-trace-types.ts`                                                                    |
| Trace page and view              | `app/dashboard/(backoffice)/[tree]/trace/page.tsx`, `components/dashboard/backoffice/EntityTraceView.tsx` |
| Sentry search link               | `sentrySearchHref` in `lib/observability/sentry-issues.ts`                                                |
| Job metrics reader               | `lib/backoffice/job-run-metrics.ts`                                                                       |
| Job metrics card                 | `components/dashboard/backoffice/JobRunMetrics.tsx`                                                       |
| Tests                            | `__tests__/backoffice/entity-trace.test.ts`, `__tests__/backoffice/job-run-metrics.test.ts`               |

## Deprecated & Superseded Approaches

Before the trace existed, an operator answered "what happened to this payment" by opening the payment detail page, the Audit log, the booking's timeline modal and the Supabase table editor one after another, and lining up the timestamps by hand. All of those views still exist and still apply. The trace reads the same tables as those views, and it reuses the booking timeline reader (`getBookingTimeline`) rather than querying booking history a second way.
