# 02-a · Availability editing: edge cases

**Needs:** 01 (F-AV1, F-AV3, F-AV4, F-BUSY). Preview OK except HM-12 (`[local]`, needs a live booking on the host it edits; F-BUSY on H1 does it).
**Personas:** H3 (America/New_York) for weekly edits, H4 (Asia/Kathmandu, custom) for custom edits, H1 (IST) for HM-11/HM-12 only, B1 (IST) to read the result.
**Docs under test:** `.claude/skills/booking/references/availability.md` §1–3, `lib/scheduling/availability-contract.ts`, `utils/scheduling-engine/interval-validation.ts`, `utils/scheduling-engine/mergeAdjacentWeeklyRows.ts`.

Rules for this file:

- **Restore after every case.** H3 ends each case with exactly F-AV3 (Mon–Fri 09:00–17:00 New York); H4 with its S-05 custom rows; H1 with F-AV1. Run R-02 at the end of each case and paste it.
- The availability page saves the whole form with `PUT /api/user/consultants/[cid]`. The per-row routes (`POST /api/scheduling/availability/weekly`, `…/custom`, `…/weekly/[id]`, `…/custom/[id]`) are what the API cases call from `evaluate_script`.
- The editor validates on every keystroke and marks a bad row red with an inline message. It also **snaps** a typed time forward onto the UTC half-hour (both ends by the same amount) before validating. In IST and New York every :00/:30 is already on the grid; :15/:45 typed values move.
- Check the buyer side after each saved change: as B1 open `/explore/experts/[cid]` → Book Now on the affected day.

## HM-01 — An overnight weekly window (Fri 22:00 → Sat 02:00)

**Why it matters:** windows that cross midnight are legal; a broken tail loses sellable hours or sells hours that aren't published.

**Setup:** H3 on F-AV3.

**Steps:**

1. As H3 open the availability page. On Friday add a row and type 22:00 to 02:00.
2. Read the inline state and the validation summary under the editor (it counts "overnight" slots).
3. Save. Reload.
4. As B1 (IST) open H3's expert page → Book Now on Friday and Saturday (choose S-08-like plan if H3 has none: create a 60-min priced consultation "qa-HM-01" first and archive it at the end).

**Expect:**

