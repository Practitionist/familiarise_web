---
type: reference
---

# Scheduling Grid UX Rules

The scheduling grid is the week calendar that five pages share: the consultant's allocate page, both reschedule pages, the consultant's Manage timings page and the consultee's free rebook. Each page renders `components/scheduling/TimePicker.tsx`, which mounts `SafeUnifiedCalendar`, which renders `UnifiedCalendar` and its markup component `WeekGrid` (all in `components/scheduling/`). The grid draws seven days of 30-minute atoms in the viewer's display zone. These are the deliberate rules of its layout; check them before "improving" it.

The colours of the twelve cell states, their non-colour cues and the precedence between them live in `lib/scheduling/interval-status-tokens.ts` and are documented in `.claude/skills/booking/references/availability.md` §7. This page covers structure only.

## 1. A continuous ruled canvas

The grid reads as a paper calendar, not as a field of buttons.

- **Geometry.** Every half-hour row is 24 px tall (`GRID_ROW_PX` in `WeekGrid.tsx`), so an hour is 48 px. Cells sit edge to edge with no gap and no rounded corners, and cell and row-label text is 11 px. The axis prints the hour on the first row of each local hour, so a host in a :45-offset zone (rows at :15 and :45) still reads 18:00 over the 18:15 row, and every row keeps its full name for screen readers. The column template (`GRID_COLS`) lives in `lib/scheduling/week-grid-geometry.ts` so the loading skeleton can share it.
- **Rules.** Each gridcell draws the day-column line on its left and the row rule under it: a solid line where the next hour starts and a lighter dashed line at the half-hour (`canvasCellClass` in `WeekGrid.tsx`). The rule is drawn over the cell's fill, so it shows through coloured time too. The sticky day header has a stronger bottom border, and today's date sits in a filled pill. Row labels print only the hours; the half-hour label stays in the row header for screen readers.
- **Runs read as one.** A cell whose neighbour above or below paints the same state drops the shared border, so a stretch of free time reads as one outlined region rather than a stack of boxes.
- **Closed time is visible.** A cell with nothing published (`unavailable`) keeps its paint-free token, and the gridcell beneath it carries a light 135° hatch (`CLOSED_CANVAS`). The hatch is unlike the faded `past` cell and the 45° slate stripe of `outsidePeriod`, so the three never read alike. Times a clock change skips on one day get the same hatch.
- **The now-line** stays inside today's column, above blocks.

## 2. Open hours instead of folding

The toolbar's **Open hours | Full day** toggle decides which rows are drawn. Open hours, the default, crops the grid to the week's earliest and latest live row, padded by one hour each side and clamped to the day (`openHoursWindow` and `OPEN_HOURS_PAD_ROWS` in `lib/scheduling/week-grid-model.ts`). A row is live when any cell in it is an in-period published, booked, this-booking, selected or requested time (`WeekCells.live`, built by `buildWeekCells`). Closed gaps inside the window, such as a lunch break, stay visible as hatched cells, because hiding them misstates the day. Full day draws every row.

A week with nothing live has no window: the grid shows the full day, disables Open hours, and says why in one line. "Nothing is published this week" covers an empty week, and "Nothing this week falls inside this booking's dates" covers a week whose only published time lies outside the booking's period. The toggle is not persisted.

The initial scroll still lands on the focus target (`focusTargetMinute` and `focusScrollRow` in `lib/scheduling/time-picker-focus.ts`), clamped into the drawn rows.

## 3. Session blocks

Busy and picked time is drawn as one block per run, not a pill per half-hour. `buildGridBlocks` (`lib/scheduling/grid-blocks.ts`) turns the cell matrix into blocks for the six block states in `BLOCK_STATES`: `fullyBooked`, `partiallyBooked`, `thisEvent`, `selected`, `rescheduling` and `justTaken`. An atom joins the open run only when it has the same state, the same requested flag and the same overlapping booking, starts exactly when the run ends, and falls on the same calendar day in the grid zone (the `dayKey` rule that `groupSelectedIntoSessions` uses), so a run never crosses local midnight. A time the clocks skip neither breaks nor extends a run, so a block spans it. Two back-to-back bookings stay two blocks.

`WeekGrid` lays the blocks on an overlay with the same columns and row pitch as the cells (`BlockLayer`). Each block paints its state's own token fill, border and pattern, with the state's icon and a 12 px label: the overlapping booking's title when the route sent one, otherwise the state's name, then the time range ("Spanish B1 · 10:00 am–11:30 am"). A run of the client's requested times carries the `REQUESTED_OUTLINE` ring. The overlay is `aria-hidden` and ignores the pointer; the cells underneath keep the clicks, the roving focus and their accessible names (state, "Requested", date and time), and every cell keeps `data-slot-state`, `data-slot-start`, `data-day-index` and `data-row-key`. The other six states stay per-cell fills. Cells carry no visible text.

