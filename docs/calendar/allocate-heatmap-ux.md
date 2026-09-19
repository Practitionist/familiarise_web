# Allocate Heatmap UX Notes

The consultant allocate heatmap (`components/scheduling/UnifiedCalendar.tsx` via
`SafeUnifiedCalendar`) is a 7-day × 48-row grid of 30-minute atoms. These are
the deliberate UX rules; check them before "improving" the grid.

## Sparse run-labels (do not label every slot)

Only the first cell of a contiguous same-state run carries visible text
(`continuesRun` in `renderTimeCell`, #1703 F1). A week view holds up to ~336
cells; labelling all of them is a wall of 10px text that overflows the `h-7`
cells (the `19:30Available` incident in the `GRID_COLS` comment) and destroys
salience. Meaning rides instead on:

- distinct fills per state (`interval-status-tokens.ts`),
- `title` + `aria-label` + `data-slot-state` on **every** cell,
- tooltips on booked / this-event cells,
- the legend below.

## Footer session chips (pre-commit preview)

The footer counter alone ("All 4 sessions scheduled") never said *what* was
chosen. Selected atoms collapse into same-day sessions with
`groupSelectedIntoSessions` (`lib/scheduling/calendarUtils.ts`) and render as
chips (`Thu 24 Sep · 11:00 am–12:00 pm`) in the event's scheduling timezone.
Merging requires exact 30-minute adjacency **and** a matching ADR-B9 `dayKey`:
an overnight run crossing local midnight splits into two sessions so chips
never attribute post-midnight time to the prior day. Without a zone the UTC
day is used. Chips are static text; the counter above stays the
"Go to selection" scroll control.

## Legend live counts

The legend (`SlotStatusLegend`) is sticky and trimmed to painted states
(`legendKeysFor`, #1703 QA-2). The painted-keys pass already traverses every
week × interval cell, so it also tallies per-state counts at zero extra
passes; counts ride `onPaintedKeysChange` into the legend (`Available · 12`)
and its aria-labels ("N slots this week"). Counts cover the whole visible
week, including folded dead-hour bands.

## Loading and grid structure

- `useCalendarData` starts `loading=true` under `autoLoad`, so first paint is
  the grid skeleton (`CalendarGridSkeleton`, same geometry as the grid —
  no CLS), never the "No calendar data available" empty state. Week
  navigation keeps the old grid (no skeleton flash).
- Interval rows carry a hairline (`border-b border-border/40`); unavailable
  cells stay flat/transparent on purpose (#1703 F1, #1064) — structure comes
  from the row lines, not refilled dead cells. The scroller's `pt-1` keeps
  the first row's pills clear of the sticky week header.
- Folded dead-hour bands render as `Unavailable · HH:MM–HH:MM` strips; an
  all-dead week keeps the full hour ladder with an explanatory note.

## History

- #1720: dead-hour folding, Today button, now-line, locale time/zone labels.
- #1739: skeleton-first mount, row hairlines, header-clip fix.
- #1742: session chips, legend counts, midnight-split rule.