- UI: the row is valid (no red); the summary reads "… 1 overnight …" and "Ready to proceed". Toast "Settings updated".
- DB (R-02): one new row with `localStartDay = 'FRIDAY'`, `localStartMinutes = 1320`, `localEndDay = 'SATURDAY'`, `localEndMinutes = 120`, `timezone = 'America/New_York'`. The UTC columns: `startDay`/`endDay` reflect 03:00Z/07:00Z Saturday at EST (the probe date's offset).
- Rows don't merge: the overnight row never coalesces with Friday 09:00–17:00 (different span) and the merge rule never merges rows that cross local midnight.
- Buyer: H3's Friday 22:00 EST = Sat 08:30 IST. B1 sees starts from Sat 08:30 to Sat 11:30 IST (four 60-min starts: 22:00, 22:30 … 01:00 EST). Write the full list B1 sees.

**Cross-check:** open any H3 grid that shows that week (manage timings of an H3 booking if one exists, or skip). The tail after midnight must be bookable on Saturday's column.

**Probe further:** type 22:00 to 00:00 (ends exactly at midnight). Is it shown as overnight or as same-day? R-02 `localEndMinutes = 0` and `localEndDay = 'SATURDAY'` is the salvaged old-005 boundary case ("slot ending at endTimeUtc = 0"); report what's stored. Restore F-AV3.

## HM-02 — Overnight tail overlapping the next day's first window

**Why it matters:** the tail of Friday's overnight row belongs to Saturday; a Saturday row inside it double-publishes the same hours.

**Setup:** H3 on F-AV3.

**Steps:**

1. Friday: 22:00–02:00. Saturday: 01:00–03:00.
2. Read both rows' inline state. Click Save.
3. Change Saturday to 02:00–03:00. Save.

**Expect:**

- Step 2: Save shows "Validation Error" with "Please fix the following issues:" and a line like "friday slot 2: Overnight tail overlaps with saturday slot starting at 01:00". Nothing saved (R-02 unchanged). Quote the exact line; the lowercase day keys are a COPY finding (P3).
- Step 3: saves. Saturday 02:00–03:00 is exactly adjacent to the tail but on the next local day after a midnight-crossing row: it must **not** coalesce (merge never touches a row that crosses midnight). R-02: two rows.

**Probe further:** salvaged clauses from old 005 (per-row API). From `evaluate_script` as H3, POST to `/api/scheduling/availability/weekly` with UTC minutes: (a) an overnight row whose `endDay` is two days later → 400 (`ORDER`, "Invalid …"); (b) `startDay ≠ endDay` with `startTimeUtc <= endTimeUtc` → 400; (c) a same-day row overlapping the overnight tail → 409 "This slot (…) overlaps with an existing slot". Record each status and message. Restore F-AV3.

## HM-03 — Overlapping, zero-length and over-long windows

**Why it matters:** the three shapes the contract refuses; each must stop at the editor with words a person understands.

**Setup:** H3 on F-AV3.

**Steps (one at a time, Monday):**

1. Add 10:00–12:00 (inside 09:00–17:00).
2. Add 13:00–13:00.
3. Add 06:00–19:00 (13 h).
4. Add 08:00–08:15.
5. For each, also try Save.

**Expect:**

- Inline messages: 1 "Slots cannot overlap"; 2 "Start and end time cannot be the same"; 3 "Session cannot exceed 12 hours"; 4 "Session duration must be in multiples of 30 minutes" (08:15 is a 15-min step the picker allows).
- Save on each: "Validation Error" toast; no PUT, or a PUT refused with 400 and code `OVERLAP` / `DURATION` / `GRID`. DB unchanged.

**Probe further:** the editor calls a window a "Session" in two messages. Report as COPY. Try exactly 12:00 h (06:00–18:00): it must save (the bound is inclusive), then restore.

## HM-04 — Exactly adjacent weekly rows coalesce (and change id)

**Why it matters:** salvaged from old 011 Phase 6. Folding adjacent rows keeps the published set minimal; weekly ids change by design, custom ids don't (HM-07).

**Setup:** H3 on F-AV3. Note Monday's row id.

**Steps:**

1. Monday: add 17:00–19:00 (adjacent to 09:00–17:00). Save.
2. R-02.
3. Reload the editor.
4. Restore: change Monday back to 09:00–17:00 only. Save.

**Expect:**

- Step 2: one Monday row 09:00–19:00 (local 540–1140) with a **new** id; the other weekdays' ids also changed (the fold deletes and recreates every weekly row).
- Step 3: the editor shows one row 09:00–19:00, not two.
- The merge stops at 12 h: try Monday 09:00–17:00 plus 17:00–22:00 (13 h if merged). Expect two rows, not one 13-hour row (which would be refused and vanish from the form).

**Probe further:** does the editor tell H3 that two rows became one? A silent merge that changes what the consultant typed is a MISSED-OPPORTUNITY only if it confuses: judge it.

## HM-05 — Removing every weekly row is refused

**Why it matters:** an empty weekly set publishes nothing while the profile still sells.

**Steps:** as H3 delete all five rows (trash icons) and Save.

**Expect:** 400 with code `EMPTY` and "Add at least one weekly availability window", shown in the error toast. DB unchanged. If the save succeeds, FAIL (P1) and restore F-AV3.

**Probe further:** what should a consultant do who wants a week off? There's no blackout feature (custom rows are additive). Record whether the UI suggests "Turn off Taking new 1:1 bookings" (Settings → Booking) instead. MISSED-OPPORTUNITY if nothing points there.

## HM-06 — Custom schedule: multi-date rows, removing a date, past dates

**Why it matters:** custom mode is the only path for H4 (Kathmandu) and for consultants with irregular dates; "blocking a day" means removing its row.

**Setup:** H4 on its S-05 custom rows (D…D+5, 10:15–12:15 NPT).

**Steps:**

1. As H4, in "Custom Schedule", click D+1 in the month calendar to deselect it. Save.
2. As B1 open H4's expert page → Book Now: D+1.
3. Re-add D+1 10:15–12:15. Add yesterday's date (go back a month if needed) with 10:15–12:15. Save.
4. Add D+6 with 10:15–12:15 and 12:15–14:15 (adjacent). Save. R-02 on `AvailabilityWindowCustom`.

**Expect:**

- Step 1: the D+1 row is hard-deleted. B1 sees D+1 as "No available slots for the selected date" (the day cell not ringed).
- Step 3: yesterday's row is refused: 400 `PAST` "Window N has already ended" (or the calendar won't let you pick a past date; record which). Nothing saved from this save if it was refused as a whole; say so.
- Step 4: one custom row 04:30Z–08:30Z on D+6 (adjacent custom rows fold, keeping the **first** row's id).

**Probe further:** the month calendar header is Su–Sa while weekly rows read Mon–Sun. Note any confusion. Is there a way to copy a day's hours to other dates? (MISSED-OPPORTUNITY if 40 dates need 40 manual entries.) Restore S-05 rows.

## HM-07 — Custom rows via the per-row API: adjacency folds with a stable id, overlap is refused

**Why it matters:** salvaged from old 011 Phase 6 and old 005 Phase 7. A booking names a custom row; recreating rows would orphan in-flight checkouts.

**Setup:** H4 custom rows from S-05.

**Steps (as H4, `evaluate_script`):**

1. POST `/api/scheduling/availability/custom` with `{ consultantProfileId: H4, startsAt: "<D+8>T04:30:00Z", endsAt: "<D+8>T06:30:00Z" }`. Keep `data.id` as A.
2. POST the adjacent `06:30Z`–`08:30Z` on D+8.
3. POST an overlapping `05:30Z`–`07:30Z` on D+8.
4. POST an off-grid `04:45Z`–`06:45Z` on D+9.
5. DELETE `/api/scheduling/availability/custom/[A]`.

**Expect:**

- 1: 201. 2: 201 and `data` is the folded 04:30Z–08:30Z row with id **A**. SQL: one row on D+8.
- 3: 409 "This slot overlaps with an existing slot".
- 4: 400 `GRID` (custom rows must sit on the UTC half hour).
- 5: 2xx; no D+8 rows left.

**Probe further:** POST a 25-hour custom row (D+10 04:30Z → D+11 05:30Z): refused as `DURATION` (12 h max). Does the grid route still draw rows longer than 24 h if they exist from older data? (The doc says it keeps them.)

## HM-08 — Switching weekly ↔ custom is locked while appointments are active

**Why it matters:** switching modes would orphan live bookings from the hours that sold them.

**Setup:** H1 has F-BUSY (an active appointment).

**Steps:**

1. As H1 open the availability page. Try to select "Custom Schedule".
2. Read the alert.
3. From `evaluate_script` PUT the form with `scheduleType: "CUSTOM"` (copy the last PUT body from the network panel and change only `scheduleType` and the two slot arrays).

**Expect:**

- UI: the radio won't switch; a destructive alert "Schedule Type Locked" with "You have active appointments that prevent schedule type changes. Please complete or cancel all pending appointments before switching schedule types." (or the server's reason). `GET /api/user/consultants/[cid]/can-switch-schedule` explains why.
- API: 400 with code `SCHEDULE_SWITCH_BLOCKED`. DB `scheduleType` still `WEEKLY`.

