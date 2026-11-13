# 02-d · Every surface, keyboard use and four viewports

**Needs:** HM-15 (G-SUB, G-REQ), F-BUSY, HM-29's H4 booking (optional). HM-46 needs an outage remedy (seeded; owner approval).
**Personas:** H1 (IST), B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles).
**Docs under test:** `docs/calendar/allocate-heatmap-ux.md`, `.claude/skills/booking/references/availability.md` §7–9, `components/scheduling/time-picker-policy.ts`, `docs/booking/22-explore-booking-dialog.md`.

Each grid page sets a policy: submit label, hint line, lead time and mode. Read the hint verbatim on each surface; it's the user's only explanation of what a click does. Don't submit on any surface in this file.

| Surface | Route | Submit label | Hint (from `time-picker-policy.ts`) | Lead |
| --- | --- | --- | --- | --- |
| Allocate | `/dashboard/consultant/[cid]/requests/[rid]/allocate` | "Save times" (grid tray: "Save picked times") | "Choose the times for this booking. Green is free for both of you; anything else is already taken." | 15 min settled, 2 h unpaid |
| Consultee reschedule | `/dashboard/consultee/[uid]/appointments/[aid]/reschedule` | "Request this time" | "Green means your consultant is free — choosing one of those confirms straight away. Anything else is sent to them to approve." | 24 h |
| Consultant reschedule | `/dashboard/consultant/[cid]/appointments/[aid]/reschedule` | "Propose this time" | "Green means you are free. Whatever you propose is sent to the consultee to accept." | 24 h |
| Manage timings | `/dashboard/consultant/[cid]/appointments/[aid]/timings` | "Save timings" | "Choose when this runs. Green is free on your calendar; anything else is already taken." | 15 min |
| Free rebook (outage) | `/dashboard/consultee/[uid]/appointments/[aid]/rebook` | "Rebook free" | "Green means your expert is free. Choosing a time confirms it straight away, at no charge." | 15 min |

## HM-42 — Allocate surface (desktop) end to end, without saving

**Why it matters:** the host's main scheduling screen; everything in 02-b/02-c meets here.

**Steps:** as H1 open G-SUB's allocate page from Requests (click through, don't type the URL). Read the page title, hint, context row, tray, toolbar. Then open G-REQ's allocate page the same way.

**Expect:**

- Hint verbatim as in the table. The word "Green" must match a visible green (Free is emerald-100: judge whether "green" is fair).
- G-REQ shows the "Requested" outline over Thu D+3 10:00–11:30 and the requested window chip; G-SUB shows quota meters. Both show Cancel / Auto-schedule(-this-week) / Save picked times.
- No console errors; one availability GET per poll, not per hover.

**Probe further:** "Green is free for both of you": does the allocate grid actually account for the client's other bookings (it shows the consultee busy only on some surfaces)? Check whether B1's own other bookings appear on G-SUB's grid. If not, the hint is FALSE-INFO (P2).

## HM-43 — Consultee reschedule surface: grid on desktop, day list on a phone

**Why it matters:** buyers move bookings on phones; the day list must clamp to the same window and paint the same states.

**Steps:**

1. As B3 at 1440×900 open F-BUSY's reschedule page. Read hint, footer, legend (buyer legend: four states).
2. `resize_page` 390×844. Reload. Read the day chips and the time list.
3. Tap a day with no free times, then a day with free times. Pick one time; then tap the same day again for a second time.

**Expect:**

- Desktop: grid in select mode; legend explains four states (Free, Booked, Too soon, Unavailable or similar: list them).
- Phone: `MobileDayListPicker`: 14 day chips over the reschedule window ("<first> – <last>" header); first bookable day at least 24 h ahead; "Times on <day>"; empty day "No free times on this day. Pick another day."; empty fortnight "No free times in these two weeks. Try the next two weeks."
- A second pick on the same day is refused ("You already picked a time on this day" / "Overlaps a time you picked").
- Times in Los Angeles time on both.

**Probe further:** the hint says green "confirms straight away". On the day list there is no green; does the copy still make sense? Day-chip accessible names ("<day>, no free times" / "N times"). Arrow keys move between day chips.

## HM-44 — Consultant reschedule surface

**Why it matters:** the host proposes; the copy must not promise an instant move.

**Steps:** as H1 open F-BUSY's consultant reschedule page at 1440×900. Read hint, footer and the "Being moved"/"This booking" painting. At 390×844, read what replaces the grid.