## 4. Hover ghost and whole-session picks

When the pointer or keyboard focus rests on a free cell in allocate or select mode, the grid draws a dashed ghost over exactly the atoms a click would pick ("New session · 10:00 am–11:00 am"). The click and the ghost share one function, `expandToSession` in `lib/scheduling/week-grid-model.ts`: it grows forward from the cell, else backward, else both ways, over atoms that `isFreeAtom` in `UnifiedCalendar.tsx` accepts. When no whole session fits, the ghost turns red and says "Doesn't fit here", and a click shows the `notEnoughConsecutive` toast. A session that crosses midnight draws one ghost piece per day column. The ghost clears when the pointer or focus leaves the grid.

Clicking any atom of a picked session removes that whole session and nothing else. `splitIntoSessions` (`lib/scheduling/calendarUtils.ts`) cuts each same-day run of picks into session-length pieces from its start, so two back-to-back picks stay two sessions, and the click hands that piece's atoms to the selection hook's `removeSlots`.

## 5. The session tray

`components/scheduling/SessionTray.tsx` holds everything about the picks, in a panel right of the grid from 1280 px and docked under it below that, so the grid keeps the height. From top to bottom it shows:

- the progress sentence, which doubles as the "Go to selection" scroll control once something is picked, over a meter of picked against needed sessions;
- the plan meters: "This week" from the subscription quota (`quotaFooterText` in `lib/scheduling/grid-quota.ts`), "Plan total" from the entitlement, and "Per day" from the quota's `perDayCap` or, for a class, `maxSessionsPerDayFor` (`utils/scheduling-engine/sessionCaps.ts`);
- the numbered picks ("Session 2 · Thu 13 Nov · 6:30 pm–7:30 pm"), each with a remove button, then a dashed placeholder for the next one while more are needed;
- the plan warnings passed in through `UnifiedCalendar`'s `warnings` prop;
- the legend (`SlotStatusLegend`, handed in by `SafeUnifiedCalendar`), trimmed to the painted states with live counts (`legendKeysFor`);
- the freshness label and the "limits counted in" zone note;
- the screen-reader progress line ("1 of 3 times picked", announced politely);
- on the allocate surfaces, the sticky actions: Cancel, Auto-schedule and Save picked times.

The partial-offer dialog ("Only 2 of 3 sessions fit") stays a modal outside the tray. On the reschedule surfaces the tray shows the picks and the legend while `TimePicker` keeps its own footer with Cancel, "Any time works" and the submit button. A read-only grid has no tray; its legend sits above the grid.

## 6. The context row

`components/scheduling/SchedulingContextBar.tsx` puts the facts about what is being scheduled on one row of chips above the grid, in place of stacked banners. `UnifiedCalendar` builds the chips it knows: the plan cadence and session length, the plan week ("Week 3 of 12") and plan end from the quota, the booking's window ("Requested window", "This cycle" or "Scheduling period"), and the earliest start, which is now plus the grid's lead time. `TimePicker` adds the chips only it knows through `contextChips`: a reschedule's notice rule ("Moves not within 24 h of the start · not refunded"), and on Manage timings the class plan and its length in months. The zone line and its switch (`ZoneSwitch`) end the row. The refresh-failed and own-sessions-failed alerts stay as compact inline alerts under it, because each has a retry button. On a phone the day list shows the same row with the zone line beneath.

## 7. Month view and "N fit"

