# 02-c · Picking: hover ghost, whole sessions, the tray, the context row and the month view

**Needs:** HM-15 (G-SUB, G-REQ), F-BUSY. Preview OK once the fixtures exist.
**Personas:** H1 (IST), B3 (America/Los_Angeles), B1 (IST).
**Docs under test:** `docs/calendar/allocate-heatmap-ux.md` §4–8, `lib/scheduling/week-grid-model.ts` (`expandToSession`), `lib/scheduling/calendarUtils.ts` (`splitIntoSessions`), `components/scheduling/SessionTray.tsx`, `components/scheduling/SchedulingContextBar.tsx`.

Use G-SUB's allocate page (60-min sessions, 3 a week, 1 a day) and G-REQ's (90-min consultation, one session) at 1440×900 unless stated. Never click **Save picked times** or **Auto-schedule** in this file; leave with **Cancel**.

## HM-31 — Hover ghost covers exactly what a click will pick

**Why it matters:** the preview must equal the result, or users place sessions they didn't mean.

**Steps:**

1. G-SUB, Mon D: hover 09:00. Read the ghost label.
2. Hover 12:00 (the last 60-min start before the 13:00 gap). Then 12:30.
3. Click 12:00. Read the tray. Click it again to remove.
4. G-REQ (90 min), Thu D+3: hover 11:30, then 12:00.

**Expect:**

- 1: a dashed ghost over 09:00–10:00 labelled "New session · 9:00 am–10:00 am".
- 2: 12:00 → ghost 12:00–13:00. 12:30 → the ghost grows **backward** (12:00–13:00) because forward hits the closed gap; label shows 12:00 am/pm–1:00 pm. Record exactly what it does.
- 3: the click selects exactly the ghost's atoms (tray "Session 1 · Mon <date> · 12:00 pm–1:00 pm"); clicking again removes it.
- 4: 11:30 → 11:30–13:00 fits; 12:00 → backward to 11:30–13:00 or red "Doesn't fit here" (record).
- Keyboard focus resting on a cell shows the same ghost (Tab into the grid, arrow to 09:00).

**Probe further:** hover a free cell squeezed between two busy blocks with less than a session free (create none; use the 30-min gap if any exists after HM-27). The ghost must turn red "Doesn't fit here" and a click must toast "Not enough consecutive slots" / "Each session requires 1 hours (2 consecutive slots). Only 1 available here." Report the grammar ("1 hours") and the "slots" wording as COPY.

## HM-32 — Click anywhere in a picked session removes that whole session only

**Why it matters:** half-removing a session leaves an unbookable fragment.

**Steps:**

1. G-SUB: pick Mon D 09:00 and Wed D+2 17:00. Read the tray.
2. Click the **second half** (09:30 cell) of the Monday session.
3. Re-pick Monday; then remove the Wednesday session with its tray ✕ ("Remove session 2, …").
4. Try to pick a second session on Mon D (10:00).

**Expect:**

- 2: only the Monday session is removed (both of its cells); Wednesday stays.
- 3: ✕ removes only Wednesday.
- 4: refused by the one-a-day cap: the cells already paint Limit reached, or a "One session per day" toast ("You can only schedule one session per day. Please choose a different day."). If the grid accepts two picks on one day for a subscription, FAIL (P1, the server will refuse the save).
- Two back-to-back picks staying two sessions (not one merged pick) needs a grid that allows two a day: check it on a class's calendar view in 06-classes (cap 2 a day) and reference that case here.

