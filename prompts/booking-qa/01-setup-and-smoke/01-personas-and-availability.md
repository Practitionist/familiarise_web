# 01-a · Setup: personas, zones and availability fixtures

**Needs:** nothing. Run first, once per environment. Preview OK (no money moves here).
**Personas:** H1 (IST), H2 (IST), H3 (America/New_York), H4 (Asia/Kathmandu), all buyers and operators for S-01.
**Docs under test:** `.claude/skills/booking/references/availability.md` §1–2, `docs/booking/19-dst-and-timezone-posture.md`, `lib/scheduling/availability-contract.ts`.

Conventions for the whole suite (from the old `wave0-shared-setup.md`, still valid):

- **D** = the next Monday that is at least 3 days away, in IST. Every later folder books relative to D so the cancel tiers don't move during a run. Write D's date at the top of your report.
- Weekly rows are read from their five local columns only (`timezone`, `localStartDay`, `localStartMinutes`, `localEndDay`, `localEndMinutes`). A row with any of them NULL is invisible to every reader. That's why fixtures go through the UI, never through SQL inserts.
- The availability editor lives at `/dashboard/consultant/[cid]/availability` (the same section also renders inside Settings). It saves the whole form with `PUT /api/user/consultants/[cid]`. Watch that request in the network panel for every save below.
- A consultant publishes **either** weekly **or** custom hours (`ConsultantProfile.scheduleType`, radio "Weekly Recurring" / "Custom Schedule"). There is no "override a weekly day" feature. A custom row is additive only and can't block a day.

## S-01 — Capture persona ids, roles, zones and booking settings

**Why it matters:** every later case quotes these ids and zones; a wrong zone makes every time assertion wrong.

**Setup:** none.

**Steps:**

1. Run R-01. Record every row at the top of your report.
2. Run, for H1–H4 and OX:

   ```sql
   SELECT u.email, cp.id, cp."scheduleType", cp."bookingMode", cp."acceptingRequests", cp."maxOpenRequests",
          (SELECT count(*) FROM "AvailabilityWindowWeekly" w WHERE w."consultantProfileId" = cp.id) AS weekly_rows,
          (SELECT count(*) FROM "AvailabilityWindowCustom" c WHERE c."consultantProfileId" = cp.id) AS custom_rows
   FROM "ConsultantProfile" cp JOIN "users" u ON u.id = cp."userId"
   WHERE u.email IN ('hannah.anderson@yahoo.com','grace.anderson@outlook.com','james.anderson@protonmail.com',
                     'ethan.anderson@gmail.com','aarav.anderson@gmail.com');
   ```

3. For DR, confirm which roles the account holds (consultee profile, consultant profile, memberships). Write down whether DR is really dual-role.
4. Compare each `User.timezone` with the zone column in `_shared/personas-and-fixtures.md` §1.

**Expect:**

- DB: every persona exists. H1–H4 and OX have a `consultantProfileId`; B1–B4 and DR have a `consulteeProfileId`; ST and AD have a `staffProfileId` (or none if the schema keys operators differently; record it).
- OS is OWNER of Wipro (SPONSOR); OH is OWNER of LearnPro Academy (HOST); OX is EXPERT in LearnPro with an ACTIVE membership; B4 and DR are Wipro LEARNERs.
- `bookingMode` is `INSTANT` and `acceptingRequests` is true for H1–H4 at the start. If not, note it; S-07 fixes H1.

**Cross-check:** none (ids only).

**Probe further (report anything odd):**

- Any persona whose zone differs from the table: list it. S-04/S-05 change H3/H4 through the UI; others you change only if a case needs it.
- Leftover availability rows in the dormant mode (e.g. custom rows on a WEEKLY profile). They're harmless by design (readers gate on `scheduleType`), but list them.
- Leftover `qa-` fixtures from an earlier run (R-08). List them before you create new ones.

## S-02 — F-AV1: H1 weekly hours in Asia/Kolkata

**Why it matters:** H1 is the main 1:1 host; every consultation, subscription and trial case reads this shape, including the 13:00–17:00 gap.

**Setup:** H1's `User.timezone` is `Asia/Kolkata` (S-01). If H1 already has weekly rows, remove them in the editor first (trash icon "Delete slot N for Monday" and so on) and save, so the result is exactly F-AV1.

**Steps:**