**Probe further:** does the alert say *which* appointments block the switch, or link to them? MISSED-OPPORTUNITY if not. Dormant-mode rows: H1 may have old custom rows; they must not appear on B1's expert page (readers gate on `scheduleType`).

## HM-09 — Profile zone change: "Convert" re-anchors, "Keep" leaves the hours where they were

**Why it matters:** a consultant who moves (or fixes a wrong zone) must not silently shift every published hour.

**Setup:** H3 on F-AV3 in America/New_York.

**Steps:**

1. As H3, Settings → Account → Timezone "Europe/London". Save. In the dialog "Convert my weekly hours to Europe/London?" click **Keep in America/New_York**.
2. Open the availability page. Read the zone line and alerts.
3. As B1 read H3's Monday times.
4. Settings → Account → Timezone "America/New_York" again (no dialog expected if rows already match) then → "Europe/London" and click **Convert**.
5. Read the toast, R-02, B1's view.
6. Restore: zone "America/New_York" + Convert. R-02 must equal F-AV3.

**Expect:**

- Step 2: "Times are in America/New_York and follow daylight saving automatically." plus the alert "Weekly hours kept in America/New_York" / "Your profile timezone is Europe/London, but your weekly hours stay in America/New_York. Learners are offered them at those clock times in America/New_York."
- Step 3: unchanged (Mon 09:00 EST = 19:30 IST).
- Step 5: toast "Weekly hours now in Europe/London"; `POST /api/scheduling/availability/weekly/zone` → 200 `converted: 5`. R-02: `timezone = 'Europe/London'`, `localStartMinutes = 540` (still 09:00 local), so the instants moved: B1 now sees Mon 09:00 GMT = 14:30 IST.
- Step 6: back to F-AV3.

