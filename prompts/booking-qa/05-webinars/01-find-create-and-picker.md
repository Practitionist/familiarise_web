# 05-a · Webinars: finding the editor, the host time picker and the event-time rules

**Needs:** F-AV2 (H2), F-AV4 (H4), F-PL2 webinars. At least one confirmed H2 session in the next week (B2's `qa-SU-14` sessions from 04, or F-PL2's class series) for the Busy cases. Preview OK (no money).
**Personas:** H2 (IST) host; H4 (Asia/Kathmandu) for the lattice; OH (LearnPro owner) for the org catalog door; B2 (Europe/London) and B3 (America/Los_Angeles) to read the public page.
**Docs under test:** decisions 1–3 of `docs/decisions/2026-11-09-scheduling-surfaces-and-feasibility.md`; `lib/booking/event-time-rules.ts`; `lib/scheduling/single-session-options.ts`; `components/scheduling/SingleSessionPicker.tsx`; `app/api/bookings/webinars/crud-with-plan/route.ts`.

H2's published hours (IST): Mon/Wed/Fri 18:00–21:00, Tue/Thu 07:00–09:00. Zone line for this file: Wed 18:00 IST = 12:30Z = 12:30 London = 04:30 Los Angeles = 07:30 New York; Tue 07:00 IST = 01:30Z = Monday 17:30 in Los Angeles.

**The event-time rules (server):** a host-set start sits on the UTC half hour and at least 1 hour ahead (24 hours for a re-time); the end is start + duration in minutes. A refusal is 400 `{ error, code: "EVENT_TIME_INVALID" }` with one of: "Pick a start time on the hour or half hour.", "Pick a start time at least 1 hour from now.", "The start time could not be read. Pick the date and time again."

**The picker labels:** every half-hour start of the chosen day is listed with **Free** (inside published hours, nothing booked), **Outside your hours** (pickable), **Busy** (overlaps a booking; not pickable), **Too soon** (inside the lead; not pickable), or **Not allowed** (outside an allowed window; make-ups and re-times only). Help text: "Times are in <zone>. Free means inside your published hours with nothing booked; you can still run an event outside your hours. Each session lasts <N> minutes."

These label rules are owned here; 06 (class make-up and pattern rows) references them.

## WE-01 — Can a host find where webinars are created and scheduled?

**Why it matters:** decision 4 keeps "the grid made discoverable" as the fallback if hosts can't find scheduling. Discoverability is part of the product under test.

**Steps:**

1. As H2, sign in and land on Home. Without typing URLs, find how to create a webinar. Count the clicks and write down each label you clicked.
2. From the same Home, find where an existing webinar's time is changed (scheduled, unsold) and where a sold one is moved.
3. Visit, and record what each offers for webinars: `/dashboard/consultant/[H2 cid]/sell/programs` (title "Group programs", tabs Webinars / Classes), the Offerings card for a webinar, `/dashboard/consultant/[H2 cid]/appointments` (row menu), the webinar's appointment detail page.

**Expect:**

- A path from Home to the editor at `/dashboard/consultant/[cid]/offerings/webinar/new` exists through Sell → Group programs (record the exact entry labels).
- An unscheduled webinar's Offerings card reads "Not scheduled yet · **Schedule now**", linking to `/dashboard/consultant/[cid]/appointments/unscheduled-webinar-<id>/timings`. In Appointments its primary action is **Set schedule**.
- A scheduled unsold webinar offers **Timings** in its Appointments row menu; a sold one offers **Move to a new date** instead (WE-29).

**Probe further (report anything odd):**

- Is "Schedule now" the only discovery path for an unscheduled webinar? Home has no "Needs you" item for it (the ADR lists the class one as planned). **MISSED-OPPORTUNITY** if Home is silent while a draft sits unscheduled.
- Three names for the scheduling surface: "Timings", "Manage timings" (page title), "Set schedule". Plus "Move to a new date" (menu and refusal copy); "Re-time" survives only in the toast title. Log every name you meet.
- Is the event planner page (`…/planner`) still reachable for webinars? If so, does it use the same picker?

## WE-02 — The picker's layout, labels and zone

