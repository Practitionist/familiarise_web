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

| Tab       | Surface                     | What it is for                                                                               |
| --------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| Payments  | `payments.read`             | Every payment, with its status and rail.                                                     |
| Refunds   | `refunds.read` / `.manage`  | Refunds issued, pending and failed, plus the admin refund doors.                             |
| Payouts   | `payouts.read` / `.manage`  | Consultant payouts waiting, in flight and paid, including the instant-payout approval queue. |
| Earnings  | `payouts.read` / `.manage`  | Consultant earnings, with hold and release.                                                  |
| Disputes  | `disputes.read` / `.manage` | Chargebacks and their evidence deadlines.                                                    |
| Reconcile | `payouts.manage`            | Runs the four reconcile jobs on demand and shows when each last ran.                         |
| Audit     | `opsLog.read`               | Every console action: who, what, on which row, and why.                                      |

`payouts.read` is admin-only, so staff do not see the Payouts or Earnings
tabs; a support agent resolving a billing ticket can still see a payment,
refund or dispute without being able to move money. Approval Payments stays
its own page rather than a ninth tab, because it chases an unpaid pay-link
rather than moving money once it lands.

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
pre-filled with the payment. A class booking adds the class doors described
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

## The Audit tab is the log's only reader

`OpsActionLog` has no admin-only write path and no back door: every row on
it was written by a `withOpsAction` door, and the Audit tab is a paged,
RSC-seeded read over exactly those rows, answered `Cache-Control: no-store`
like every other money GET. Staff see only the rows they themselves wrote;
admins see every row. Filters are by actor, surface and target, so "what did
this operator do to this refund" is one query rather than a grep through
Sentry breadcrumbs.
