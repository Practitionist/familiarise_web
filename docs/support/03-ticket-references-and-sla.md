# Ticket references and the SLA model

Every escalated support request carries two operational primitives: a speakable handle a caller can quote over the phone (`FAM-YYYY-NNNNNN`), and a pair of statutory SLA clocks sized to Indian consumer and intermediary law. Both unified `SupportCase` rows and legacy `SupportTicket` rows share the same counter series, clock math, and background sweep.

## Ticket references: `FAM-YYYY-NNNNNN`

Every support case or ticket carries a human-readable handle in `referenceNumber`, formatted by `lib/support/reference.ts` as `FAM-YYYY-NNNNNN` (literal prefix `FAM`, four-digit **IST calendar year**, and six-digit zero-padded sequence, e.g. `FAM-2026-000123`).

The series is scoped to the **IST calendar year** (`UTC+05:30`) rather than a single lifetime counter or UTC year:

1. **Privacy (German tank problem):** A single lifetime counter exposes all-time ticket volume to anyone filing two requests and subtracting handles; resetting each January caps any volume inference to the current year.
2. **IST year boundary (`+05:30`):** `allocateTicketReference(tx, now)` computes `istYear = new Date(now.getTime() + 330 * 60_000).getUTCFullYear()` so requests filed between midnight IST and midnight UTC on 1 January receive the new year's series rather than the prior UTC year.

Allocation runs atomically via `allocateTicketReference(tx, now)` inside the caller's transaction:

- `SupportTicketCounter.upsert` (`where: { year: istYear }`, `create: { year: istYear, nextSeq: 2 }`, `update: { nextSeq: { increment: 1 } }`) compiles to `INSERT … ON CONFLICT DO UPDATE … RETURNING` holding a row lock with no application-space read-modify-write.
- Returns `formatTicketReference(istYear, counter.nextSeq - 1)`. Because allocation shares the creation transaction, rolling back the insert reverts the sequence increment cleanly.
- `SupportCase.referenceNumber` is non-null `@unique`; legacy `SupportTicket.referenceNumber` is nullable `@unique` so pre-counter rows retain their UUID fallback without backfill.

## The SLA model

India makes a support escalation ladder a statutory obligation rather than an optional service target. Two regimes apply, and `lib/support/sla.ts` sizes every target inside the tighter ceiling:

| Regime                                      | Acknowledge within | Dispose within |
| ------------------------------------------- | ------------------ | -------------- |
| Consumer Protection (E-Commerce) Rules 2020 | 48 hours           | 1 month        |
| IT Rules 2021                               | **24 hours**       | **15 days**    |

`lib/support/sla.ts` exports `STATUTORY_ACK_HOURS = 24` and `STATUTORY_RESOLUTION_DAYS = 15`. Per-priority internal targets sit inside those statutory caps:

| Priority | Acknowledge | Resolve |
| -------- | ----------- | ------- |
| `URGENT` | 2 hours     | 1 day   |
| `HIGH`   | 8 hours     | 3 days  |
| `MEDIUM` | 24 hours    | 7 days  |
| `LOW`    | 24 hours    | 15 days |

### Intake snapshots and priority tightening

- **Initial snapshot (`slaDeadlinesFor(priority, from)`):** Computed once at intake and persisted on `ackDueAt` and `resolutionDueAt`. Later edits to `TARGETS` never retroactively alter existing open cases.
- **Priority tightening (`tightenDeadlinesForPriorityRaise(existing, nextPriority, now)`):** When priority is raised (`URGENT > HIGH > MEDIUM > LOW`), `tightenDeadlinesForPriorityRaise` computes `slaDeadlinesFor(nextPriority, now)` and tightens unacknowledged `ackDueAt` (`Math.min(existing.ackDueAt, target.ackDueAt)`) and unresolved `resolutionDueAt` (`Math.min(existing.resolutionDueAt, target.resolutionDueAt)`). Lowering or re-submitting the same priority returns `{}` — deadlines **tighten on priority raise and never extend on priority drop**.

### Pause arithmetic and read-time derivation

**The resolution clock pauses while waiting on the customer.** Without pause accounting, a customer who takes a week to answer would register as an operator breach.

- **Public operator reply (`applyStaffReply` / `advanceAgentPublicTurnState`):** Sets `acknowledgedAt` and `firstAgentReplyAt` on the first public reply (first-write-wins via CAS), banks any open wait interval into `pausedSeconds`, and sets `awaitingUserSince = now`. Internal notes (`isInternal: true`) do not start a customer wait or satisfy acknowledgement.
- **Customer reply (`userRepliedPatch`):** Adds `openWaitSeconds(clock, now)` into `pausedSeconds` (`Int` seconds rather than milliseconds, avoiding 32-bit integer overflow at 24.8 days) and clears `awaitingUserSince = null`. Subsequent consecutive user messages while `awaitingUserSince` is already `null` are no-ops.
- **Acknowledgement never pauses:** Before any operator has replied, nothing is awaited from the customer.
- **Derived breach state (`slaStateOf(clock, now)`):** `effectiveResolutionDueAt` shifts `resolutionDueAt` by `pausedSecondsAt(clock, now) * 1000`. Breach state (`ackBreached`, `resolutionBreached`, `paused`, `msToAckDue`, `msToResolutionDue`) is pure and derived on read — no mutable boolean column is stored. Indexes on `[acknowledgedAt, ackDueAt]` and `[resolvedAt, resolutionDueAt]` keep queries fast.