**Why it matters:** the picker replaced a browser-zone date input that let hosts pick blind.

**Steps:**

1. As H2, open the webinar editor (new webinar `qa-WE-02`, Duration 1.5 h). Go to **Sessions** → **Scheduled for**.
2. Read the help text. Move through the day strip with **Earlier days** / **Later days**.
3. On next Monday, read the label of every start from 17:00 to 21:00.
4. On next Saturday, read a few labels.
5. Tab into the day strip and the time list; use arrow keys.

**Expect:**

- Help text: "Times are in Asia/Kolkata. Free means inside your published hours with nothing booked; you can still run an event outside your hours. Each session lasts 90 minutes."
- Monday: 17:00 and 17:30 **Outside your hours** (the session starts before 18:00); 18:00, 18:30, 19:00, 19:30 **Free** (they end by 21:00); 20:00 and later **Outside your hours** (they run past 21:00). Times shown in IST.
- Saturday: every start **Outside your hours** (no Saturday hours), all pickable.
- The selected start is visibly marked and has an accessible "selected" state; the day strip and the list are reachable by keyboard.

**Probe further:**

- Change Duration to 1 h after picking 19:30: do the labels recompute (19:30 → 20:30 Free, 20:00 → 21:00 Free)?
- At 390×844, is the picker usable without horizontal scroll (beyond the intended day strip)? 13 owns the full sweep.
- Is "Outside your hours" visually distinct from "Busy" without colour alone?

## WE-03 — Too soon: nothing inside the hour

**Steps:**

1. As H2, in the editor's picker, open **today**. Read the labels around now.

**Expect:** every start earlier than now + 1 hour is **Too soon** and not selectable; the first start at or after now + 1 h (on the half hour) is selectable. Past starts are Too soon too (record whether past starts are listed at all).

**Probe further:** leave the editor open for 20 minutes, then save: if the picked start has fallen inside the hour, the server answers 400 "Pick a start time at least 1 hour from now." Does the editor show that in words and refresh the labels?

## WE-04 — Busy: the host's own bookings are unpickable, inside or outside published hours

**Why it matters:** the picker must never offer a time the server will refuse for a clash.