**Cross-check:** H3's grid and expert page agree with R-02 at each step.

**Probe further:** converting while a booking sits outside the new hours: the toast should add "N upcoming sessions now fall outside your published hours — they keep their time; reschedule or cancel from Appointments if needed." Try it only with a booking you own. Calling the zone route with a zone that isn't the profile zone must answer 409 `ZONE_NOT_PROFILE_ZONE` ("Save this timezone on your profile before converting to it").

## HM-10 — Typed :15/:45 values snap forward in IST (and what the consultant is told)

**Why it matters:** the time input steps by 15 minutes, but only UTC :00/:30 can be sold. A silent shift changes what the consultant published.

**Setup:** H1 on F-AV1 (IST). You add one Saturday row after the 10:00–14:00 row and remove it at the end.

**Steps:**

1. Type 15:15 in start and 16:15 in end. Watch the inputs.
2. Save, then R-02.
3. Delete the row and save (restore F-AV1).

**Expect:**

- In IST, 15:15 = 09:45Z (on the grid), so no snap: the row saves as 15:15–16:15 (local 915–975). B1 sees a 15:15 start.
- Then try 15:00–16:00 in H4's Kathmandu custom editor (or reuse S-05's observation): the inputs move to 15:15–16:15. Record whether any text explains the change.

**Probe further:** IST windows at :15 are legal but look odd to buyers in other zones (B2 sees 09:45 GMT). Is that acceptable? Note only.

## HM-11 — Shrinking hours under a live booking keeps the booking and says so `[local]`

**Why it matters:** a consultant who narrows hours must not cancel or move paid sessions, and must be told which ones now sit outside.

**Setup:** F-BUSY (Tue D+1 18:00 IST, B3) on H1.

**Steps:**

1. As H1 change Tuesday's 17:00–21:00 to 17:00–18:00. Save. Read the toast.
2. R-03 for F-BUSY. As B1 read Tue D+1 on H1's expert page.
3. Restore Tuesday 17:00–21:00. Save.

**Expect:**

- Toast "Settings updated" / "Saved. 1 upcoming session now falls outside your published hours — they keep their time; reschedule or cancel from Appointments if needed." (`uncoveredUpcoming.count = 1`).
- F-BUSY unchanged (same occurrence id, `startsAt`, status).
- B1 sees no Tuesday starts after 17:00.
- Step 3 toast without the uncovered sentence.

**Probe further:** does H1's appointment detail now flag F-BUSY as "outside your hours"? Does the Requests page show a paused banner? Note what H1 sees tomorrow (nothing should change by itself).