## Background sweep (`runSupportSlaSweep`)

`runSupportSlaSweep` (`lib/support/sla-sweep.ts`) runs every **30 minutes at offset `:10`** on `netlify/functions/cron-tick.mts` (`limit=20`), protected by `withCronLock("support-sla-sweep")`:

- **Arm 1 — SLA acknowledgement & resolution warnings/breaches:** Scans active, unpaused (`awaitingUserSince === null`) cases and tickets due within the last 30 days (`ackWarn <= 2h`, `resWarn <= 24h`, or breached `<= now`), staging idempotent notifications (`dedupeKey: sla:{id}:{ack|res}:{warn|breach}`) on `NOVU_WORKFLOWS.SUPPORT_TICKET_ACTIVITY` and emailing operators. Organization `escalationContactEmail` is emailed **strictly on `"breach"`**, never on `"warn"`.
- **Arm 2 — 28-day auto-close (`RESOLVED` -> `CLOSED`):** Transitions rows resolved at least 28 days ago to `CLOSED` (`closedAt: now`), logs an `AUTO_CLOSED` event row, and atomically closes linked `AppointmentSupportThread` rows (`status: "CLOSED"`, `activeChannel: "SELF_SERVE"`).
- **Arm 3 — Actionable dispute deadline reminders:** Alerts `ADMIN` operators on payment disputes in `NEEDS_RESPONSE` or `WARNING_NEEDS_RESPONSE` at `T-72h` and `T-24h` (`dedupeKey: dispute-due:{id}:{72|24}` on `NOVU_WORKFLOWS.DISPUTE_UPDATED`).

Row failures are collected across all three arms and reported to Sentry at most once per run.

## How breaches surface to staff

- **Badges:** `slaStatusBadge` renders `Breached` (either clock past due), `Waiting on customer` (pause running), `Due soon` (acknowledgement within 6h, or resolution within 12h), or `On track`. `slaHint` renders the tighter active countdown.
- **Deadline-first default sort:** `parseInboxFilters` defaults `Needs reply` and `SLA at risk` queue views to `sort=sla` (unacknowledged ordered by `ackDueAt` first, then `resolutionDueAt`, oldest-first tiebreak). `readTicketKeysBySla` issues two ordered queries matching the comparator (`skip + take`) and `mergeCasePage` slices exact pages up to `INBOX_MAX_DEPTH` (1000).
- **Pause filtering:** `Needs reply` and `SLA at risk` exclude paused rows (`awaitingUserSince !== null`). Pre-escalation self-serve threads without a ticket carry no statutory clock.

## Related

- [05-schema-reference.md](05-schema-reference.md) — support schema column reference.
- [07-ticket-lifecycle-and-concurrency.md](07-ticket-lifecycle-and-concurrency.md) — status transitions, reopen rules, and CAS guards.
- [09-support-case-and-sla-sweep.md](09-support-case-and-sla-sweep.md) — unified `SupportCase` APIs, sweep architecture, CSAT, and statutory monthly compliance report.
- Public surfaces (`app/(pages)/constants.ts`, `app/(pages)/contactus/**`, `app/support/**`, `app/(pages)/grievance/page.tsx`) bind `ACK_PROMISE_COPY` (`within 24 hours`) directly to `STATUTORY_ACK_HOURS`.

## Deprecated & Superseded Approaches

- **Single `ackDueAt` query sort for SLA queues**: ranked already-acknowledged rows by a completed deadline so page boundaries disagreed with the client comparator; superseded by two-query ordered merge (`readTicketKeysBySla`).
- **Activity-default sort on operator work queues**: hid near-breach tickets behind chatty threads; superseded by defaulting `Needs reply` and `SLA at risk` views to `sort=sla`.
- **Extending or recomputing deadlines on priority drop**: lowering priority never pushes `ackDueAt` or `resolutionDueAt` outward; `tightenDeadlinesForPriorityRaise` strictly tightens open deadlines on upward priority transitions only.
- **Stored boolean `isBreached` column**: stale between cron ticks; breach status remains derived purely on read via `slaStateOf(clock, now)`, while `runSupportSlaSweep` drives idempotent alerts and 28-day auto-close.
- **UTC calendar-year counter rollover & hardcoded `"24–48 hours"` copy**: superseded by IST (`+05:30`) year calculation in `allocateTicketReference` and `ACK_PROMISE_COPY` bound to `STATUTORY_ACK_HOURS`.
