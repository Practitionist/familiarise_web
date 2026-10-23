# The Money console

Operators used to reach payments, refunds, payouts and disputes through four
separate pages, each with its own URL, its own access guard, and no shared
record of who had touched what. Since #1771 they are one console, reachable
at `/dashboard/admin/money/<section>` for admins and
`/dashboard/staff/[staffId]/money/<section>` for staff, with every mutation
passing through one audited door. Each section is its own item in the
sidebar's Money group, next to Invoices and Subscriptions; there is no
in-page tab bar.

## Sections, and who sees them

`lib/backoffice/money-tabs.ts` declares the section list once. The sidebar
(`lib/dashboard/backoffice-nav.ts`) turns each entry into an item and the
shared `[tab]` page guards it, and both filter the list through
`BACKOFFICE_PERMISSIONS` (`lib/auth/backoffice-permissions.ts`), so a section
is never visible to a role whose route guard would then turn it away. The
table below lists every section with the surfaces that gate it.

| Section   | Surface                       | What it is for                                                                               |
| --------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| Payments  | `payments.read`               | Every payment, with its status and rail.                                                     |
| Refunds   | `refunds.read` / `.manage`    | Refunds issued, pending and failed, plus the admin refund doors.                             |
| Disputes  | `disputes.read` / `.manage`   | Chargebacks and their evidence deadlines.                                                    |
| Payouts   | `payouts.read` / `.manage`    | Consultant payouts waiting, in flight and paid, including the instant-payout approval queue. |
| Earnings  | `payouts.manage`              | Consultant earnings, with hold and release.                                                  |
| Reconcile | `payouts.manage`              | Runs the four reconcile jobs on demand and shows when each last ran.                         |
| Incidents | `incidents.read` / `.declare` | Declared platform outages, the sessions they voided and each learner's remedy.               |

Staff hold `payouts.read`, so they see the Payouts section read-only: the
list, the trend and the earnings view render, while the approve and reject
buttons do not, and every payout and earnings mutation (approve or reject,
including an instant payout waiting for approval, hold and release, and
every reconcile run) stays `payouts.manage`, which only an admin holds. The
earnings read follows `payouts.read`, but the Earnings section is where hold
and release live, so it and the Reconcile section are gated by
`payouts.manage` and appear for admins only. The reconcile reads
(`GET /api/admin/reconcile` and `GET /api/admin/reconcile-ledgers`) stay
admin-only too, because the ledger reports expose cross-organisation
aggregates. A support agent resolving a billing ticket can therefore see a
payment, refund, dispute or payout without being able to move money.
Staff hold `incidents.read`, so they see the Incidents section and its suggestions; declaring an incident and running one now are `incidents.declare`, which only an admin holds. Approval Payments stays its own page rather than a money section, because
it chases an unpaid pay-link rather than moving money once it lands.

The four pages the hub replaced — `/dashboard/admin/{payments,refunds,
disputes,payouts}` — now answer a 308 to their section, carrying their
query string over (`moneyHubHref`), so a bookmarked or linked URL keeps
working. The sidebar links straight to each section's `/money/<section>` URL.

## Every mutation is a door, and every door is a `withOpsAction`

`lib/backoffice/ops-action-log.ts`'s `withOpsAction` is the route shell every
console mutation is built on: it gates the surface through
`requireBackofficeSurface`, parses a Zod body that always includes a `reason`
of at least five characters, runs the door's handler, and writes exactly one
`OpsActionLog` row recording the actor, their role, the surface, the action,
the target kind and id, the reason, and a before/after snapshot.

A door is one of two shapes:

- **A transactional door** runs its handler and writes the audit row inside
  the same database transaction, so a refused or rolled-back mutation leaves
  no row behind — the log only ever describes something that actually
  happened.
- **A gateway door** — a Razorpay call, for instance — cannot sit inside a
  Postgres transaction, so its row is written immediately after the call
  returns, carrying `after.status` set to `SUCCEEDED` or to `FAILED` with the
  refusal code either way. The row is written once and never retried. If that
  write fails after the gateway call, the failure is paged to Sentry and the
  door still answers with the call's outcome, because a lost audit row for
  money that already moved is worse than a noisy alert.

Typed refusals (`lib/backoffice/ops-refusal.ts`) come back with their own
codes instead of a generic 500, so the console can show "already contested"
or "nothing left to restore" rather than a crash.

## Staff support, admin money — the same split as everywhere else

The console repeats the platform's one rule for privileged access: staff own
support end-to-end and read every money surface, and admin alone executes
money. The class doors read this literally as two surfaces,
`classSeries.support` and `classSeries.money`: a staff member can cancel a
session for the host, grant a make-up (including an ops-only bypass of the
14-day window, itself reason-gated), clear or re-flag the reliability flag,
and leave a note — none of it moves money. Skipping a make-up, cancelling a
whole series with refunds, and every refund or credit-restore door are
`classSeries.money` and `refunds.manage`, admin-only, because every one of
them does. See [the class-series money-rules ADR](../../decisions/2026-09-25-class-series-money-rules.md)
for what each door does and why it exists.