**Probe further:** the same removal across midnight: if a 60-min session can start at 23:30 on some grid (H3's overnight row from HM-01), the ghost draws one piece per day column and the tray lists one session; clicking either piece removes both. Run it only if HM-01's row is present.

## HM-33 — The tray: progress, numbered picks, placeholder, live region

**Why it matters:** the tray is the one place the host sees what will be saved.

**Steps (G-SUB):**

1. Before picking: read the tray heading, meters and placeholder.
2. Pick Mon D 09:00, Wed D+2 09:00, Fri D+4 09:00 in that order.
3. Read the heading after each pick; `take_snapshot` the sr-only `role="status"` region.
4. Click the heading ("Go to selection") after scrolling the grid away.

**Expect:**

- 1: heading like "Choose times for 3 sessions (1 hour each)" or "0 of 3 picked for this cycle · …" (quote it); a dashed "Session 1 · choose a free time on the grid".
- 2: numbered picks "Session 1 · Mon <d> · 9:00 am–10:00 am", 2, 3, each with a remove button; the placeholder disappears at 3 of 3.
- 3: the live text reads "1 of 3 times picked", "2 of 3 times picked", "3 of 3 times picked".
- 4: the grid scrolls to the picks.
- Actions: **Cancel**, **Auto-schedule this week** (subscription; plain "Auto-schedule" for a consultation), **Save picked times** sticky at the bottom.

**Probe further:** the dates in tray labels: `Mon 9 Nov` vs `Mon, Nov 9`: consistent with the rest of the app? Is "Save picked times" disabled with a reason (`title`) when nothing is picked ("Pick the times first.")? Quote the disabled reason in each state: 0 picks, 2 of 3, 4 of 3 (if the grid lets you).

## HM-34 — Tray meters: This week, Plan total, Per day

**Why it matters:** the meters are how the host learns the plan's limits without reading docs.

**Steps:** G-SUB with 0, then 3 picks in plan week 1. Read the meters. Navigate to plan week 2.

**Expect:**

- "This week" = `quotaFooterText`: "Week 1 of 4 · 0 of 3 booked" (picks may or may not count; record). After the week is full, "Week 1 of 4 is set · next opens <Mon D+7>".
- "Plan total" "0 of 12 placed" → "3 of 12 placed" with picks.
- "Per day" "At most 1 session".

**Cross-check:** the context-row chip "Week 1 of 4" agrees with the meter.

**Probe further:** the months plan (S-12) if a buyer exists in 04: does the chip read "Month 1 of 2"? The PR says monthly pacing is gone and "Week N of W" is the only counter; a "Month" label is a FAIL against the decision record.

## HM-35 — Tray warnings: short weeks (and none when every week fits)

**Why it matters:** the host must hear that coming weeks can't hold the plan before sessions go unplaced and get refunded.

**Steps:**

1. G-SUB allocate: read the amber warnings list in the tray. With F-AV1 and only F-BUSY booked, expect none.
2. If 04-subscriptions has left a subscription whose coming weeks are short (for example on H2, whose hours hold only 5 one-hour sessions a week), open its allocate page and read the warnings. Otherwise mark this step BLOCKED and point to 04.

**Expect:**

- 1: no warning (every week fits).
- 2: "N of the next 8 weeks can't fit 3 sessions around your other bookings. Open more hours, or sessions that never get a time are refunded to the client when the plan ends." (quote the real N and week count; the helper says "next ${weeks.length} weeks").

**Probe further:** is the warning dismissable? Should it link to the availability page (MISSED-OPPORTUNITY if not)?

## HM-36 — The context row

**Why it matters:** one row of facts replaces stacked banners; each fact must be true.

**Steps:** read the chip row above the grid on G-SUB allocate, G-REQ allocate, F-BUSY consultee reschedule (B3), F-BUSY manage timings (H1).

**Expect:**

- G-SUB: "Plan · 3 a week · 1 hour each", "Week · 1 of 4", "Plan ends · <D+27>", a window chip ("This cycle" or "Scheduling period" with the range), "Earliest start · <now + 15 min>", then the zone line.
- G-REQ: "Session · 1 hour 30 min" (or "90 min"), "Requested window · <range>", "Earliest start · <now + 2 h>".
- F-BUSY reschedule: the notice chip "not within 24 h of the start · not refunded" (title "Sessions cannot be moved within 24 hours of their start time, and rescheduling is not refunded."), "Earliest start · <now + 24 h>".
- No stacked blue, amber or lead banners. A refresh failure shows a compact inline alert with "Try again" under the row.

**Probe further:** compute each chip's value from the DB (plan end from `planEndsAt` minus one instant; earliest start from now) and report any off-by-one day. "Plan ends Sat" when the plan ends at 00:00 Sun IST is right (last instant before); "Plan ends Sun" is wrong.

## HM-37 — Month view and "N fit"

**Why it matters:** the month view is how a host picks a lighter day; the count must be session-aware and in the grid zone.

**Steps:**

1. G-SUB allocate → **Month**. Read "N fit" on Mon D, Tue D+1 (F-BUSY day), Sat D+5, Sun D+6.
2. Switch back to **Week**; read the week header's "N fit" for the same days.
3. G-REQ allocate (90 min) → Month: Mon D, Tue D+1.
4. As B3 (Los Angeles) open F-BUSY's reschedule grid → Month. Read Tue D+1 and Mon D.

**Expect:**

- G-SUB 60 min: Mon D "8 fit" (4 in 09:00–13:00 + 4 in 17:00–21:00) minus Too soon cells if D is today; Tue D+1 "7 fit" (F-BUSY takes 18:00–19:00; 17:00–18:00 and 19:00–21:00 still hold 1 + 2); Sat "4 fit"; Sun "None fit". Labels use "1 fits" / "N fit" / "None fit".
- The count ignores the plan's 1-a-day cap (the tray states that separately).
- G-REQ 90 min: Mon D "4 fit" (two in each 4-hour window); Tue D+1 "3 fit" (2 in the morning, 17:00–18:00 holds none, 19:00–21:00 holds 1).
- Week header and month view agree for every day.
- B3: days are bucketed by Los Angeles calendar day. IST 09:00–13:00 Monday is Sunday 19:30–23:30 PST, so part of Monday's IST hours count on **Sunday** in B3's month view. Weeks start on Sunday (or the subscription's cycle weekday for G-SUB); leading blanks match the real first weekday of the month.

**Probe further:** for B3's grid only reschedule-window days should count (others are Outside period/Too soon). Do Outside period days say "None fit" or nothing? Month view in Kathmandu (H4) if HM-29 exists.

## HM-38 — Week navigation and the booking's window

**Why it matters:** a host can page anywhere, but cells outside the booking's window must explain themselves.

**Steps:**

1. G-SUB allocate: press **Previous week** until before D, then **Next week** until after `planEndsAt`.
2. Click **Today** from a far week; read its disabled state on the current week.
3. F-BUSY consultee reschedule (B3): page forward 8 weeks.

**Expect:**

- Arrows never disable (record if they do); weeks before D paint Outside period, weeks after the plan end paint Limit reached or Outside period with the empty-week note from HM-17.
- "Today" (title "Jump to today") returns to the current week and is disabled while on it.
- F-BUSY reschedule: cells beyond the reschedule window paint Outside period; record the last bookable day and compare with the consultation horizon (the auto search walks 8 weeks for a consultation).

**Probe further:** MISSED-OPPORTUNITY if the host can page 20 weeks into nothing with no hint where the plan ends; the "Plan ends" chip may be enough. Judge it.

## HM-39 — Clear selection, Cancel and leaving with picks

**Why it matters:** picks are local; leaving must not save, and the user should know.

**Steps:** G-SUB: pick two sessions. Click **Clear selection**. Pick one again and click **Cancel**. Return to the page.

**Expect:** Clear selection removes all picks (disabled when none). Cancel leaves without a PATCH (network panel). On return, no picks remain; the request is still unallocated (R-03).

**Probe further:** does the page warn before leaving with unsaved picks (browser back, nav link)? Note as MISSED-OPPORTUNITY if not; don't call it a bug.

## HM-40 — Freshness label and refresh failure

**Why it matters:** the grid polls about once a minute; the user must know when it's stale and that saving re-checks.

**Steps:**

1. Leave G-SUB allocate open for 3 minutes; read the tray status line.
2. Throttle the network to offline (`emulate` offline) for 3+ minutes; read the status and any inline alert. Go back online.

**Expect:**

- 1: either no label or a freshness label with title "This calendar refreshes about once a minute. Times are re-checked when you save them, so an old view can cost a click but cannot double-book."
- 2: a red label with title "The background refresh is failing. The times shown are the last ones that loaded — reload or try again in a moment." and/or the compact alert with **Try again**; polling backs off and recovers when online; no console error storm (count the failed requests).

**Probe further:** 304 responses on unchanged polls (ETag). Are polls paused when the tab is hidden?

## HM-41 — "Any time works" and preferences on the reschedule surfaces

**Why it matters:** a release without times is a real, separate path (preference-only proposal); the grid must make the choice explicit.

**Steps:** as B3 open F-BUSY's reschedule page. Read the footer and the preference controls. Toggle "Any time works". Don't submit.

**Expect:** footer with Cancel, "Any time works" and the submit button ("Request this time"); with "Any time works" on, the grid's picks are disabled or ignored and preference controls appear ("Preferred time of day", "Preferred days", "Any time, but ideally these"). Submit stays disabled with a reason until a valid choice exists ("Pick at least one new time first." / "Choose which sessions are moving, or choose Any time works.").

**Probe further:** what happens to the picks already made when "Any time works" is ticked? The outcome of submitting belongs to 03 (CO reschedule cases).