**Setup:** an H2 confirmed session at a known time inside published hours (for example B2's `qa-SU-14` session Monday 18:00–20:30 IST). Then, as H2, publish a free 60-minute webinar `qa-WE-04` at next Saturday 11:00 IST (outside hours).

**Steps:**

1. In a new webinar's editor, set Duration 1.5, then open the picker on that Monday. Read 16:30–20:30.
2. Open that Saturday. Read 10:00–12:00.

**Expect:**

- Monday: any 90-minute start overlapping 18:00–20:30 is **Busy** and not selectable (16:30 → 18:00 is not Busy; 17:00 is).
- Saturday: 10:00, 10:30, 11:00, 11:30 are **Busy** (the booked webinar shows as a synthesized booked cell even outside published hours); 09:30 is Outside your hours.

**Probe further:** reload after 05's or 06's activity has added sessions: does the picker refresh on focus, or can it be stale? If you pick a stale Free start that is now booked, the save returns 409 (WE-12).

## WE-05 — Publish a 90-minute priced webinar

**Why it matters:** the happy path, and the 90-minute end that used to come out at 60.

**Steps:**

1. As H2, new webinar `qa-WE-05`: price ₹500, Duration 1.5, Max participants 5, a topic, Scheduled for next Wednesday 18:00 (Free). Publish.
2. Check the network response and the DB.
3. As B2 (London), open the public webinar page. As B3 (LA), the same.

**Expect:**

- API: `POST /api/bookings/webinars/crud-with-plan` → 2xx.
- DB: `WebinarPlan.durationInHours = 1.5`, `maxParticipants = 5`; `Webinar.status = SCHEDULED`; one `Appointment` (`appointmentType = WEBINAR`) with one occurrence: `startsAt` = 12:30Z (a :00/:30 UTC instant), `endsAt − startsAt = 90 min`, `consultantProfileId` = H2, `isTentative = false`; an H2 `CONSULTANT` participant row. R-05 for H2 → zero rows.
- B2 sees Wednesday 12:30–14:00; B3 sees Wednesday 04:30–06:00 (record whether a zone label is shown).

**Cross-check:** H2's Appointments lists it; the Offerings card shows the start in H2's zone; `sell/programs` → Webinars tab lists it with seats 0/5.

**Probe further:**

- The Offerings card formats the start with the **browser** locale and zone (`toLocaleString`). Emulate a different browser zone: does the card disagree with the appointment page? **INCONSISTENCY** (10 owns the matrix).
- Keep `qa-WE-05`: 02-, 03- and 04- files sell, re-time and cancel it.

## WE-06 — A start outside published hours is allowed

**Steps:**

1. As H2, new free webinar `qa-WE-06`, 1 h, next Sunday 10:00 IST (Outside your hours). Publish.

**Expect:** 2xx; `Webinar.status = SCHEDULED`; occurrence 04:30Z–05:30Z. No warning blocks the save.

**Probe further:** does any surface tell H2 "this is outside your published hours" after saving (a gentle note)? Optional, but a buyer's expectation of "this expert's hours" may differ.

## WE-07 — The server refuses off-lattice, too-soon and unreadable starts

**Why it matters:** the picker is a convenience; the server is the guard.

**Steps (as H2, `evaluate_script`, using the `qa-WE-05` request body from the network panel with a new title each time):**

1. `scheduledAt` = now + 30 minutes, on a UTC half hour.
2. `scheduledAt` = a time ending :15 UTC (e.g. `…T12:45:00.000Z`), 2 days ahead.
3. `scheduledAt` = `"tomorrow at six"`.
4. `scheduledAt` = a valid lattice time 2 days ahead, `durationInHours: 0.75`.

**Expect:**

- 1 → 400 `EVENT_TIME_INVALID`, "Pick a start time at least 1 hour from now."
- 2 → 400 `EVENT_TIME_INVALID`, "Pick a start time on the hour or half hour."
- 3 → 400 (Zod: "Invalid input" with "Invalid date format for scheduledAt" in `details`); record the body.
- 4 → 400 "Invalid input", details "Duration must be in 30-minute increments".
- DB: no new webinar for any of them.

**Probe further:** case 3 answers with `details` (developer text) rather than a plain message. Would the editor ever surface it? Note for 13.

## WE-08 — The end is always start + minutes; a duration-only edit moves the end

**Steps:**

1. As H2, edit `qa-WE-06` (unsold): change Duration from 1 to 2. Save.
2. Change it to 1.5. Save.

**Expect:** each save keeps `startsAt` and sets `endsAt = startsAt + 120 min`, then + 90 min. Both ends on the half hour.

**Probe further:** making a webinar longer can run it into a booking right after it. Make `qa-WE-06` run into `qa-WE-04`'s Saturday slot (if days align) or any H2 booking: expect 409 "That time conflicts with another confirmed session on your calendar." and no change.

## WE-09 — Kathmandu host: the lattice is :15/:45 local

**Why it matters:** UTC+05:45 puts every legal start at :15 or :45 local. The server, the picker and the editor's form schema agree: the schema checks the UTC lattice, not the browser's minutes.

**Steps:**

1. As H4 (profile zone Asia/Kathmandu), open the webinar editor. Read the picker's start list for a weekday 09:00–13:00.
2. Pick 10:15 local (04:30Z). Publish `qa-WE-09`.
3. Repeat step 2 with the browser emulated to `Asia/Kathmandu` (DevTools MCP `emulate`), if supported.
4. Via `evaluate_script`, POST with `scheduledAt` = 10:00 local (04:15Z).

**Expect:**

- Step 1: starts listed at :15 and :45 local. 10:15 and 10:45 Free (10:15–11:15, inside 10:00–12:00); 10:00 not listed.
- Step 2: 2xx; occurrence 04:30Z.
- Step 3: the same result as step 2 with a Kathmandu browser; the form does not refuse 10:15 (`isOnEventLattice` in `schemas/plans.ts` checks the ISO instant in UTC), and the form no longer checks the one-hour lead (the server does). A client-side "Please select either :00 or :30" refusal is a **BUG** (P1 for Kathmandu hosts); attach the screenshot.
- Step 4: 400 `EVENT_TIME_INVALID`, "Pick a start time on the hour or half hour."

**Probe further:** step 4's server message says "on the hour or half hour" while the only legal choices on screen are :15/:45 local. Record it as **COPY** (P3) for this host.

## WE-10 — Editing a webinar that starts within the hour

**Why it matters:** the editor resends the stored time on every save; an unchanged time must not be re-judged (the server says so).

**Setup:** an unsold webinar of H2 (`qa-WE-06`). Owner-approved: move its occurrence to start 45 minutes from now (UTC half hour), end + 60 min.

**Steps:**

1. As H2, open its editor. Change only the title. Save.
2. Via `evaluate_script`, PATCH `/api/bookings/webinars/crud-with-plan` with the stored `scheduledAt` and a new title.

**Expect:**

- Step 2: 200 (the PATCH runs the time rules only for a changed time).
- Step 1: should match step 2. The client schema refines "Start time must be at least 1 hour in the future" on every save, so expect the editor to block the title edit. Report **BUG** (P2): the server allows it, the form doesn't.

**Probe further:** what can H2 do with a webinar starting in 45 minutes? Cancel only (re-time needs 24 h). Does the editor say so?

## WE-11 — Changing an unsold webinar's time

**Steps:**

1. As H2, edit `qa-WE-06`: pick a new Free start 2 days out. Save.
2. PATCH with an off-lattice `scheduledAt` (:15 UTC).

**Expect:**

- Step 1: 200; the occurrence moves (same row updated, or a replacement; record which, with ids). R-05 zero rows.
- Step 2: 400 `EVENT_TIME_INVALID`, "Pick a start time on the hour or half hour."

**Probe further:** no attendee is notified (nobody bought). If H2 has a co-host, is the co-host told?

## WE-12 — A webinar over the host's own 1:1 is refused

**Why it matters:** one host can't be in two sessions at once (R-05).

**Setup:** an H2 1:1 session (B2's `qa-SU-14` subscription session, Monday 18:00–20:30 IST).

**Steps:**

1. In the picker, confirm Monday 18:00 is Busy.
2. Via `evaluate_script`, POST a new webinar with `scheduledAt` = that Monday 18:00 IST (12:30Z), 60 minutes.

**Expect:**

- API: 409 with `error` "That time conflicts with another confirmed session on your calendar." (no `code` field on this route).
- DB: no webinar row; R-05 zero rows.

**Probe further:** the re-time door answers the same clash with `code: "SCHEDULE_CONFLICT"` (WE-36). This route sends no code. Log the inconsistency.

## WE-13 — The org catalog door creates webinars without the 30-minute rule

**Why it matters:** decision 7 says every plan door parses one cadence schema. The org catalog's webinar arm reads `durationInHours: z.number().positive()`.

**Setup:** OH (LearnPro OWNER) with `catalog.manage`, an OX expert.

**Steps:**

1. As OH, `POST /api/organizations/[LearnPro id]/catalog` with `kind: "WEBINAR"`, `durationInHours: 0.75`, OX as the expert, and the other required fields (copy them from the catalog UI's request if one exists).
2. Read the response and the DB.

**Expect (per decision 7):** 400 with a 30-minute-steps message. If the route answers 201 and stores `durationInHours = 0.75`, report **BUG** (P2) and note that the created `Webinar` is `DRAFT` with no session.

**Probe further:** schedule that 45-minute draft through Manage timings: how many 30-minute atoms does it take, and when does it end?

## WE-14 — Unverified or foreign profile can't create

**Steps:**

1. As H2, POST a webinar with H3's `consultantProfileId`.
2. If a QA consultant without verification exists (check `ConsultantProfile` verification fields with SQL), POST as them.

**Expect:** 1 → 403 "You do not have permission to create webinars for this consultant profile". 2 → 403 `{ error: "Verification required", message, verificationStatus }`.

**Probe further:** does the editor tell an unverified host up front, or only after they fill everything in?
