# 06-b · Classes: the weekly-pattern scheduler and the calendar view

**Needs:** `qa-CL-08` (DRAFT, no sessions) and a second unscheduled class `qa-CL-13` (2/week × 1 month × 60 min, created without a start date); F-AV2; one confirmed H2 session in the next 4 weeks for the Busy cases (B2's `qa-SU-14` sessions from 04, or a webinar from 05). Preview OK.
**Personas:** H2 (IST); H3 (America/New_York) as co-host; H4 (Asia/Kathmandu); B2 (Europe/London) for the public view.
**Docs under test:** decision 4 and 7 of the scheduling ADR; `components/scheduling/ClassPatternScheduler.tsx`; `lib/booking/class-pattern.ts`; `app/dashboard/consultant/[consultantId]/(features)/appointments/[appointmentId]/timings/ManageTimingsClient.tsx`; `lib/booking/allocation/search/find-available-slots.ts` (class sweeps); `utils/scheduling-engine/sessionCaps.ts` (2 a day for a class).

**The scheduler (Manage timings, default view for a class):** **First possible day** (a date, `min` = today + 1 h in the host's zone, "Times are in <zone>."), **Meets every week on** rows (weekday + time on :00/:30, **Add a day**, remove buttons), a preview "<k> of <N> sessions" listing each start with a label from the picker rules (05's WE-02: Free / Outside your hours / Busy / Too soon), or "Checked when you save" beyond 28 days. Problems show instead of the count: "Add at least one weekday and time.", "Pick the date the class starts.", "Pick each time on the hour or half hour.", "Two rows have the same day and time.", "A class meets at most twice on one day." Busy rows show "<n> clash with your calendar — change those days or times". Too few sessions: "This pattern can't place all <N> sessions. Pick an earlier start or more days." **Schedule <k> sessions** is disabled while there is a problem, a clash, or a shortfall. **Use the calendar view instead** switches to the week grid; **Schedule from a weekly pattern instead** switches back.

Saving sends `PATCH /api/bookings/classes/[classId]/allocate` with `{ isAuto: false, slots: <atoms>, override: true, initialAllocation: true }` (no `initialAllocation` when the class already has sessions) and a fresh `Idempotency-Key`. After every save: R-03, R-05.

## CL-13 — "Schedule now" opens the pattern scheduler with sensible defaults

**Steps:**

1. As H2, Offerings → `qa-CL-13` → **Schedule now**.
2. Read the page title, the First possible day, the rows and the preview.

**Expect:**

- URL `…/appointments/unscheduled-class-<id>/timings`; title "Manage timings: qa-CL-13 — Familiarise".
- First possible day = today (in IST) if now + 1 h is still today, else tomorrow.
- Rows: 2 rows for 2 a week: **Mon 18:00** and **Thu 18:00** (`defaultRows`: spread from Monday, gap 3).
- Preview: "8 of 8 sessions", each "Mon <date>, 6:00 PM" style in IST, Mondays labelled Free (inside 18:00–21:00), Thursdays labelled **Outside your hours** (Thursday hours are 07:00–09:00); dates past 28 days "Checked when you save".

**Probe further:**

- A host whose plan says 3 a week gets Mon/Wed/Fri; 7 a week gets every day. Spot-check one.
- Is "Outside your hours" a warning or just a label? A host may run a class outside hours (save is not blocked). Is that clear?

## CL-14 — Save the pattern

**Steps:**

1. In CL-13's scheduler, change the Thursday row to **Wed 19:00**. Read the preview.
2. Click **Schedule 8 sessions**.
3. Read the toast and where you land. As B2, open the public page.

**Expect:**

- Preview: all Free (Mon 18:00, Wed 19:00 are inside hours) unless a Busy clash.
- Network: PATCH with `override: true`, `initialAllocation: true`, 16 slot atoms (8 sessions × 2), an `Idempotency-Key` header → 200.
- DB: 8 occurrences at exactly the previewed instants (Mon 12:30Z, Wed 13:30Z), ordinals 1–8, 60 min. `Class.status` (record; SCHEDULED expected once published).
- Toast "8 sessions scheduled"; back to Appointments.
- B2 sees Mondays 12:30 and Wednesdays 13:30 London.

**Probe further:** double-click Schedule: one allocation, the second replays or is refused (depth in 09).

## CL-15 — Pattern problems

**Steps (in a fresh scheduler for `qa-CL-08`):**

1. Remove rows until one is left; try to remove the last (button disabled).
2. Add a row identical to an existing one.
3. Make three rows on Monday (18:00, 19:00, 20:00).
4. Set First possible day to yesterday (type it).

**Expect:**

- 2 → "Two rows have the same day and time."; Schedule disabled.
- 3 → "A class meets at most twice on one day."; Schedule disabled.
- 4 → the input's `min` blocks it, or the preview skips past starts and counts fewer than N (record which); never a session before now + 1 h.

**Probe further:** the problem replaces the "k of N" count in the header. Is it read out by a screen reader (live region)?

## CL-16 — Cadence mismatch note

**Steps:** with a 2-a-week plan, add a third row (Fri 18:00). Then remove two, leaving one.

**Expect:**

- 3 rows: "The plan says 2 a week; this pattern meets 3 times a week, so the class runs faster." The preview still lists 8 sessions, finishing sooner.
- 1 row: "…meets 1 times a week, so the class runs longer." (record the "1 times" wording: **COPY**, P3).

**Probe further:** a class that runs faster finishes before its `schedulingPeriodEndsAt`; one that runs longer runs past it. Does anything else (checkout dates, batch card "Mondays") follow the real pattern?

## CL-17 — Kathmandu host: the scheduler offers :15 and :45

**Why it matters:** the platform keeps the UTC half-hour grid, so in UTC+05:45 every legal start is :15 or :45 local. The scheduler lists only those times (`atomPhaseMinutes`, `startDatePhase`).

**Steps:**

1. As H4 (Asia/Kathmandu), open Manage timings for an unscheduled H4 class (create one without a start date).
2. Read the time options in a row and the default rows. Pick Mon 10:15. Read the preview and the Schedule button.

**Expect:** time options are :15 and :45 only (the default rows read 18:15, not 18:00); Mon 10:15 previews all 8 sessions and Schedule is enabled; saving stores 04:30Z. A time that is not on the list is refused with "Pick each time from the list." (`OFF_GRID_TIME`).

**Report:** a missing 10:15 option, a default row at :00 or :30, or a disabled Schedule is a **BUG** (P1 for any :45 zone). Also open the calendar view as H4 and read the week grid's hour labels: each local hour's first row (:15) prints the hour, and every row keeps its full name for screen readers. Record any label that reads wrong.

## CL-18 — A clash with the host's calendar blocks the save

**Setup:** a confirmed H2 session at a time a default row would hit (e.g. B2's `qa-SU-14` Monday 18:00–20:30 session).

**Steps:**

1. In a scheduler for `qa-CL-08`, keep Mon 18:00. Read the preview row for that Monday and the header.
2. Change Mon to 20:30 (after the clash).

**Expect:**

- Step 1: that Monday's row is **Busy** (highlighted), header "1 clash with your calendar — change those days or times", Schedule disabled.
- Step 2: no clash; Schedule enabled.

**Probe further:** clashes beyond 28 days aren't checked in the preview ("Checked when you save"). Put a clash at day 30 and save: expect 409 from the allocator ("One of these times is already booked. Pick another time." or `SLOT_TAKEN`) and a toast "Couldn't save the schedule" with the server's text. Does the host learn **which** session clashed?

## CL-19 — Re-plan an unsold class

**Steps:**

1. As H2, open Timings for `qa-CL-01` (published, no buyers). Read which view opens and its defaults.
2. Pick a new pattern (Tue 07:00 and Fri 19:00). Save.
3. Compare occurrence ids before and after.

**Expect:** the pattern scheduler opens; the PATCH has no `initialAllocation` (the class has sessions); the sessions are replaced (old rows deleted or tombstoned, new rows at the new times; record ids and statuses). R-05 zero rows.

**Probe further:** the re-plan hard-deletes superseded rows (allocator). If a past session existed (shift one into the past), what happens to it? It should keep its time ("past sessions stay as they are").

## CL-20 — The calendar view and back

**Steps:**

1. In `qa-CL-08`'s scheduler, click **Use the calendar view instead**. Read the grid's context row and tray.
2. Click **Schedule from a weekly pattern instead**.

**Expect:** the week grid (desktop) with the class's cadence chip ("Plan: 2 a week · 1 hr each" or similar), the per-day cap of 2, and Auto-schedule / Save. Switching back shows the scheduler with its previous rows (record whether state is kept).

**Probe further:** at 390×844 the calendar view shows the desktop-only notice, the pattern scheduler should be fully usable (CL-24).

## CL-21 — Auto-schedule spreads sessions before stacking two a day

**Why it matters:** decision 7: classes get the spaced-first sweep, then one a day, and stack two a day only last.

**Setup:** as H2, create unscheduled classes `qa-CL-21a` (4/week × 1 month × 60 min) and `qa-CL-21b` (6/week × 1 month × 60 min). H2 has 5 open days (Mon–Fri).

**Steps:**

1. Calendar view for `qa-CL-21a` → **Auto-schedule**. Save.
2. Same for `qa-CL-21b`.
3. Run the "sessions per IST day" query: `SELECT date_trunc('day', "startsAt" AT TIME ZONE 'Asia/Kolkata') d, count(*) FROM "AppointmentOccurrence" WHERE "appointmentId" = :aid AND "deletedAt" IS NULL GROUP BY 1 ORDER BY 1;`

**Expect:**

- `qa-CL-21a`: each week Mon, Wed, Fri (spaced) plus one of Tue/Thu (one a day); never 2 on a day.
- `qa-CL-21b`: each week one session on each of Mon–Fri, and exactly one day with 2 (the cap). Never a day with 2 while another open weekday that week has 0.
- 16 and 24 sessions respectively; all inside published hours (auto never uses outside hours).

**Probe further:** Tue/Thu windows are 2 h: two 60-minute sessions fit back to back. Are stacked sessions back to back or spaced inside the window?

## CL-22 — Auto with too few hours: a partial schedule, and buyers can't enrol yet

**Setup:** an unscheduled class `qa-CL-22`: 3/week × 1 month × **2.5 h** (only Mon/Wed/Fri evenings fit).

**Steps:**

1. Calendar view → **Auto-schedule**. Read the dialog.
2. Click **Schedule <k> now**.
3. As B2, open the public page and try to enrol.

**Expect:**

- Dialog "Only <k> of 12 sessions fit" (k = Mon/Wed/Fri evenings left in the period; free H2 evenings only) with "Your published availability in this period can hold <k> sessions…".
- After: k sessions; the class can't sell: checkout refuses "This class is not fully scheduled yet (<k> of 12 sessions). Enrollment opens once all sessions are scheduled." Record the HTTP status (a 500 here is **ERROR-HANDLING**).

**Probe further:** the pattern scheduler for the same class can place all 12 by allowing outside hours. Does the partial dialog mention that option? **MISSED-OPPORTUNITY** if not.

## CL-23 — A co-host's calendar is checked when the pattern saves

**Setup:** H3 accepted as Co-Instructor on `qa-CL-08` (invite from the editor's Collaborators section; accept as H3 at `/dashboard/consultant/[H3 cid]/collaborations`). H3 holds a confirmed session at time T that a default row would hit (H3 publishes a free webinar at Monday 18:00 IST = 07:30 New York).

**Steps:**

1. In `qa-CL-08`'s scheduler, keep Mon 18:00. Read the preview.
2. Save.

**Expect:**

- Preview: the scheduler sends the class, so H3's busy time is folded in and that Monday reads Busy (record the label); a Monday that reads Free is a **BUG** (P2).
- Save: 409 `errorCode: "COLLABORATOR_UNAVAILABLE"` (toast "Co-host unavailable") or the conflict copy "A co-host already has a session at one of these times. Pick another time." Nothing written.

**Probe further:** if the preview still promises a clean pattern the server refuses, that is a **BUG**. Is the co-host clash labelled as H3's? **MISSED-OPPORTUNITY** if not. A co-host outside **their** hours: does `override: true` skip "One of these times is outside a co-host's available hours…"? Record.

## CL-24 — The pattern scheduler on a phone

**Steps:** `resize_page` 390×844. Repeat CL-13 and CL-14 on a fresh unscheduled class.

**Expect:** fully usable: no desktop-only notice, selects and buttons reachable, preview scrolls inside its box, no horizontal page scroll.

**Probe further:** the preview list caps at `max-h-72` with its own scroll; is the Schedule button visible without scrolling the page?

## CL-25 — Every session lands where the preview said

**Why it matters:** "Saving sends exactly those times to the allocator."

**Steps:** for CL-14's and CL-19's saves, list the preview's starts (screenshot) and the DB's `startsAt` converted to IST.

**Expect:** identical, one to one, in order.

**Probe further:** leave the scheduler open past midnight IST before saving (or move First possible day across today): does `notBeforeMs` drop the first session from the preview at save time while the button label still says the old count?

## CL-26 — Manage timings for a sold class shows the stop panel

**Setup:** `qa-CL-01` with a buyer (CL-27).

**Steps:** open `/appointments/[aid]/timings` directly; read the panel. Open the Appointments row menu.

**Expect:** panel "This event already has booked seats" with "Its times can't be re-planned here… Use "Move to a new date" (a webinar) or "Move upcoming sessions" (a class) on the event page instead…" and **Open the event**. The menu has no Timings.

**Probe further:** for a **class** the panel names **Move upcoming sessions**, the button on the detail page. A panel that still says "Re-time" is **COPY** (P2).