## Per-booking Ops actions

The class doors no longer have a section of their own. Each booking's detail
dialog under Operations → Appointments carries an "Ops actions" panel
(`BookingOpsPanel`), which reads `GET /api/staff/appointments/[id]/ops` and
opens only the existing door routes. Every booking type lists its sessions
with their outcome and the `session.set-outcome` door, and shows its money
state; an admin also gets a link that opens the Refunds section's issue door
pre-filled with the payment. Any operator holding `appointments.manage` can,
after step-up and only while booking doors are open (`assertBookingDoorsOpen`,
closed in DEGRADED or OFFLINE maintenance), release the booking, or one session
of a subscription or class, for rescheduling through
`POST /api/staff/appointments/[id]/reschedule`, the only
way a STAFF or ADMIN who is not a party moves a booking; the release only
frees the time, and the customer picks the new times. An operator holding
`appointments.cancelForPlatform` cancels the whole booking through
`POST /api/staff/appointments/[id]/cancel`, behind the refund preview, a
reason and step-up; a STAFF refusal at the bounded refund caps
(`ADMIN_REQUIRED`, `STAFF_DAILY_LIMIT`, `STAFF_REFUND_IN_PROGRESS`) says an
admin has to send it. The Subscriptions inspector cancels through the same
door. A class booking adds the class doors described
above: cancel a session, grant a make-up with the reason-gated 14-day bypass,
skip a make-up (admin), the exit-right state, the reliability flag with an
ops note, and, for an admin, cancelling the whole series and running the
14-day sweep for one session. A subscription booking gives an admin its
48-hour sweep. Webinars get no class door, because those doors are keyed to a
class. The old `/money/class-series` URL answers a 308 to Appointments
filtered to classes, and the sessions-needing-a-decision queue now heads the
Appointments page.

## The refund and credit doors

The Refunds tab's "Issue refund" always calls `refundBookingPayment` — the
one front door every refund in the codebase goes through — so a console
refund carries the same idempotency and ledger guarantees as an automatic
one. "Ladder override" reprices the same cancellation quote with an operator
-supplied percentage (`ladderOverrideAmount`, `lib/backoffice/refund-doors.ts`)
and then calls the same refund door; it can never move money outside the
existing quote arithmetic, only substitute the percentage. "Return N sessions
of credits" calls `restoreClassSeatCredits` for a credit-funded seat whose
partial return the automatic credit rail cannot express on its own (the ADR
above, decision 10) — a full return still happens automatically wherever the
automatic path can reach it.

## Reconcile, from a button instead of a terminal

The Reconcile tab starts the same four jobs the CRON_SECRET-gated routes run
on a schedule — ledger reconciliation, pending refunds, payment status, and
the earnings healer (`sync-payment-earnings`) — through
`POST /api/admin/reconcile/[job]`. Each job keeps its own cron lock
(`withCronLock`), so a job already running answers a 409 "already running"
instead of a second overlapping pass, and the tab shows each job's last run
from the same heartbeat the scheduled invocation writes.

## Platform incidents

When the call platform or the app fails for everyone, no presence evidence exists, and the session-outcome classifier could read the silence as a learner absence, which forfeits the learner's money. The Incidents section lets an admin declare the failure window so that every eligible session it overlaps is voided as the platform's miss and each learner receives the remedy for their product. Sessions already cancelled or rescheduled, and voids that already carry a refund or are settled, are skipped. Voiding and refunding is done by the `settle-platform-incidents` sweep, not by the declare door, which only records the window.

### The Incidents tab

The tab (`components/dashboard/backoffice/money/IncidentsTab.tsx`, read through `GET /api/admin/incidents`) lists incidents newest first. Each row shows the window in the viewer's zone, the reason, who declared it, a status and the remedy counts. The status reads "Voiding sessions" until the retroactive pass has decided every overlapping session (`enumeratedAt`), "Remedies in progress" after that, and "Settled" once the ops report is staged and every remedy is finished (`settledAt`). The counts are remedies due, done, and "need a human", which are the dead-lettered rows described in the runbook below.

### The declare door

`POST /api/admin/incidents` is a `withOpsAction` door on the `incidents.declare` surface (admin only) with step-up authentication, so the admin must have re-verified their second factor recently. It writes an `OpsActionLog` row with action `incident.declare` and target kind `PlatformIncident`. The window is checked by `incidentWindowSchema()` in `lib/booking/platform-incidents.ts`, and a bad window answers 400 `INVALID_WINDOW` with a message:

| Rule                         | Message                                               |
| ---------------------------- | ----------------------------------------------------- |
| Start before end             | The window must start before it ends.                 |
| Already ended                | Only a window that has already ended can be declared. |
| Ended within the last 7 days | The window must have ended within the last 7 days.    |
| At most 24 hours long        | A window can be at most 24 hours long.                |

An exact repeat of an earlier window returns the first incident with a 200 instead of a 201, because `PlatformIncident` has `@@unique([startsAt, endsAt])` and `declareIncident()` inserts with `skipDuplicates`. The repeat still writes an audit row. There is no edit and no delete door: a session that was voided by mistake is overturned through the existing `session.set-outcome` door, and the refund door re-checks under the appointment lock that the session is still `VOIDED`, so that overturn wins over a pending incident refund.

### The suggestion panel

Above the list, `readIncidentSuggestions()` (`lib/backoffice/incidents-read.ts`) buckets the last seven days by hour and counts three kinds of signal: sessions with a `PLATFORM_OUTAGE`, `INCONCLUSIVE`, `OFFLINE` or `NOBODY_JOINED` outcome, meetings that ended for an unexpected `Meeting.endedReason`, and webhook events that recorded an error. An hour is suggested when it has at least five signals and at least three times the hourly mean. The panel never declares anything: "Declare this window" only pre-fills the form for an admin to confirm. The Sentry ingest canary is deliberately not a signal, because it keeps no verdict history and it tests whether Sentry accepts events, not whether the app is serving.

### Run now

Each unsettled incident has a "Run now" button for an admin (`POST /api/admin/incidents/[incidentId]/settle`, surface `incidents.declare`, step-up, audit action `incident.settle`). It runs the same sweep under the same `settle-platform-incidents` cron lock, scoped to that incident, so it can never overlap the hourly run; if the lock is held it answers the usual 409 "already running". It refuses with 503 `MAINTENANCE` while maintenance is DEGRADED or OFFLINE, because it moves money. It does not bring forward the 48-hour wait for a consultation or paid-trial refund, and it does not retry a dead-lettered row.

### Runbook: declaring and following an incident

1. **Confirm the outage.** Check the suggestion panel and the status page for the hour. Pick a window that has ended, covers every affected session, and is no longer than 24 hours. A window that is too wide voids healthy sessions that overlap it, because any overlap counts.
2. **Declare it.** In Money, Incidents, enter the start and end (shown in your own zone), write a reason of at least five characters and confirm with your second factor. For example, an outage from Sun 18 Oct 2026 00:30 to 02:30 IST is declared as that window; the audit log shows `incident.declare` against the new incident.
3. **Know what each learner gets.** The sweep writes one remedy per live seat that held the session before it started:
   - Consultation: 100% of the remaining balance, refunded 48 hours after the void.
   - Paid trial: the same 48-hour refund, and the trial is cancelled in the same commit, which frees the expert pair.
   - Free trial: cancelled straight away, which frees the pair.
   - Subscription: the session goes back to the plan allowance and the plan end moves seven days later, straight away.
   - Webinar: 100% of the seat, refunded straight away.
   - Class: nothing beyond the void; the existing 14-day make-up window or the one-unit refund applies.

   Each learner gets one `PLATFORM_INCIDENT_DIGEST` email per incident once their straight-away remedies are applied, and it does not wait for a 48-hour refund. Ops gets one report email when everything is finished.

4. **Read the tab.** Within about an hour the status moves to "Remedies in progress". "Due" falls as the 48-hour refunds come due and the hourly run applies them, and the incident reaches "Settled" after the last one. A refund is visible in Refunds under the key `incident:<incident>:<occurrence>:<user>`.
5. **Handle "need a human".** A remedy is dead-lettered after three counted failures, with `lastError` starting `dead-letter:`. The usual cause is a marker conflict: the payment already owes another door's refund under a different key, and the marker is never overwritten. Open the payment, let the other refund finish or fail, then refund the learner by hand with the Refunds section's "Issue refund" door. A dead-lettered refund leaves the session unsettled, so the day-14 `settle-cancelled-sessions` sweep also refunds it under its own `occ:` key, capped to the remaining balance, which means a manual refund and the sweep can never pay twice. A dead-lettered row counts as terminal, so it no longer holds the incident open.
6. **Never retry by editing rows.** If a remedy looks stuck, "Run now" is the only supported lever.

## The audit log is the log's only reader

The audit log is not a Money section. It is its own item at the end of the
sidebar, outside the Money group, because it covers every console door, and
it still lives at `/money/audit`.

`OpsActionLog` has no admin-only write path and no back door: every row on
it was written by a `withOpsAction` door, and the audit log is a paged,
RSC-seeded read over exactly those rows, answered `Cache-Control: no-store`
like every other money GET. Staff see only the rows they themselves wrote;
admins see every row. Filters are by actor, surface and target, so "what did
this operator do to this refund" is one query rather than a grep through
Sentry breadcrumbs.
