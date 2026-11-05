---
title: Regular time and the 4-week roll-forward
description: How a 1:1 plan's weekly Regular time opens a 4-week horizon, how the hourly roll-forward fills it, how catch-up and the derived conflict list work, and how each fails.
---

# 24. Regular time and the 4-week roll-forward

> A consultant sets a 1:1 plan's **Regular time** (weekdays and one local start each, in the plan's zone). Setting it is consent to automatic placement: the current plan week is placed in the request, and an hourly job keeps the next four plan weeks placed. Plans without a Regular time keep the Phase 0 pacing ("this week, or next once full") and the week reminder ladder. Decisions: [ADR train B](../decisions/2026-11-04-booking-v2-train-b.md), decisions 1–4.

## 1. Data

- `RegularTime` rows: `weekday` (ISO 1–7), `localStartMinutes`, `timezone`, `validFrom` (the first plan-week start it applies to), `validUntil` (set when superseded), `createdByUserId`. At most one live row per weekday and time (`regular_time_one_live_slot`).
- A week is projected with the rows in force at its start (`validFrom ≤ weekStart < validUntil`), so an edit never moves a week that was already placed.
- `Subscription.lastRolledAt` is the job's rotation stamp; `rollPausedAt` stops the job for the plan (set by the pause rule, cleared by saving the Regular time).
- There is **no conflict table**: the list is derived on every read.

## 2. Setting it (`setRegularTime`, `lib/booking/regular-time/service.ts`)

```mermaid
sequenceDiagram
  participant C as Consultant (allocate page)
  participant R as PUT /api/appointments/[id]/regular-time
  participant S as setRegularTime
  participant DB as Postgres
  participant A as allocate (manual, one session per call)
  C->>R: { slots }
  R->>S: actor, subscriptionId, slots
  S->>S: auth (consultant or host-org operator, never the client), shape, lattice
  S->>DB: under the appointment lock, one tx: CAS-close live rows, insert new rows, rollPausedAt = null, stage client bell
  S->>A: place this plan week's free slots (schedule:regular)
  R-->>C: "This week is booked; the next 3 weeks fill within the hour."
```

- **Who:** the plan's consultant, or an active `catalog.manage` operator of the plan's host org (`isHostOrgOperatorOf`). The client is always refused (`NOT_ALLOWED`, 403).
- **Shape:** exactly `sessionsPerWeek` slots (`REGULAR_TIME_SLOT_COUNT`, 400), one per day (`REGULAR_TIME_SAME_DAY`, 409), and every projected start on the UTC half-hour lattice for the rest of the plan (`REGULAR_TIME_OFF_GRID`, 409, naming the nearest valid local times, e.g. "Pick 08:45 or 09:15" in Kathmandu).
- **Edit boundary:** a first set starts this plan week; an edit starts at the first plan week from now that holds nothing. The live rows close at that week (`validUntil`), so placed sessions never move.
- **Replay:** sending the same slots again writes nothing and answers `replayed: true`. A concurrent edit that closed the rows first is `REGULAR_TIME_CHANGED` (409).
- **Notice:** one client bell, `dedupeKey regular-time:<subscription>:<validFrom>`, staged in the tx and flushed after commit.
- **Placement:** only the current plan week, inside the edge budget; the job fills the rest.

## 3. The horizon (`subscriptionEntitlement`, `lib/booking/entitlement.ts`)

- Plan week k is `[day0 + 7k, day0 + 7k + 7)` zone-days from the plan start, as in Phase 0.
- With a live Regular time (`hasRegularTime`), the open weeks are `current … current + 3` (inside the plan end), each with its own capacity. `entitlement.horizon` lists them as `{ weekIndex, capacity, held, startsAt, endsAt }`.
- Without one, `horizon` is the single Phase 0 week (`cycle.ordinal`), so every reader takes one path.
- `cycle` stays for the one-week readers (Auto, the footer, the reschedule window): its week is the first horizon week with room.
- The validator (`SubscriptionValidationService`) accepts a placement in any horizon week within that week's room; the allocator's period runs to the last horizon week's end (`horizonEndOf`); the grid quota carries `horizon[]` and paints a full open week "Limit reached".
- Lead time, the daily cap, the EXCLUDE constraint and the slot-batch locks are unchanged. A release is still one week at a time.

## 4. Catch-up (`lib/booking/regular-time/catch-up.ts`)

$$\text{backlog}(k) = \max\Big(0,\ \text{perWeek}\cdot e - \text{held}(<e) - \text{refunded} - \sum_{e \le i < k}\max(0, \text{held}_i - \text{perWeek})\Big),\quad e = \min(k, \text{current})$$