**Expect:** hint "Green means you are free. Whatever you propose is sent to the consultee to accept."; submit "Propose this time"; 24 h lead; "Any time works" offered. On a phone either the day list or the desktop notice (record which; consultant reschedule isn't named in the desktop-only list).

**Probe further:** does the host's grid show B3's other commitments (consultee busy)? The trial picker does (`consulteeUserId` in the fetch); check whether this one passes it (network panel).

## HM-45 — Manage timings surface

**Why it matters:** the host re-plans an unsold or 1:1 booking here; for sold group events it must refuse (05/06 own that).

**Steps:** as H1 open F-BUSY's Manage timings at 1440×900 and 1024×768 and 390×844.

**Expect:** hint "Choose when this runs. Green is free on your calendar; anything else is already taken."; "This booking" block on Tue D+1 18:00; submit "Save timings". At 390×844 the desktop-only notice: "Please access this on desktop for now" / "Choosing times needs a wider screen than this one. Everything else in your dashboard works here."

**Probe further:** what does saving a new time here do to B3: move instantly, or a proposal? The page should say. 03 tests the outcome.

## HM-46 — Free rebook surface (outage-voided session)

**Why it matters:** the only grid a buyer uses to place a free session; it exists only for an outage remedy. (The PR prompt's "rebook a completed consultation" is not what this page does: report as DOC-DRIFT.)

**Setup:** find an open remedy: `SELECT r.id, r."userId", o."appointmentId", r."dueAt" FROM "IncidentRemedy" r JOIN "AppointmentOccurrence" o ON o.id = r."occurrenceId" WHERE r.kind = 'REFUND_AT_DUE' AND r."doneAt" IS NULL AND r."dueAt" > now();`. If none belongs to a persona, ask the owner whether to seed one (`PlatformIncident` + `IncidentRemedy` on a voided QA occurrence); otherwise BLOCKED.

**Steps:**

1. As B3 (or the remedy's owner) open `/dashboard/consultee/[uid]/appointments/[aid]/rebook` for an appointment with **no** remedy (F-BUSY).
2. With a remedy: open its rebook page at 1440×900 and 390×844.

**Expect:**

- 1: "There is nothing to rebook here" / "This session was already rebooked or refunded, or its refund is now on its way." with "Back to the booking".
- 2: the expert's grid at the voided session's length, hint "Green means your expert is free. Choosing a time confirms it straight away, at no charge.", submit "Rebook free", 15-min lead, horizon 30 days.

**Probe further:** the page title is "Rebook free — Familiarise"; does the page say when the automatic refund happens if the learner does nothing (`dueAt`)? MISSED-OPPORTUNITY if not.

## HM-47 — Expert page booking dialog (the dark single-time picker)

**Why it matters:** the buyer's first contact with availability; it reads the same endpoint as the grid.

**Steps:**

1. As B2 (Europe/London) open `/explore/experts/[H1 cid]` → S-08 → **Book Now**. Read the month grid (day marks, the **Today** control), the times pane heading and the times for Tue D+1.
2. Pick a past day, a Sunday, Tue D+1. With the keyboard, Tab into the month and use the arrows, Home/End and Page Up/Page Down.
3. As H1 switch to "Review requests first"; reload B2's dialog. Read the button and the sentence under it. Switch H1 back.
4. Open the second plan card's **Book Now** (a plan of another length) and confirm the dialog title names that plan.

**Expect:**

- Month: past days disabled; Sunday unmarked but selectable, showing "No free times on this day" and a "Next free: <date>" button; days with a free time carry a dot and ring; today has a dashed ring. Arrow keys move one day or week, Page Down moves a month.
- Times pane: headed with the date and "Times in Europe/London"; times grouped Morning/Afternoon/Evening; F-BUSY's time missing from the free times, and a button "Show 1 taken time" (`aria-expanded="false"`; past and too-soon times are not counted); opening it lists F-BUSY's time greyed with **Notify me** and the line "You can wait on up to 3 times."; 18:00 IST reads 12:30 pm.
- REQUEST mode: the button reads "Request this time" and the sentence says "the expert confirms before you pay". INSTANT: "Continue to Checkout", no sentence.
- Every time button announces its range and state (inspect the `aria-label`), and the selected one has `aria-pressed="true"` and a check.

**Probe further:** pick a time, wait past the 15-min lead boundary: the pick clears and the pane says "That time was just taken — pick another." On an INSTANT expert, `POST /api/scheduling/request-for-approval` by hand answers 409 `REQUEST_NOT_OFFERED`.

## HM-48 — Keyboard navigation and screen-reader cues on the week grid

**Why it matters:** the grid must be fully usable without a mouse.

**Steps (G-SUB allocate, 1440×900):**

1. Tab from the page top into the grid. Note how many Tab stops it takes and where focus lands (the roving focus target).
2. ArrowRight / ArrowLeft / ArrowDown / ArrowUp; Home / End; Ctrl+Home / Ctrl+End.
3. PageDown then PageUp.
4. Enter on a free cell; Space on a picked cell.
5. Tab out of the grid to the tray.

**Expect:**

- One Tab stop for the whole grid (roving tabindex); a visible focus ring.
- Arrows move one cell; Home/End go to the first/last day of the same row; Ctrl+Home/Ctrl+End go to the top-left and bottom-right drawn cell (clamped to the Open hours rows).
- PageDown/PageUp change week and keep focus at the same row/day.
- The focus ghost appears on a free cell (same as hover).
- Enter picks the session; Space on a picked cell removes the whole session. The live region announces "1 of 3 times picked" and back.
- Each focused cell's accessible name includes the state and the date/time ("Free, Monday 9 November, 9:00 am" or similar; quote it).

**Probe further:** keyboard trap: can you leave the grid with Tab and Shift+Tab? Focus after a toast: does it stay on the grid? Arrow into a hidden (Open hours-cropped) row: clamped or skipped? A11Y findings go to the report; the full sweep is 13.

## HM-49 — Four viewports: readability and layout

**Why it matters:** the grid's 24 px rows, 11 px text and the tray's docking change with width.

**Steps:** G-SUB allocate and F-BUSY consultee reschedule at 1440×900, 1280×720, 1024×768, 390×844. Screenshot each.

**Expect:**

- 1440 and 1280: tray docked right (from 1280 px); grid keeps its height.
- 1024: tray docked under the grid; grid lines and labels still readable; no horizontal scroll inside the grid beyond the 7 day columns.
- 390: allocate shows the desktop notice and **Auto-schedule this week** with "We pick free times in your published hours and tell your client." (the doc calls this "Auto-schedule in my open hours": DOC-DRIFT); consultee reschedule shows the day list.
- Text never below 11 px; dashed half-hour rules visible at every width; block labels not clipped mid-word in 60-min blocks.

**Probe further:** zoom to 200 % at 1280: does the grid stay usable or overflow? Dark mode, if the app has one: hatch contrast.

## HM-50 — Buyer legend and the consultee's own busy times

**Why it matters:** a buyer should see only what helps them pick, and never a time that clashes with their own bookings.

**Steps:** as B3 on F-BUSY's reschedule grid, read the legend. Then, if B3 holds another booking with any host in the window, find its time on this grid.

**Expect:** a buyer legend of four states (`BUYER_LEGEND_KEYS`), no "Being moved"/"Limit reached" jargon unless painted. B3's other booking's time: painted busy or not offered (record which). Offering B3 a time when B3 is already booked elsewhere is a MISSED-OPPORTUNITY at least.

## HM-51 — Console and network hygiene on every grid page

**Why it matters:** grid pages are heavy; warnings here usually precede real bugs.

**Steps:** for each surface in the table (and the expert dialog), `list_console_messages` after load, after a week change, after a pick, after a month view switch; `list_network_requests` for duplicate GETs.

**Expect:** no React key warnings, no `act(...)` warnings, no hydration mismatches, no 4xx/5xx. Availability polls at most once a minute while visible, paused while hidden; 304 on unchanged polls.

**Probe further:** count requests on hover (must be zero network calls per hover).

## HM-52 — Browser zone ≠ profile zone on every grid

**Why it matters:** the grid must render in the profile zone everywhere; one surface following the browser shows wrong times.

**Steps:** `emulate` the browser zone to `Pacific/Auckland`. As H1 (profile IST) open G-SUB allocate, F-BUSY manage timings, F-BUSY consultant reschedule; as B3 (profile Los Angeles) open F-BUSY consultee reschedule. Read F-BUSY's block time on each. Reset emulation.

**Expect:** H1's surfaces show 18:00 (IST); B3's shows 04:30 (PST). The zone switch offers "Use my device's time zone" (Auckland) on each. Any surface showing Auckland time by default is a FAIL (P1, false time).

**Probe further:** the month view and the tray labels on the same pages. Full zone sweep is 10.
