# 06-a · Classes: the editor, the start-date series and drafts

**Needs:** F-AV2 (H2), F-AV3 (H3), F-AV4 (H4), F-PL2 classes (a published 2/week × 60 min class about 10 days out, capacity 5, and a DRAFT with no start). Preview OK (no money).
**Personas:** H2 (IST) host; H3 (America/New_York) for the DST series; H4 (Asia/Kathmandu); B2 (Europe/London) and B3 (America/Los_Angeles) to read the public page; OH for the org catalog door.
**Docs under test:** decision 4 and 7 of `docs/decisions/2026-11-09-scheduling-surfaces-and-feasibility.md`; `lib/booking/class-pattern.ts` (`seriesStartsFrom`, `projectPattern`); `app/api/bookings/classes/crud-with-plan/route.ts`; `schemas/plans.ts` (`ClassPlanSchema`); `docs/booking/16-recurring-events-journey.md` §2b and §3b-i.

The class editor is `/dashboard/consultant/[cid]/offerings/class/new` (or `…/class/[planId]/edit`), reached from Sell → Group programs → Classes. "Pricing & cadence" holds Price, Duration (months), Sessions per week, Session duration (hours) ("Hours per session, in 30-minute steps, up to 4."), Max participants and the waitlist. "Sessions" ("Pick a start date; sessions are generated from the cadence above.") holds **Start date** ("Required before publishing."), **Let learners join until session N** and **Share past recordings with members who join late**.

**Series rule (code):** total sessions N = sessions a week × months × 4. From the first session (the Start date's weekday and time, read in the host's profile zone), `seriesStartsFrom` lays out a weekly pattern: 2 a week → day 0 and day 0 + 3; 3 a week → every other day; then N starts on the host's wall clock. A start that isn't on the UTC half hour is **skipped**, not moved.

Zone line: Mon 18:00 IST = 12:30Z = 12:30 London = 04:30 Los Angeles = 07:30 New York.

After every save: R-02 for the host, R-03 for the class appointment, R-05.

## CL-01 — Publish a class with a start date: N sessions on the host's clock

**Why it matters:** the editor's start date is the commonest way a class gets its times.

**Steps:**

1. As H2, new class `qa-CL-01`: ₹1,000, Duration 1 month, Sessions per week 2, Session duration 1, Max participants 5, one curriculum item, a topic.
2. **Start date**: next Monday 18:00 (read what the control is: date only, or date and time). Publish.
3. As B2 and B3, open the public class page.

**Expect:**

- API: `POST /api/bookings/classes/crud-with-plan` with `startDate` → 2xx.
- DB: `ClassPlan.totalSessions = 8`, `sessionsPerWeek = 2`, `sessionDurationInHours = 1`, `durationInMonths = 1`; `Class.status = SCHEDULED`, `schedulingTimezone = Asia/Kolkata`; one wrapper `Appointment` (`appointmentType = CLASS`) with 8 occurrences: Mondays and Thursdays 18:00 IST (12:30Z), 60 minutes, ordinals 1–8, `isTentative = false`, `consultantProfileId` = H2.
- Public page: a batch card "Starts Mon <date> · Mondays…" or "Varies" (record the label), seats 5, the free-cancellation line, **Enrol in this batch**. B2 sees 12:30 London; B3 sees 04:30 Los Angeles.

**Cross-check:** H2's Appointments shows the class; Offerings card shows the first session and seats 0/5.

**Probe further (report anything odd):**

- Thursday 18:00 is outside H2's Thursday hours (07:00–09:00). The editor said nothing. Is that fine for a class? (The pattern scheduler labels it, CL-14.)
- Does any surface show all 8 dates before publishing? **MISSED-OPPORTUNITY** if the host commits blind.

## CL-02 — The editor's Start date is read in the browser's zone

**Why it matters:** decision 3 removed browser-zone `datetime-local` inputs for webinars; the class Start date is still one (`OfferingFields` renders kind `date` as `datetime-local`).