The week header and the month view both say how many whole sessions each day's free time holds: "3 fit", "1 fits" or "None fit" (`fitLabel`). The count is session-length aware: each unbroken run of free atoms holds `floor(run / session length)` sessions (`sessionsThatFit`), so two free half-hours on either side of a booking hold no one-hour session. The count is not capped by the plan's per-day limit, which the tray states separately. The week header counts the visible column's `available` cells (`weekDayFits`); the month view resolves every fetched cell through `describeAtom` and buckets it by its calendar day in the grid zone, so a late-evening slot in New York is counted on its New York day. A session that runs past local midnight counts once, on the day it starts (`week-grid-model.ts`, `calendarUtils.ts`). The month view starts its weeks on the grid's `weekStartFor` day (a subscription's cycle weekday, otherwise Sunday) and computes the leading blanks from the calendar date itself, never from a device-local midnight.

## 8. Loading

`useCalendarData` starts with `loading=true` under `autoLoad`, so the first paint is `CalendarGridSkeleton` (`components/scheduling/CalendarSkeletons.tsx`), never the empty state. The skeleton draws the context row, the toolbar, the 64 px header over 24 px rows on `GRID_COLS`, and the tray, so nothing shifts when the data lands. Week navigation keeps the old grid rather than flashing the skeleton.

## 9. The time pickers

There are three time pickers, one per job (owner decision 2026-11-12, built; see [the booking follow-up train](../decisions/2026-11-12-booking-follow-up-train.md) and [the trial and public booking surfaces record](../decisions/2026-11-13-trial-and-public-booking-surfaces.md)). Do not add a fourth, and do not give a new surface its own picker.

| Job                           | Component                                                                                                               | Used by                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pick one time                 | `SingleTimePicker` with `MonthGrid` (`components/scheduling/`), options from `lib/scheduling/single-session-options.ts` | Dark, buyer: the One-time booking dialog and the trial step of the mentorship dialog. Light, buyer: both trial reschedule pages and the organisation's manual allocation. Light, host: the webinar start and class first session in the editor, the re-time dialog and the class make-up |
| Place many sessions on a week | `UnifiedCalendar`, `WeekGrid`, `SessionTray`, with `MobileDayListPicker` as its phone form                              | Allocation, reschedules and the consultee's plan scheduling                                                                                                                                                                                                                              |
| A repeating class pattern     | `ClassPatternScheduler`                                                                                                 | A class's series and its series move                                                                                                                                                                                                                                                     |

The single-time picker lays itself out by the width its container gives it, not by the viewport, because most of its callers are dialogs. Below 700 px it stacks the month above the chosen day's times. At 700 px or more it puts them in one row and fills its container at any width. The month pane is only as wide as its grid: 40% of the picker, but never under 22rem or over 30rem. The times pane takes all the rest, and the two panes stretch to the same height. Day cells are 44 px tall and at most 48 px wide. `useWidthStep` (`hooks/use-width-step.ts`) measures the picker and the times list with a `ResizeObserver`. The times grid gets one column per 7.5rem the list can hold, from two on a phone up to six side by side, and at most four when stacked. On a 2560 px screen the editor's Sessions card is about 2240 px wide, so the month pane is 30rem (480 px) and the times pane about 1730 px, with six columns. A buyer is offered only free times inside the expert's published hours; the day's booked or held times sit behind "Show N taken times". In the One-time dialog each taken time carries "Notify me" (or "Waiting" with "Withdraw"); the other buyer pickers (the trial step, the trial reschedules and the organisation's allocation) list taken times without it. A host sees free times and booked times (labelled "Booked") and reveals the rest of the day's half-hour starts, labelled "Outside your hours", with a "Show times outside my hours" switch. Each caller passes its writer's purpose, so the picker uses that writer's lead (`leadMsFor` or `eventLeadMs`) and never restates it. The month alone (`MonthGrid`) picks the mentorship start date.

## Deprecated & Superseded Approaches

- **Dead-hour folding.** Rows with nothing live, including mid-day gaps, folded into 24 px "Unavailable · HH:MM–HH:MM" strips that expanded on click, with a separate "Outside this booking's dates" strip. It hid the shape of the day and squeezed the text to 10 px. `lib/scheduling/dead-hour-bands.ts` is deleted; the open-hours window replaces it.
- **Sparse run labels.** Only the first cell of a same-state run carried its state's word, so a 90-minute booking read as three lock pills with one word. Session blocks replace it, and `CellView` no longer has a `text` field.
- **Footer chips and the quota pill.** Picks showed as chips in a footer row beside the quota pill and the buttons, and same-day back-to-back picks merged into one chip. The session tray replaces the row and numbers each session.
- **Stacked banners.** The reschedule notice, the blue window banner and, on Manage timings, the class badges and a tip that printed the weekly session count as a daily maximum each took a full-width row. The context row replaces them; the class daily cap comes from `sessionCaps.ts`.
- **"N h free" in the month view.** The month cell summed free half-hours from a Sunday-first, device-local month; "N fit" replaces it.
- **Eight pickers, one per surface.** The single-session "pill wall" (`SingleSessionPicker`), the dark trial day strip (`TrialSlotPicker`), the One-time dialog's own calendar and `SlotList`, and the `datetime-local` boxes in the class editor and the organisation's allocate dialog, and the light trial month calendar (`TrialScheduleCalendar`) each disagreed on states and leads. They are replaced by the single-time picker.