1. Sign in as H1. Open `/dashboard/consultant/[H1 cid]/availability`.
2. Read the header block: "Availability Settings", "Schedule Type Filtering" and the zone line under Weekly Recurring. Quote the zone line ("Times are in Asia/Kolkata and follow daylight saving automatically.").
3. Make sure "Weekly Recurring" is selected.
4. Monday: add 09:00–13:00 and 17:00–21:00. Repeat for Tuesday to Friday.
5. Saturday: add 10:00–14:00. Sunday: no rows.
6. Read the validation feedback under the editor (`SlotValidationFeedback`): it should count the slots, total hours and "overnight" (0), and say "Ready to proceed".
7. Click Save. Read the toast.
8. Reload the page.

**Expect:**

- UI: toast title "Settings updated", description "Your profile settings have been successfully updated." After reload the same 11 rows show at the same clock times.
- API: `PUT /api/user/consultants/[cid]` → 200.
- DB (R-02): 11 weekly rows; each has `timezone = 'Asia/Kolkata'` and non-null `local*` columns. Mon 09:00 IST row: `localStartMinutes = 540`, `localEndMinutes = 780`, `startTimeUtc = 210` (03:30Z), `utcOffsetMinutes = 330`. The 17:00–21:00 rows: local 1020–1260 = 11:30Z–15:30Z. No row covers 13:00–17:00. Saturday 600–840. No Sunday row.
- The two windows on one day stay two rows (they aren't adjacent, so nothing coalesces).

**Cross-check:** open `/explore/experts/[H1 cid]` signed out (or as B1, IST). Click "Book Now", pick a weekday: times run 09:00–12:00 starts and 17:00–20:00 starts for a 60-min plan once S-08 exists; nothing between 13:00 and 17:00; Sunday is not bookable. As B2 (Europe/London) the same Monday 09:00 IST row reads 03:30 (GMT) or 04:30 (BST): note which, with the date.

**Probe further (report anything odd):**

- Type 09:00–13:00 and then 13:00–17:00 on Monday, save, and read R-02: exact adjacency on one local day must coalesce into one 09:00–17:00 row with a **new** id (weekly rows are delete-and-recreate). Then delete back to F-AV1 and save. Report whether the editor shows one row or two after reload.
- Does the zone line or any alert claim "follow daylight saving" for IST, which has none? Note it as copy, not a bug.
- Is there any message telling H1 that changing hours never moves existing bookings? (There is a toast when sessions fall outside new hours; S-02 has none yet.)
- Console after save: any warning from the form.

## S-03 — F-AV2: H2 tight weekly hours

**Why it matters:** H2's thin hours drive the feasibility and class-pattern cases in 04 and 06.

**Setup:** H2 zone `Asia/Kolkata`.

**Steps:**

1. Sign in as H2. Open `/dashboard/consultant/[H2 cid]/availability`. Select "Weekly Recurring".
2. Monday, Wednesday, Friday: 18:00–21:00.
3. Tuesday, Thursday: 07:00–09:00.
4. Save, reload.

**Expect:**

- UI: "Settings updated" toast; 5 rows after reload.
- DB (R-02): 5 rows, `timezone = 'Asia/Kolkata'`. Mon 18:00–21:00 = local 1080–1260 = 12:30Z–15:30Z. Tue 07:00–09:00 = local 420–540 = 01:30Z–03:30Z.

**Cross-check:** `/explore/experts/[H2 cid]` lists no 1:1 consultation unless H2 has one; that's fine. Note whether the page explains "no 1:1 sessions" or shows an empty calendar.

**Probe further:** the longest window is 180 min. Later folders depend on that number (`SESSION_LONGER_THAN_WINDOWS` for 3.5 h sessions). Confirm it from the rows.

## S-04 — F-AV3: H3 in America/New_York, set through the UI

**Why it matters:** the DST host. Setting the profile zone through Settings → Account is itself the re-anchor flow every non-IST expert will meet.

**Setup:** H3's current zone from S-01. If it's already `America/New_York` and H3 has F-AV3 rows, skip to the DB check.

**Steps:**

1. Sign in as H3. Open `/dashboard/consultant/[H3 cid]/settings/account`.
2. In "Your details", open the **Timezone** select ("Choose your timezone"), pick "America/New York", and save. Read the toast.
3. If H3 already had weekly rows in another zone, a dialog appears: "Convert my weekly hours to America/New_York?" with "Keep in <old zone>" and "Convert". Click **Convert**. Read the toast ("Weekly hours now in America/New_York" or "No weekly hours needed converting").
4. Open `/dashboard/consultant/[H3 cid]/availability`. The zone line must read "Times are in America/New_York …". Remove any rows that aren't F-AV3.
5. Monday to Friday: 09:00–17:00. Save, reload.

**Expect:**

- UI: no "Weekly hours kept in …" alert once the rows are in New York. If the browser runs in IST, a second alert says "You're viewing in Asia/Calcutta (or Asia/Kolkata); your schedule is in America/New_York." That's correct.
- API: `POST /api/scheduling/availability/weekly/zone` → 200 with `data.converted` (only if step 3 ran); `PUT /api/user/consultants/[cid]` → 200.
- DB (R-02): 5 rows, `timezone = 'America/New_York'`, `localStartMinutes = 540`, `localEndMinutes = 1020`. The UTC columns reflect the save probe date's offset (the editor's 1970-01-01 probe, so EST −300): `startTimeUtc = 840` (14:00Z). Readers ignore the UTC columns; record them anyway. `User.timezone = 'America/New_York'`.