- `weekCapacity(k) = perWeek + (backlog(k) > 0 ? 1 : 0)`, capped by the zone-days of the week inside the plan and by what remains of `sessionsTotal − sessionsRefunded`.
- Open weeks after the current one assume the weeks before them fill at cadence, so an unplaced open week never inflates the next one; catch-up already placed in an open week pays the backlog down.
- `perWeek` is the frozen `sub.sessionsPerWeek ?? plan.sessionsPerWeek`.
- The job places only Regular-time slots (perWeek a week); the catch-up session is placed by the consultant (pick a time, or Auto this week).

## 5. Conflicts, derived on read (`lib/booking/regular-time/conflicts.ts`)

Per horizon week, while the week is under capacity, each projected slot with no own session gets a reason, first match wins:

| Reason          | Meaning                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAST_PLAN_END` | The session would end after the plan end                                                                                                                              |
| `TOO_SOON`      | Inside the allocate lead (`leadMsFor("allocate")`)                                                                                                                    |
| `TAKEN`         | Another live session of this host overlaps (any event or buyer)                                                                                                       |
| `OUTSIDE_HOURS` | Not inside the host's hours (`hostHoursPredicate`: the allocator's own weekly/custom contract, every 30-minute atom; a multi-day custom row covers each day it spans) |

Plus `HOURS_CHANGED` for any placed future session now outside the host's hours, whatever the count. `shortBy = capacity − held`. A past week that ended under capacity is missed (`isMissedWeek`).

## 6. The job: `roll-forward-regular-time`

- One implementation: `rollForwardRegularTime` (`lib/booking/regular-time/roll-forward.ts`), registered in `lib/cron/cleanup-registry.ts`, run by the ticker hourly at :50 except 03:50 UTC (`TARGET_WINDOWS`), bite 25.
- `withCronLock("roll-forward-regular-time", { failMode: "closed" })`, `startDeadline`, Sentry once per run (`createRunFailureReporter`).
- Selection (`rollablePlansWhere`): APPROVED or SCHEDULED, not deleted, `rollPausedAt` null, plan not ended, a live Regular time, no tentative row (a reschedule in flight waits). Ordered by `lastRolledAt NULLS FIRST, id`.
- Per plan: project the horizon, skip slots that overlap an own session, skip slots with a reason, cap each week at its room, place each slot with its own `allocate` call (manual, `topUp`, `allowPartial`, `byRegularTime` → history `schedule:regular`), then CAS `lastRolledAt`.
- Conflicts after placement feed one consultant bell per local day (`nudgeRegularTimeConflicts`, `dedupeKey roll-conflicts:<consultant>:<localDay>`, 08:00–21:00 local, outside quiet hours). Regular-time plans are off the Phase 0 ladder (`nudgeablePlans` excludes them).
- Summary: `plansScanned`, `sessionsPlaced`, `conflicts`, `errors`, `hasMore`; needs attention when `errors > 0`.

## 7. Failure modes

| Failure                                                  | What happens                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Another buyer takes a slot between projection and commit | That `allocate` call refuses; the slot is skipped and listed `TAKEN`; the rest land                                         |
| Two runs overlap                                         | The lease refuses the second; if both ran, the own-session skip and the per-host EXCLUDE constraint stop a double placement |
| Deadline                                                 | The run stops starting plans, answers `hasMore`, and the rotation reaches the rest next hour                                |
| A plan read fails                                        | Counted in `errors`, reported once per run, the batch continues                                                             |
| Availability shrinks over a placed session               | Never moved or refused; listed `HOURS_CHANGED`                                                                              |
| The consultant edits while a run places                  | The run projects each week with the rows in force at its start; the CAS close in the edit refuses a racing second edit      |

## 8. UI

- Allocate page: the Regular-time card (`components/scheduling/RegularTimeCard.tsx`) above the grid, mobile-first day chips and a time select in the plan's zone, live hints from `regularSlotsRefusal`, then "Week N of W" rows for the horizon with **Pick another time** (opens the grid on that week), **Auto this week** (the existing top-up) and **Skip, catch up later** (a client-side dismissal), and an "N to fix" badge.
- Client detail: `RegularTimeSummary`, read-only "Your regular time: Mon, Wed, Fri at 18:00 (Asia/Kolkata)" and the next sessions.
- On a phone with Auto available, the desktop notice says only picking exact times needs a computer.

## Deprecated & Superseded Approaches

- **A stored conflict table** was rejected: the list is derived on read, so nothing drifts from bookings or hours.
- **A "place what fits" batch variant of manual mode** was not added: the two Regular-time callers place one session per allocator call, which gives partial placement with the existing commit path unchanged.
- **The Phase 0 week ladder for every plan** is superseded for plans with a Regular time: they are reminded only when their horizon has conflicts.
