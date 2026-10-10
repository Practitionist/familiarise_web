# Ticket references and the SLA model

Issue #705 gave every escalated ticket two things the queue could not run without: a handle a person can say aloud, and a pair of statutory clocks that say whether the team is late. Both are stored on `SupportTicket` and both are described here.

## Ticket references: `FAM-<YYYY>-<SEQ6>`

Every ticket minted from either scope carries a speakable handle in `SupportTicket.referenceNumber`, formatted by `lib/support/reference.ts` as the literal prefix `FAM`, the calendar year, and a six-digit zero-padded sequence, for example `FAM-2026-000123`. A uuid cannot be read back over a phone line or quoted in an email subject, and before this the two staff surfaces had each invented their own truncation of the id (the tickets table took the first eight characters, the staff home took the last), so the two screens named the same ticket differently and the user was shown no identifier at all.

The series is scoped to the year rather than being a single lifetime counter, and that is a privacy decision rather than a cosmetic one. A lifetime counter publishes the platform's all-time ticket volume to anyone who files two tickets and subtracts one reference from the other. This is the German tank problem, which is exactly how the Allies estimated German production from sequential part serial numbers. Resetting each January caps the leak at the current year's volume.

Allocation runs through `allocateTicketReference(tx, now)` inside the same transaction that creates the ticket, so a rolled-back ticket never leaves a live reference behind. The upsert on `SupportTicketCounter` compiles to `INSERT … ON CONFLICT DO UPDATE … RETURNING`: the create path is arbitrated by the primary key and the update path is an in-place increment holding a row lock, so concurrent allocators queue and each returns a distinct value with no read-modify-write in application space. The column is also `@unique`, which turns any residual duplicate into a `P2002` to retry rather than two tickets quietly sharing a handle. Because the upsert runs on the caller's transaction, a rollback reverts the increment as well, and a concurrent allocator that was queued on the row lock then receives the same number, so a rolled-back ticket leaves no gap. Nothing depends on the series being unbroken in any case; that is the difference from the GST invoice series, where CGST Rule 46 would not allow a gap.

The column is nullable and minted forward-only. A unique index permits unlimited nulls, so tickets that predate the counter keep their uuid and every surface falls back to the old truncation for them; no backfill is owed.

## The SLA model

India makes a support escalation ladder a legal artifact rather than a nicety, and two regimes can apply. The table below states both, and the row the implementation is sized to.

| Regime                                      | Acknowledge within | Dispose within |
| ------------------------------------------- | ------------------ | -------------- |
| Consumer Protection (E-Commerce) Rules 2020 | 48 hours           | 1 month        |
| IT Rules 2021                               | **24 hours**       | **15 days**    |

`lib/support/sla.ts` is sized to the IT Rules 2021 numbers, exported as `STATUTORY_ACK_HOURS` and `STATUTORY_RESOLUTION_DAYS`. They are the tighter of the two, so meeting them satisfies both regimes and the platform does not have to first settle whether it is an intermediary.

Inside those ceilings sit per-priority internal targets. They are a service goal and never a relaxation of the statutory number, which is what the first test in `__tests__/support/sla-and-reference.test.ts` pins. The table below lists the targets.

| Priority | Acknowledge | Resolve |
| -------- | ----------- | ------- |
| `URGENT` | 2 hours     | 1 day   |
| `HIGH`   | 8 hours     | 3 days  |
| `MEDIUM` | 24 hours    | 7 days  |
| `LOW`    | 24 hours    | 15 days |

`slaDeadlinesFor(priority, from)` is called once at intake and its two deadlines are stored on the ticket, never re-derived on read. That is the same rationale as `Appointment.cancellationPolicySnapshot`: a later change to the table above must not retroactively re-date the breach of a ticket that is already open.

**The resolution clock pauses while the ball is in the user's court.** Without that, a customer who takes a week to answer reads as the team breaching and the number stops meaning anything. A staff reply calls `applyStaffReply`, which sets `awaitingUserSince` and, on the first occasion only, `acknowledgedAt` and `firstAgentReplyAt`. A user reply calls `userRepliedPatch`, which folds the wait that just ended into `pausedSeconds` and clears `awaitingUserSince`; it is a no-op when nothing was being awaited, so a user sending three messages in a row cannot bank three pauses. The effective deadline is therefore `resolutionDueAt + pausedSeconds`, computed by `effectiveResolutionDueAt`. Seconds are used rather than milliseconds because an `Int` of milliseconds overflows at 24.8 days, which a ticket parked on the user for a couple of months would reach. The **acknowledgement** clock never pauses, because nobody has replied yet and there is therefore nothing to be waiting for.

