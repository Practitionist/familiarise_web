# 02-b · The grid: canvas, open hours, blocks and the 12 states

**Needs:** 01 (F-AV1, F-PL1, F-BUSY), HM-15 fixtures. HM-15 is `[local]` (mock pay). HM-25 needs a booking with an open reschedule from 03-consultations (run it after 03's first consultee reschedule case).
**Personas:** H1 (IST), B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles).
**Docs under test:** `docs/calendar/allocate-heatmap-ux.md` §1–3, `.claude/skills/booking/references/availability.md` §4, §7–8, `lib/scheduling/interval-status-tokens.ts`.

The grid is one component on five pages (`TimePicker` → `SafeUnifiedCalendar` → `UnifiedCalendar` → `WeekGrid`). This file checks the canvas and the cell states on the consultant allocate page unless a case says otherwise; 02-c checks picking, the tray and the context row; 02-d checks each surface's own policy, keyboard and viewports.

Reading the grid with the DevTools MCP:

- `take_snapshot`: every cell is a button with an accessible name (state, "Requested" when it applies, date and time) and `data-slot-state`, `data-slot-start`, `data-day-index`, `data-row-key`. Blocks are `aria-hidden` overlays; read their label from the screenshot or the DOM text.
- Hover a cell to read its tooltip: "<Label>. <hint>" (hints from `interval-status-tokens.ts`, quoted per case).
- `evaluate_script` to count states: `[...document.querySelectorAll('[data-slot-state]')].reduce((m,e)=>(m[e.dataset.slotState]=(m[e.dataset.slotState]||0)+1,m),{})`.
- Don't save allocations in this file: leave with **Cancel**. Booking outcomes belong to 03 and 04.

## HM-15 — Grid fixtures: one subscription to allocate, one consultation request `[local]`

**Why it matters:** the allocate grid only exists for a booking waiting on the host.

**Steps:**

1. **G-SUB.** As B1 buy H1's "qa-S-11 Four-week sprint" (`/checkout/plans/subscription/[S-11 id]`, start date = D) with **Mock Pay**. Don't allocate.
2. **G-REQ.** As H1 set Settings → Booking → "Review requests first" (S-07). As B2 open H1's expert page → "qa-S-10 Deep dive" (90 min) → Book Now → Thu D+3 10:00 IST → send the request with note "qa-HM-15". As H1 switch back to "Instant booking".
3. SQL: R-08, then R-03 for both appointments.

**Expect:**

- G-SUB: `Subscription` with `sessionsTotal = 12`, `sessionsPerWeek = 3`, `planEndsAt` = D + 28 days at 00:00 IST, no live occurrences. It appears in H1's Requests and opens `/dashboard/consultant/[H1 cid]/requests/[rid]/allocate`.
- G-REQ: `Consultation` `PENDING`, `bookingSource = 'REQUEST_SUBMITTED'`, the requested window recorded (Thu D+3 04:30Z–06:00Z). It stays PENDING after the mode switch.

**Probe further:** record both ids in the ledger as G-SUB and G-REQ. 03 and 04 may reuse them; say so in your report. If the checkout or the request fails, the rest of this file is BLOCKED.

## HM-16 — The ruled canvas

**Why it matters:** the grid must read as a calendar, not a field of buttons, and closed time must be visible.

**Steps:**

1. As H1 open G-SUB's allocate page at 1440×900. Wait for the skeleton to resolve.
2. Screenshot the week containing D. Zoom into Mon D 12:00–18:00.
3. Inspect one cell's computed styles (`get_css_styles`): height, border, font size.

**Expect:**

- Day columns separated by vertical lines; a solid line on each hour, a lighter dashed line at each half hour; no gaps or rounded corners between cells; 24 px per half-hour row (48 px per hour); 11 px cell and row-label text; row labels print hours only.
- The 13:00–17:00 gap on Mon D is drawn as hatched closed cells (135°), distinct from Past (faded) and Outside period (45° slate stripe).
- Today's date in a filled pill in the sticky header; a now-line inside today's column only.
- A run of free cells reads as one outlined region (shared borders dropped).

**Probe further:** readability at 1280×720 and 1024×768 (02-d does the full sweep): are hour labels clipped? Do dashed half-hour rules disappear under coloured fills? Contrast of the hatch against white.

## HM-17 — Open hours / Full day

**Why it matters:** replaces dead-hour folding; the lunch gap must stay visible and nothing must hide.

**Steps:**

1. On G-SUB's allocate page, read the toolbar group "Hours shown": **Open hours** (default) and **Full day**. Hover each for its title.
2. With Open hours, note the first and last drawn row for the week of D.
3. Click Full day; count the rows (48 on a normal day).
4. Navigate to a week with nothing published (Next week until past the plan, or a week after `planEndsAt`).

