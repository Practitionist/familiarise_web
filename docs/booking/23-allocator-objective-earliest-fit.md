# ADR B12 — The allocator's objective is earliest-fit, and that is the decision

> Status: **adopted**. This record exists because the objective was implemented
> but never written down, so a reader could only infer it — and a reader who
> inferred "something smarter" would be right about the code and wrong about the
> intent. Decided by the booking owner alongside the wave-1 allocation and grid
> correctness work; the code it describes is `SchedulingService.autoAllocate`
> (`findAvailableSlots` → `sweepPeriod` → `tryPlaceOnDay` →
> `bestFittingBlockInRow`) and `bestBlockForSingleSession`.

## The decision

**The allocator minimises, lexicographically, the pair (calendar day, then
time of day). Nothing else.**

It walks the scheduling period forward one day at a time. Inside a day it walks
that day's availability rows in chronological order, and inside a row it walks
30-minute starts in chronological order. The first candidate that can host a
whole session is the one that gets placed. Then the counters are updated and the
same day is re-attempted, because the per-day cap permits more than one session
on a day.

Stated as an objective function, for a candidate session start `s` on a day `d`:

```
minimise (dayKey(s), timeOfDay(s))
```

subject to the hard constraints — published availability, the consultant's and
the consultee's live bookings, the per-day cap (`sessionCaps.ts`), the
`sessionsPerWeek` ceiling, and the scheduling period.

### Preference scoring reorders; it never removes

`preferenceScoring.ts` scores candidates that are **already legal**. It is applied
as a maximum over placeable candidates, and the sweep that accepts only a perfect
match (`sweepPeriod(true)`) is always followed by an unconditional
`sweepPeriod(false)` over the same window. So a stated preference can change
*which* of the equally-legal placements is chosen and can never change *whether*
one is found. With no preference the score ceiling is `0`, the first placeable
candidate hits it, and the walk returns exactly what the plain first-fit walk
returned. This is the #1065 safety property, and it is the reason a preference
is not a filter.

### `sessionsPerWeek` is a ceiling, not a target

The weekly counter is only ever tested as `>= sessionsPerWeek → skip this
row/week`. There is no term that rewards spreading sessions out and no term that
rewards keeping a week under-filled. The consequence, stated precisely because it
is regularly misremembered in both directions:

- **Within a week, the ceiling is binding.** A plan with `sessionsPerWeek: 1` puts
  at most one session in any week.
- **Across weeks, there is no distribution at all.** The allocator fills week 1 to
  its ceiling, then week 2, and so on. So a plan sold as *8 sessions over 4 months
  at 1 per week* places all eight in the **first eight weeks**, not across the
  four months; and a plan sold as *8 over 4 weeks at 2 per week* places eight in
  four weeks. `durationInMonths × sessionsPerWeek` is what the period can HOLD,
  not the shape the allocator produces.

### What a consultant should expect

- Sessions land as early in the period as the published availability allows, as
  early in the day as that day's first available row allows, and as early in each
  week as the `sessionsPerWeek` ceiling allows.
- The plan's "N sessions over M months" is a ceiling on how many are placed and on
  how fast, not a schedule shape. A consultant who wants a different shape
  publishes availability that forces it: the only levers the allocator reads are
  which days and hours are published, and the per-day cap.
- A reschedule replaces sessions in place and re-runs the same objective, so a
  moved session can land anywhere the earliest-fit walk reaches — including
  earlier than it was.

## Non-goals — do not "fix" these without a decision

- **No fragmentation minimisation.** The allocator does not try to leave a
  bookable remainder, does not avoid splitting a long free block, and does not
  prefer a placement that leaves a 30-minute tail. Nothing in the objective
  mentions the shape of the calendar that remains.
- **No load balancing.** No term spreads sessions across weeks, across days of
  the week, or across times of day for the allocator's own sake. A consultee's
  stated preference may reorder the candidates — never add one, never remove one
  — so a balanced shape can be *asked for*, but it is never the default.
- **No fairness between a plan's sessions.** The k-th session is placed by the
  same rule as the first; earlier sessions can and do occupy the best times.
- **No cost function.** There is no weighting, no tunable, and no score other than
  the preference score that only reorders.

## Why

Earliest-fill is the standard objective in inventory and capacity systems that
allocate a scarce resource to a queue of demand: it is the cheapest correct
thing to compute, it is trivially explainable to the person whose calendar it
touches, and it is deterministic — the same availability yields the same plan,
which is what makes an allocation reproducible across a retry and auditable
afterwards. Every alternative considered here costs more (search, or a scoring
function nobody can state precisely) to buy a property — a prettier calendar, a
flatter load — that no party has asked for.

The properties that would justify a richer objective (fragmentation, balance)
matter when the scarce resource is being rationed among several claimants who
each need a *usable* chunk. Here each placement is one contiguous session inside
one consultant's own published hours, so a leftover partial block has no claimant
to be denied. That is the reasoning; it is also the thing to revisit first if a
future requirement makes fragmentation or balance matter, because the argument
rests on there being no second claimant.

## What this decision is not

It is not a statement that the buyer's 15-minute lead time applies to
server-picked slots. That asymmetry is separate and deliberate: `slotStartRefusal`
enforces the `:00/:30` grid and the 15-minute lead for a *client-picked* start,
while the allocator's re-validation keeps a five-second buffer because its slots
were chosen moments earlier by the server. See the comment in
`lib/payments/utils/slot-validation.ts`.

## Where the code is

| Concern | Location |
| --- | --- |
| The day-by-day walk | `SchedulingService.findAvailableSlots` → `sweepPeriod` |
| Placement inside one day | `tryPlaceOnDay` → `bestFittingBlockInRow` |
| Candidate starts inside one row | `candidateStartsInRow` (floored to the booking grid) |
| Preference as a ceiling, not a filter | `utils/scheduling-engine/preferenceScoring.ts`, `sweepPeriod(true)` followed by `sweepPeriod(false)` |
| Per-day and per-week caps | `utils/scheduling-engine/sessionCaps.ts`, the two counter maps in `findAvailableSlots` |
| The client's 15-minute lead time | `lib/payments/constants.ts`, `lib/payments/utils/slot-validation.ts` |