An internal note is not a reply. `applyStaffReply` runs only when `isInternal` is false, since the user has not heard anything and nothing is yet owed back to them.

Breach state is derived by `slaStateOf(clock, now)` and never stored. A stored breach flag needs a cron to stay honest and is wrong between runs, whereas the five stored timestamps plus the current time are complete. Two indexes on `SupportTicket` make the sweeps cheap: `[acknowledgedAt, ackDueAt]` answers "unacknowledged and past due" and `[resolvedAt, resolutionDueAt]` answers "unresolved and past due".

`firstAgentReplyAt` is deliberately distinct from `acknowledgedAt`. An automated acknowledgement satisfies the latter; only the former is the number that predicts CSAT, and it is set once and never moved so that an auto-acknowledgement cannot claim it.

## How breaches surface to staff

Breach is computed on read, so every surface calls `slaStateOf` with the same stored stamps and the current time, and none of them can disagree.

- **Badges.** `slaStatusBadge` renders `Breached` (either clock past due), `Waiting on customer` (the pause is running), `Due soon` (acknowledgement within six hours, or resolution within twelve) or `On track`. `slaHint` renders the tighter running clock as a short countdown. The paused state is labelled explicitly, so a quiet ticket that is waiting on the customer is never mistaken for one that is being ignored.
- **The default order is by deadline.** `parseInboxFilters` defaults the sort to `sla` for the `Needs reply` and `SLA at risk` views, which are the views a staff member lands on, and to `activity` for the others; `sort=sla` and `sort=activity` can still be chosen explicitly. The SLA comparator ranks unacknowledged tickets by `ackDueAt` first, then everything by `resolutionDueAt`, with oldest first as the tie-break and the case key as the final tiebreak, so a breach rises to the top without anyone choosing a sort.
- **The queue views exclude paused tickets from "needs reply".** `Needs reply` is `OPEN` or `IN_PROGRESS` with `awaitingUserSince` null, and `SLA at risk` additionally requires an unpaused ticket whose acknowledgement deadline is within six hours or resolution deadline within twelve.
- **Paging is exact.** The inbox merges two tables (tickets, and conversations that have not escalated) and must reproduce a single `ORDER BY`. For the SLA sort, `readTicketKeysBySla` issues two ordered reads whose database orders each match the comparator, awaiting-acknowledgement tickets first and the rest by resolution deadline, each reading `skip + take` rows, and `mergeCasePage` sorts the union and slices the page. No row can be skipped or repeated across pages. Depth is capped at `INBOX_MAX_DEPTH` (1000 rows), beyond which the response sets `truncated` instead of paging further.

Conversations carry no statutory clock, so the SLA views and the priority filter exclude them.

## Related

- [05-schema-reference.md](05-schema-reference.md) lists the columns these two features added.
- [07-ticket-lifecycle-and-concurrency.md](07-ticket-lifecycle-and-concurrency.md) describes how replies start and stop the pause.
- Public contact and Help Center surfaces (`app/(pages)/constants.ts`, `app/(pages)/contactus/**`, `app/support/**`, `app/(pages)/grievance/page.tsx`) derive `ACK_PROMISE_COPY` (`within 24 hours`) directly from `STATUTORY_ACK_HOURS` so public promises always match `lib/support/sla.ts`.

## Deprecated & Superseded Approaches

- **A single `ackDueAt` ordering for the SLA sort**: it ranked acknowledged tickets by a deadline the comparator ignores, so pages disagreed with the merge. Superseded by the two-read ordering above.
- **A default activity sort with breaches reachable only through `sort=sla`**: breaches were easy to miss. Superseded by the SLA sort as the default for the work-queue views.
- **A stored breach flag or a breach-sweep cron**: not built, and not wanted. A stored flag is wrong between runs, so breach stays derived on read.
- **Hardcoded `"24–48 hours"` public reply copy across contact and Help Center pages**: superseded by `ACK_PROMISE_COPY` (`within 24 hours`) bound to `STATUTORY_ACK_HOURS`.