**Cross-check:** as B1 (IST) open `/explore/experts/[H3 cid]` → Book Now on a weekday after the 1 Nov 2026 DST end: Mon 09:00 EST shows as 19:30 IST. On a date before 1 Nov (if still in range) 09:00 EDT is 18:30 IST. Convert both yourself and quote what the page shows.

**Probe further:**

- If you clicked "Keep in <old zone>" instead, the availability page should show the "Weekly hours kept in …" alert with the exact copy "Your profile timezone is America/New_York, but your weekly hours stay in …". Try it on H3 only if you can restore F-AV3 afterwards, and say so.
- Is the timezone list readable (it's every IANA zone)? Can you type to search? A11Y/UX note only.
- Does any other page (H3's consultant home, appointments) still render IST after the change? List each surface that follows the old zone.

## S-05 — F-AV4: H4 in Asia/Kathmandu (weekly refused, custom works)

**Why it matters:** UTC+05:45 puts every local :00/:30 off the UTC half-hour grid. The server refuses weekly hours in such a zone; the fixture as written in `_shared` (Mon–Sat 10:00–12:00 local, weekly) can't exist. This case proves the refusal and builds the nearest legal fixture.

**Setup:** H4 has no live bookings (the schedule-type switch is locked while appointments are active).

**Steps:**

1. Sign in as H4. Settings → Account: set Timezone to "Asia/Kathmandu", save.
2. Open `/dashboard/consultant/[H4 cid]/availability`, "Weekly Recurring". Add Monday 10:00–12:00. Save.
3. Read the toast and the network response.
4. Select "Custom Schedule". If it's disabled, read the "Schedule Type Locked" alert and stop (BLOCKED: H4 has active appointments; list them).
5. In the month calendar, click D, D+1, D+2, D+3, D+4, D+5 (Mon–Sat). For each date add a row by typing **10:00–12:00**. Watch the inputs: they should snap to 10:15–12:15 local (= 04:30Z–06:30Z, on the UTC grid).
6. On D+5 only, add a second row and type 10:00–12:00 again. Read the inputs and any message.
7. Delete the second D+5 row, save, reload.

**Expect:**

- Step 3: the save is refused with HTTP 400 and code `ZONE`; the toast quotes the server sentence "Weekly hours can't be published in Asia/Kathmandu yet: its UTC+05:45 offset puts every local hour off the 30-minute booking grid. Use date-specific availability instead." If the toast is blank, generic, or the save succeeds, that's a FAIL. If it saves, run R-02 and report what was stored.
- Step 6: the editor snaps the row forward onto the UTC grid as you type (`normaliseSlotToSchedulingGrid`, same shift for both ends): 10:00–12:00 becomes **10:15–12:15** in the inputs before you save. That would now duplicate the first D+5 row, so expect "Slots cannot overlap" on it. Record whether anything tells H4 *why* the time changed. A silent snap is a MISSED-OPPORTUNITY (P2). If the input keeps 10:00 and the server answers 400 `GRID` ("Window N: times must start on the hour or half hour — …"), quote it and note that from H4's point of view 10:00 *is* on the hour (FALSE-INFO, P2).
- Step 7: "Settings updated". DB: `scheduleType = 'CUSTOM'`; 6 `AvailabilityWindowCustom` rows, each `startsAt` at 04:30Z and `endsAt` at 06:30Z on its date. Custom rows on consecutive dates don't touch, so none coalesce.

**Cross-check:** as B1 (IST) on `/explore/experts/[H4 cid]`, D's times show 10:00–11:00 IST starts (04:30Z = 10:00 IST). As H4 the same cells read 10:15–12:15 NPT.

**Probe further:**

- Record this as **DOC-DRIFT** against `_shared/personas-and-fixtures.md` F-AV4 and tell the coordinator the fixture now reads "custom, D…D+5, 10:15–12:15 NPT".
- Does the editor itself warn before save that Kathmandu can't hold weekly hours, or only after the round trip? A pre-save hint is a MISSED-OPPORTUNITY if absent.
- The custom calendar lists dates with `toLocaleDateString("en-US")` from the browser zone. With the browser in a zone behind UTC, check the date labels don't shift by a day.
- "N date(s) configured" copy: note the "(s)".

## S-06 — Availability editor refusals worth knowing before anything else

**Why it matters:** each refusal here protects every later booking; the deep edge cases (overnight, overlaps, zone change effects) are in 02-availability-and-heatmap. This case only proves the editor refuses bad rows with a readable message, on H3 so H1/H2 stay clean.

**Setup:** S-04 done.

**Steps (as H3, availability page, Weekly):**

1. Monday: add 09:00–09:15 (shorter than 30 min). Save.
2. Monday: add 17:00–05:30 Tuesday (longer than 12 h) if the editor lets you express an overnight row; otherwise 06:00–19:00 (13 h). Save.
3. Monday: add 12:00–14:00 on top of 09:00–17:00 (overlap). Save.
4. Monday: add 08:30–09:00 (exactly adjacent to 09:00–17:00). Save, then reload and read R-02.
5. Restore F-AV3 and save.

**Expect:**

- Steps 1–3 never reach the DB. The editor marks the row red with an inline message as you type, and Save shows the "Validation Error" toast ("Please fix the following issues: monday slot 2: …"). Expected inline messages (`utils/scheduling-engine/interval-validation.ts`): step 1 "Session duration must be in multiples of 30 minutes"; step 2 "Session cannot exceed 12 hours"; step 3 "Slots cannot overlap". If the client lets one through, the server must answer 400 with `DURATION` ("Window N: duration must be between 30 minutes and 12 hours") or `OVERLAP` ("Windows i and j overlap"). Quote which layer refused and the exact text.
- Step 4: one row 08:30–17:00 (coalesced), new id. The editor shows one row after reload.
- Step 5: R-02 is back to 5 rows of 09:00–17:00 New York.

**Cross-check:** none.

**Probe further:** these messages say "Session" about an availability window, and the toast prefixes a lowercase day key ("monday slot 2"). Report both as COPY (P3) if seen. Is the Save button disabled while invalid, or does it let you click and then toast?

## S-07 — H1 booking mode baseline and the per-expert "Review requests first" switch

**Why it matters:** `_shared` asks for a "request/approval" consultation plan, but the booking mode is a per-expert setting, not a per-plan one. Every request/approval case in 03 has to flip H1's mode and flip it back. This case proves the switch works and is reversible.

**Setup:** S-01 recorded H1's `bookingMode`.

**Steps:**

1. As H1 open `/dashboard/consultant/[H1 cid]/settings/booking`. Read the "Booking mode" section: "How people book you", options "Instant booking" and "Review requests first", the "Taking new 1:1 bookings and trials" switch and "Limit open requests to".
2. Choose "Review requests first". Save. SQL: `bookingMode`.
3. As B1 open `/explore/experts/[H1 cid]` → Book Now → any weekday (needs S-08's plan; if it doesn't exist yet, come back after S-08).
4. As H1 switch back to "Instant booking". Save. Reload B1's page.

**Expect:**

- Step 2: `ConsultantProfile.bookingMode = 'REQUEST'`. Option copy reads "Every time comes to you as a request. Nobody pays until you approve, and the pay link stays open for 24 hours."
- Step 3: every time pill carries a small "Request" tag, and the sentence under the button explains it ("the expert confirms before you pay"). The CTA is a request, not a checkout.
- Step 4: `bookingMode = 'INSTANT'`; the tags disappear (except on a contended slot).

**Cross-check:** H1's Requests page (`/dashboard/consultant/[H1 cid]/requests`) still loads in both modes.

**Probe further:**

- Report as **DOC-DRIFT** that F-PL1's "request/approval booking mode" plan is really an expert-wide switch (`ConsultantProfile.bookingMode`).
- Does H1 get told that REQUEST mode also turns trials and subscriptions into requests? Read the copy and check 07's trial modal later.
- The "pay link stays open for 24 hours" claim: 03 verifies it against the real `Payment.expiresAt`.