**Steps:**

1. Emulate the browser in `America/Los_Angeles` (DevTools MCP `emulate`). As H2 (profile IST), new class `qa-CL-02`, Start date next Monday 18:00 as typed. Publish.
2. Read the first occurrence.

**Expect (per decision 3's intent):** the series at 18:00 IST.

**Likely actual:** the typed 18:00 is read as 18:00 Los Angeles = 02:00Z next day = 07:30 IST Tuesday; the series becomes Tuesdays and Fridays 07:30 IST. Report **BUG** (P1: the host's class lands on the wrong day and time) with the SQL rows. If emulation isn't supported, mark BLOCKED and say why; 10 (`TZ-`) can retry.

**Probe further:** reopen the editor: does it show the stored instant back in the browser's zone (it should, per #1060), and does saving without edits leave it unchanged?

## CL-03 — A start date in the past or off the half hour

**Why it matters:** the class POST has no future or lattice check on `startDate`.

**Steps (via `evaluate_script`, copying the `qa-CL-01` body):**

1. `startDate` = yesterday 18:00 IST (as ISO).
2. `startDate` = next Monday 18:10 IST.
3. `startDate` = next Monday 18:00 IST, `sessionsPerWeek: 2.5`.
4. `sessionDurationInHours: 0.75`.
5. `sessionsPerWeek: 0`.

**Expect:**

- 3–5 → 400 "Invalid input" with the cadence messages ("Sessions per week must be a whole number", "Session duration must be in 30-minute increments", "At least one session per week is required"). Never 500.
- 1 → per decision 2 a class time must be ahead; record what happens. If the route creates a SCHEDULED class with sessions in the past, report **BUG** (P1).
- 2 → every start is off the lattice, so `seriesStartsFrom` skips them all. Record: is it 400, or a SCHEDULED class with **zero** sessions? A published class with no sessions is **BUG** (P1).

**Probe further:** in the editor UI, can H2 type 18:10? (`datetime-local` allows any minute.)

## CL-04 — A daylight-saving change keeps the wall time

**Why it matters:** a New York class at 18:00 must stay at 18:00 after the clocks change.

**Setup:** H3 profile `America/New_York`.

**Steps:**

1. As H3, new class `qa-CL-04`: 2/week, 1 month, 60 min, Start date Monday 1 March 2027 18:00 (H3's browser in New York, or a correct-zone ISO via the API).
2. Read all 8 occurrences.

**Expect:** Mondays and Thursdays 18:00 New York: up to Thursday 11 March at 23:00Z; from Monday 15 March (after the 14 March change) at 22:00Z. Never 17:00 or 19:00 local.

**Cross-check:** B2 (London) sees 23:00 GMT before 14 March and 22:00 GMT after (London changes on 28 March, outside this series). H2's view (IST) shifts by an hour too: 04:30 IST → 03:30 IST.

**Probe further:** deep DST matrices (southern hemisphere, Kathmandu) are 10's. Note only whether any surface labels the change.

## CL-05 — Kathmandu host: the editor works on the half hour UTC

**Steps:**

1. As H4 (Asia/Kathmandu; browser in Kathmandu if you can emulate it), new class `qa-CL-05`: 2/week, 1 month, 60 min, Start date next Monday 10:15. Publish.
2. Repeat with 10:00.

**Expect:** 10:15 → 8 sessions at 04:30Z (10:15 local). 10:00 → off the lattice (04:15Z); expect a refusal or zero sessions (see CL-03).

**Probe further:** nothing in the editor tells a Kathmandu host to use :15/:45. Pair this with CL-17 (the pattern scheduler can't offer :15/:45 at all).

## CL-06 — Totals follow sessions a week × months × 4

**Steps:**

1. As H2, create classes via the editor: 1/week × 1 month; 3/week × 2 months; 2/week × 1.5 months (type 1.5 in Duration if the field allows it).
2. Read `totalSessions` for each and the public "sessions" figure.

**Expect:** 4, 24, and 12 (if 1.5 is accepted). The field says "Whole months, from 1 to 24." while the schema accepts 1.5: report the mismatch (**COPY** or **BUG**, P3) whichever way it goes.

**Probe further:** does the public page say "1 month · 8 sessions" style text? Does it say "per month" anywhere for a whole-class price? (It must not; the price is for the batch.)

## CL-07 — The late-join cutoff is bounded by N

**Steps:**

1. In `qa-CL-01`'s editor, set **Let learners join until session N** to 3. Save.
2. Set it to 9 (N = 8). Save.
3. Set it to 0.

**Expect:** 3 → saved (`ClassPlan.lateJoinUntilSession = 3`). 9 → refused (the route caps at `totalSessions`; record the copy). 0 → "Choose session 1 or later".

**Probe further:** the description "Leave empty to close enrolment when session 1 starts. A late joiner pays only for the sessions left." — does the public page explain late join to buyers (CL-31)?

## CL-08 — A draft class with no start date

**Steps:**

1. Open F-PL2's DRAFT class (or create `qa-CL-08` with no Start date and save as draft).
2. As B2, look for it on H2's page and open its URL.
3. As H2, open Offerings and Appointments.

**Expect:**

- DB: `Class.status = DRAFT`, no occurrences.
- B2: not listed; the URL is hidden.
- H2: Offerings card "Not scheduled yet · **Schedule now**" → `/dashboard/consultant/[cid]/appointments/unscheduled-class-<id>/timings`; Appointments primary action **Set schedule**.

**Probe further:** Home shows nothing for an unscheduled class (the ADR lists that item as planned). Report **MISSED-OPPORTUNITY** if a draft sits unnoticed.

## CL-09 — Publishing a draft without times is refused

**Steps:**

1. As H2, try to publish `qa-CL-08` without a Start date.
2. Via `evaluate_script`, PATCH `crud-with-plan` with `status: "SCHEDULED"` and no `startDate`.

**Expect:** refused (record status, code, copy); still DRAFT. The editor's "Required before publishing." should explain it before the save.

## CL-10 — Editing a published class's start date before anyone buys

**Steps:**

1. As H2, change `qa-CL-01`'s Start date to the following Wednesday 19:00. Save.
2. Read the occurrences.

**Expect:** the series is regenerated: 8 sessions on Wednesdays and Saturdays 19:00 IST (13:30Z) (gap 3), old rows gone or replaced (record ids). R-05 zero rows.

**Probe further:** after a seat sells (CL-27), the same edit must be refused ("Cannot modify class schedule with enrolled participants. Use the reschedule workflow instead."; CL-44). Check that the copy then points at **Move upcoming sessions**, not "the reschedule workflow".

## CL-11 — Status changes only through the cancel door

**Steps:** `PUT /api/bookings/classes/[classId]` with `{ "status": "CANCELLED" }`, then `{ "status": "COMPLETED" }`.

**Expect:** 409 `USE_CANCEL_ROUTE`, "Cancel a class through its cancel action, not an update." No change.

## CL-12 — The org catalog creates a class as a draft with the cadence rules

**Steps:**

1. As OH, `POST /api/organizations/[LearnPro id]/catalog` with `kind: "CLASS"`, OX as expert, `sessionsPerWeek: 2`, `sessionDurationInHours: 1`, `durationInMonths: 1`.
2. Repeat with `sessionsPerWeek: 2.5` and `sessionDurationInHours: 0.75`.

**Expect:** 1 → 201; `ClassPlan.totalSessions = 8`; a `Class` row `DRAFT` with no sessions and `schedulingTimezone` = OX's zone. 2 → 400 (cadence schema). OX sees "Schedule now" on the class.

**Probe further:** can OH schedule it (host-org operator), or only OX? Host-org operators allocate only inside published availability (`override` is expert and staff only), so OH's pattern save with `override: true` should be stripped. Try it and record.