## HM-12 — Two tabs editing availability: the stale save is refused

**Why it matters:** the whole-form PUT would otherwise overwrite another tab's newer hours.

**Setup:** H3 on F-AV3. `[two-browser]` (one extra isolated page signed in as H3).

**Steps:**

1. Open H3's availability page in both pages.
2. Page 1: add Saturday 10:00–12:00, Save.
3. Page 2 (stale): add Sunday 10:00–12:00, Save.

**Expect:** the stale tab must not silently erase the newer Saturday row. Reading the code, the availability `PUT /api/user/consultants/[cid]` replaces the whole weekly set and has no version check (the 409 `SETTINGS_CHANGED` guard covers only the booking-settings fields: mode, pause, open-request cap). So the likely result is that page 2 wins and Saturday disappears. If so, report BUG P2 (lost update) with R-02 before and after. If page 2 is refused or told to reload, PASS and quote the copy.

**Probe further:** repeat with the Settings → Booking page in two tabs (change "How people book you" in both): the second save should get 409 `SETTINGS_CHANGED` "Your booking settings were changed somewhere else. Reload to see the latest, then try again." Restore F-AV3 and H3's booking mode. Deep races belong to 09.

## HM-13 — The grid offers exactly the window edges (and the overnight tail)

**Why it matters:** salvaged from old 014 Phases 3–4 (window edges, overnight tail), as grid display rather than allocation. The grid must offer only atoms the validator accepts.

**Setup:** F-AV1. Optionally HM-01's overnight row on H3 (re-add, then restore).

**Steps:**

1. As B1, H1's expert page, a weekday, the 60-min plan. List the first and last start times of each window.
2. With the 90-min plan (S-10), list them again.
3. If you re-added H3's overnight row: list Saturday's tail starts for a 60-min plan.

**Expect:**

- 60 min: 09:00 … 12:00 and 17:00 … 20:00. 12:30 and 20:30 are not offered (would end past the window).
- 90 min: 09:00 … 11:30 and 17:00 … 19:30.
- Overnight tail: starts up to 01:00 EST (ends 02:00); none at 01:30.

**Probe further:** compare with `GET /api/scheduling/availability-with-allocation/[H1 cid]?startDateInUtc=…&endDateInUtc=…&timezone=Asia/Kolkata` for that day: the API's free atoms must match the pills exactly.

## HM-14 — A dead hold frees the grid; a paid one never does `[local]`

**Why it matters:** salvaged from old 011 Phases 1–4. A buyer who walks away from checkout must not block the time forever, and a paid booking must never be freed by its stale `expiresAt`.

**Setup:** local. As B2, open H1's 60-min checkout for Wed D+2 11:00 IST and start the gateway payment, then close the Razorpay window without paying. If no `PENDING` `Payment` row appears (no gateway keys), mark BLOCKED.

**Steps:**

1. As B1, look at Wed D+2 on H1's expert page and on any H1 grid. Record 11:00's state.
2. Owner-approved: `UPDATE "Payment" SET "expiresAt" = now() - interval '1 minute' WHERE id = :b2PaymentId;` Reload B1's page.
3. Owner-approved: on F-BUSY's payment (SUCCEEDED) set `"expiresAt" = now() - interval '1 hour'`. Reload Tue D+1 18:00.
4. Restore F-BUSY's `expiresAt` to its recorded value. Let B2's hold expire through the sweep later (12) or abandon it (`POST /api/bookings/[id]/abandon` as B2).

**Expect:**

- Step 1: 11:00 not offered to B1 (held); on H1's grid it reads Booked.
- Step 2: 11:00 offered again, with **no** write to the occurrence (same row, `isTentative = true`, not deleted); the ETag changed so the poll picks it up within ~60 s.
- Step 3: 18:00 stays Booked. If it frees, FAIL (P0: a paid session can be double-booked).

**Probe further:** the hold-expiry sweep itself is 12-sweeps-background-jobs. What does B2 see if they return to the checkout tab after step 2?
