# DST & Timezone Posture (#872 stub — read before touching availability)

> Status: **IST-first launch, DST deliberately deferred** (#872). This page is
> the caveat sheet the audit asked for: what the stub does, what silently
> breaks, and the rules for any code that touches availability time math.

## What the launch model is

- `SlotOfAvailabilityWeekly` stores **minutes-since-midnight UTC**
  (`startTimeUtc`/`endTimeUtc`) plus a **frozen `utcOffsetMinutes`** captured
  at row creation. That frozen offset — NOT an IANA zone — is the live source
  of truth for projecting weekly rows onto concrete dates.
- The DST-correct representation (local wall-clock + IANA `timezone` +
  `localStartMinutes/localEndMinutes/localStartDay`) **already exists as
  nullable columns but is unwritten everywhere**. Going DST-aware needs no
  migration; it needs the algorithm + UI work tracked in #872.
- Custom availability (`SlotOfAvailabilityCustom`) stores absolute UTC instants
  — unaffected by the stub.
- Event bucketing (`dayKey`/`weekKey`, ADR B9) uses each event's
  `schedulingTimezone` via date-fns-tz, which IS DST-correct for the zones it
  evaluates. The stub only affects **weekly availability projection**.

## The silent hazard

A consultant whose UTC offset changes after publishing availability (travels,
or their zone enters DST) gets future sessions materialized at the OLD offset:
a Mon 09:00 IST row becomes Mon 03:30 UTC forever, even after the consultant
is at UTC+1. Both parties then see consistent-but-wrong local labels, because
every surface renders in viewer-local time.

## Rules until #872 lands

1. Never write the local* columns from new code — they are reserved for the
   #872 migration; writing them half-way creates two sources of truth.
2. Any NEW consumer of weekly availability MUST go through
   `isMinuteWithinWeeklySlot` / `getNextOccurrenceWeekly` /
   `matchWeeklySlotToDay` (utils/slotAllocation/slotTimeUtils.ts +
   SlotAllocationService) so the frozen-offset semantics stay in one place.
3. Do not "fix" a +5:30 mismatch by editing offsets by hand — regenerate the
   consultant's availability rows instead.
4. A cheap pre-#872 guard worth building when touched next: on weekly
   availability edit, compare the stored `utcOffsetMinutes` against the
   consultant's CURRENT profile timezone offset and warn on drift
   (tracked inside #872's scope).

## Related

- Schema doc-comment block on `SlotOfAvailabilityWeekly` (prisma/schema.prisma)
- #1168 — draw the slot grid in `schedulingTimezone` (prerequisite for #872)
- #1200 — the travel-hazard operational caveat