**Expect:**

- Titles: "Show the hours this week has open, with an hour either side." and "Show all 24 hours."
- Open hours spans from 08:00 (an hour before 09:00) to 22:00 (an hour after 21:00), with 13:00–17:00 drawn as hatched rows, not removed.
- Full day draws 00:00–24:00.
- An empty week disables Open hours (title "Nothing is open this week, so every hour is shown.") and shows one line: "Nothing is published this week. Every hour is shown so you can see where the days are." or, when published hours fall outside the booking's dates, "Nothing this week falls inside this booking's dates. Every hour is shown so you can see where the days are."
- No "Unavailable · HH:MM–HH:MM" strips anywhere.
- The toggle isn't persisted: reload → Open hours again.

**Probe further:** does the initial scroll land on the first free time? Does Saturday's 10:00–14:00 change the window (it shouldn't widen it past 08:00–22:00)?

## HM-18 — Session blocks: F-BUSY and back-to-back bookings

**Why it matters:** busy time drawn per half hour read as noise; blocks must name the booking and its time.

**Steps:**

1. On G-SUB's allocate page go to the week of D+1. Find Tue D+1 18:00–19:00.
2. `take_snapshot` of the two cells under the block.
3. If 03 or 04 has left two back-to-back H1 bookings anywhere (e.g. 17:00–18:00 and 18:00–19:00), find them; otherwise skip step 3 and say so.

**Expect:**

- One block over 18:00–19:00 with a lock icon and the label "<title or "Booked"> · 6:00 pm–7:00 pm". It doesn't name B3 (conflict text never names another party; record if a client name appears to H1 on their own grid; that may be fine for the host, note it).
- The two cells keep accessible names ("Booked … Tue … 6:00 pm") and `data-slot-state="fullyBooked"`.
- Back-to-back bookings are two blocks, not one.

**Probe further:** is the label truncated in a 60-min block? Does the block cross the day boundary for a session ending at midnight (it must not: runs never cross local midnight)?

## HM-19 — Legend and tooltips: only painted states, each explained

**Why it matters:** twelve states with colour plus a non-colour cue; the legend must explain exactly what's on screen.

**Steps:**

1. On G-SUB's allocate page, week of D+1, open the legend in the tray ("What the colours and patterns mean").
2. Count the states painted (script above) and compare with the legend entries and their counts ("<Label> · N").
3. Hover one cell of each painted state and read the tooltip.

**Expect:**

- Legend lists only painted states, each with its count; hints match the tokens: Free "Free to book.", Booked "Already taken.", Selected "You have chosen this time.", This booking "Belongs to the booking you are working on.", Being moved "Released by a reschedule and waiting for a new time.", Limit reached "This plan's sessions for that week or day are already used.", Too soon "Too close to its start for this booking — pick a later time.", Just taken "Someone booked this a moment ago.", Outside period "Inside the published hours but outside this booking's dates.", Past "Already gone; shown so the day reads whole.", Unavailable "Outside the published hours.", Partly booked "Part of this half-hour is taken — choose another time."
- Every state has a non-colour cue (icon, border style or pattern). Take a greyscale screenshot (`emulate` vision deficiency if available) and say whether any two states look alike.
- On G-SUB a "Requested" outline doesn't appear (no requested times); on G-REQ (HM-21) it does, explained as "Requested".

**Probe further:** a buyer grid (consultee reschedule) explains only four states; check in HM-50. Are any legend labels jargon ("Partly booked" for a half hour that's partly taken: is it ever reachable on a 30-min grid? See HM-26).

## HM-20 — Past and today

**Why it matters:** the past must read as gone without hiding the day's shape.

**Steps:** on G-SUB's allocate page, go to the current week. Read cells earlier today and on earlier days. Click a past free cell.

**Expect:** past cells are faded (Past, 50 % opacity), not clickable to select; click toast "Slot has passed" / "This slot is no longer available." The now-line sits at the current time in IST, inside today's column. Cells after now but inside the lead time are Too soon (HM-21).

**Probe further:** if you open the page just before midnight IST, does "today" flip at IST midnight, not at the browser's midnight?

## HM-21 — Too soon follows the writer's lead time

**Why it matters:** each writer refuses a different notice period; the grid must paint the same boundary or the user picks a time the server rejects.

**Steps (record the "Earliest start" chip on each):**

1. G-SUB allocate (settled, paid plan): the first non-Too-soon cell today.
2. G-REQ allocate (unpaid approval of a priced request): same.
3. F-BUSY consultee reschedule as B3 (`/dashboard/consultee/[B3 uid]/appointments/[F-BUSY aid]/reschedule`): same.
4. H1's expert page as B1, today, 60-min plan (book purpose, the dialog's times pane).
5. Click one Too soon cell on each grid.

**Expect:**

- 1: 15 min ahead (settled allocate). 2: 2 h ahead (unpaid). 3: 24 h ahead (reschedule). 4: no time inside 15 min is listed.
- The chip "Earliest start" shows now + lead in the viewer's zone, with title "Times need 15 minutes / 2 hours / 24 hours notice, so nothing before this can be picked." (quote the real `leadLabel`).
- Click toast: "Too soon" / "That time starts in less than <lead> — pick a later one."
- Leave the page open past one boundary (or wait a minute at a :00/:30 edge): the cell flips to Too soon on the clock without a reload.

**Cross-check:** `GET /api/scheduling/availability-with-allocation/[H1 cid]?…&purpose=allocate&unpaid=1` returns `leadMs = 7200000`; `purpose=reschedule` returns `86400000`.

**Probe further:** the G-REQ requested window (Thu D+3) has a "Requested" outline; is it painted over Free cells only? If 02's run is close to the requested time, it may itself be Too soon: record.

## HM-22 — Limit reached: the plan week and the one-a-day cap

**Why it matters:** a subscription is paced one plan week at a time and one session a day; cells that would break that must say so before the click.

**Steps (G-SUB allocate):**

1. Week of D (plan week 1): pick one session on Mon D (don't save). Look at the rest of Mon D.
2. Navigate to plan week 2 (D+7…D+13).
3. Click a Limit reached cell in week 2 and one on Mon D.

**Expect:**

- After picking Mon D, the other Mon D cells paint Limit reached (1 a day) or refuse with "One session per day" / "You can only schedule one session per day. Please choose a different day."
- Week 2 cells paint Limit reached while week 1 isn't full (the open week is the current one, or the next only once the current is full). Footer meter reads "Week 1 of 4 · 0 of 3 booked" (or with picks counted; record).
- Click toast: "Limit reached" / "Week 1 of 4 · … booked. Pick a day or week that still has room."

**Probe further:** the doc says cells "before the open plan week, in a full open week, on a full day, or at or after the plan end paint Limit reached". Check a cell after `planEndsAt` (week 5): Limit reached or Outside period? Report which and whether the copy explains the plan end.

## HM-23 — Outside period

**Why it matters:** published hours outside the booking's dates must look different from closed hours.

**Steps:** G-SUB allocate: go to the week before D (before the scheduling period starts). Click a published cell there.

**Expect:** Outside period cells (white with slate hatch, distinct from Unavailable's hatch); click toast "Outside scheduling window" / "Slots can only be selected within the scheduling period (<range>)." with the range in IST.

**Probe further:** the toast says "Slots" and "scheduling period"; the chip says "Scheduling period" or "This cycle". Is the vocabulary consistent? COPY note.

## HM-24 — This booking (Manage timings)

**Why it matters:** on Manage timings the booking's own session must be visibly "this one" and movable only outside 24 h.

**Steps:**

1. As H1 open `/dashboard/consultant/[H1 cid]/appointments/[F-BUSY aid]/timings`. Find Tue D+1 18:00.
2. Hover it; click it.
3. Leave with Cancel. Don't save.

**Expect:**

- An indigo "This booking" block with a person icon; tooltip "This booking" / "Consultation" / "Click to change this time" (or "Past session").
- If D+1 18:00 is more than 24 h away, clicking deselects the session (so a new time can be picked); within 24 h the click toasts "Session too soon" / "This session starts within 24 hours and cannot be rescheduled."

**Probe further:** what does the page say about what happens to B3 if H1 saves a new time here (proposal? instant move?). That decides 03's consultant-reschedule cases; quote it.

## HM-25 — Being moved

**Why it matters:** a released session waiting for a new time occupies the host but isn't confirmed; it needs its own look.

**Setup:** a booking from 03 with an open consultee reschedule (session `isTentative = true`, `completionStatus = 'RESCHEDULED'`). If none exists, BLOCKED (run after 03).

**Steps:** as the host, open that booking's reschedule or manage timings grid and any other H1 grid covering the same time. Click the cell.

**Expect:** orange dashed "Being moved" block with a move icon; tooltip hint "Released by a reschedule and waiting for a new time."; click toast "Session being rescheduled". On other bookings' grids the time still occupies H1 (RESCHEDULED rows still occupy) and paints Booked or Being moved (record which).

## HM-26 — Partly booked: can it happen?

**Why it matters:** "Partly booked" is a legal state; on a 30-minute grid it needs an occupancy that covers part of a half hour.

**Steps:**

1. Look for any H1 occurrence not on :00/:30 UTC: `SELECT id, "startsAt", "endsAt" FROM "AppointmentOccurrence" WHERE "consultantProfileId" = :h1 AND "deletedAt" IS NULL AND (extract(minute FROM "startsAt")::int % 30 <> 0 OR extract(minute FROM "endsAt")::int % 30 <> 0);`
2. New trial lengths are 30 or 60 minutes only (the subscription editor's "Trial length" is two radio buttons; the plan routes refuse any other value with "A trial is 30 or 60 minutes."). A plan saved earlier with another length (45 minutes exists in practice data) still books at that length: find one with `SELECT id, "trialDurationMinutes" FROM "SubscriptionPlan" WHERE "trialDurationMinutes" NOT IN (30, 60);` and, if a trial was booked on it for H1, view its last half hour on H1's grid.

**Expect:** a booked 45-min trial paints its third half-hour Partly booked (amber hatch, not selectable) and a click toasts "Partly booked" / "Part of this half-hour is taken — choose another time." With no such legacy trial and no off-lattice row from step 1, record "unreachable".

## HM-27 — Just taken `[two-browser]` `[local]`

**Why it matters:** a stale pick must drop visibly before the user tries to save it.

**Setup:** G-SUB allocate open as H1 in page 1. Page 2: B2 signed in, on H1's expert page.

**Steps:**

1. Page 1: pick Wed D+2 09:00–10:00 (don't save).
2. Page 2: B2 books S-08 at Wed D+2 09:00 IST with Mock Pay.
3. Page 1: wait up to 60 s, or blur and refocus the tab.

**Expect:**

- Page 1: the pick paints "Just taken" (rose, strike-through) for one render, then is removed; a toast "One of your chosen times was just taken" / "That time is no longer free, so it has been removed — pick another time."; the tray count drops; the screen-reader line announces it.
- R-05 for H1: zero rows.

**Probe further:** if you save before the poll lands, the server refuses with 409 `TIMES_TAKEN` or `SLOT_TAKEN` and the "That time was just taken — pick another" toast (deep race in 09). Keep B2's booking as a second busy block (ledger "HM-27") or cancel it through the product at the end.

## HM-28 — Zone labels and the zone switch

**Why it matters:** the grid renders in the profile zone, not the browser's; a viewer must always know which.

**Steps:**

1. As B3 (profile America/Los_Angeles) open F-BUSY's reschedule page with the browser in IST (default machine zone, or `emulate` timezone `Asia/Kolkata`).
2. Read the zone line at the end of the context row.
3. Click "Use my device's time zone". Read the cells for Tue D+1 again. Switch back ("Use my profile time zone").

**Expect:**

- Default: labels in Los Angeles time; F-BUSY's "This booking" block at 04:30 (PST). Zone line names the zone (e.g. "Times shown in PST (UTC−08:00) · Use my device's time zone"; quote it).
- After the switch: labels in IST; the same block at 18:00. The switch appears only when it changes something (`canSwitchToDeviceZone`).
- Cell instants (`data-slot-start`) are identical in both views.

**Probe further:** does the month view follow the same zone? Does the switch persist across reloads (it isn't required to; record)? Full browser-vs-profile sweep is 10.

## HM-29 — Kathmandu viewer: :15/:45 labels on the UTC lattice

**Why it matters:** cells stay on UTC :00/:30 whatever the offset, so a +05:45 viewer reads :15/:45 labels.

**Setup:** as H4 create a free 60-min consultation "qa-HM-29" and publish it. As B1 book it on Wed D+2 at the first time offered (10:00 IST = 04:30Z = 10:15 NPT). Free, so no gateway is needed.

**Steps:** as H4 open `/dashboard/consultant/[H4 cid]/appointments/[aid]/timings`. Read the row labels and the custom window. As B1 open the same booking's reschedule page.

**Expect:** H4 sees row labels at :15/:45 (e.g. "10:15"), cells 30 min tall, the booking block at 10:15–11:15, the rest of the 10:15–12:15 window as free cells, no half-cell offset. B1 sees the same instants at 10:00–11:00 IST.

**Probe further:** midnight rows: is 23:45 the last row of H4's day and 00:15 the first of the next? Any cell straddling two day columns is a bug. At the end, cancel the booking through the product (free, no money) and archive the plan.

## HM-30 — Skeleton and loading geometry

**Why it matters:** the first paint should be the skeleton, never a flash of "nothing published".

**Steps:** hard reload G-SUB's allocate page with network throttled (`emulate` slow 3G if available). Screenshot during load and after.

**Expect:** the skeleton shows the context row, toolbar, a 64 px header over 24 px rows and the tray, in the same geometry as the loaded grid (no layout shift). Week navigation afterwards keeps the old grid while loading (no skeleton flash).

**Probe further:** any console warning during load (`act`, hydration, keys). Time to interactive > 3 s is PERF.
