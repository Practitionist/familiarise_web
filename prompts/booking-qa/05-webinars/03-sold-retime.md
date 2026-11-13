# 05-c · Webinars: a sold webinar is re-timed, never re-planned

**Needs:** `qa-WE-05` with B2 and B3 seated (WE-19), session more than 48 h away (shift with owner approval if needed, keeping UTC half hours). An unsold webinar (`qa-WE-06`). **[local]** for the refund cases.
**Personas:** H2 (IST) host; B2 (Europe/London), B3 (America/Los_Angeles) buyers; B1 (IST) for a seat bought after a move; ST; H1 for an attendee clash.
**Docs under test:** decisions 1, 2 and 5 of the scheduling ADR; `lib/booking/allocation/guards.ts` (`assertGroupEventUnsoldInTx`); `lib/booking/event-retime.ts` (`retimeWebinar`); `lib/booking/retime-leave.ts`; `lib/booking/seat-leave.ts`; `app/api/appointments/[appointmentId]/retime/route.ts`; the timings page `app/dashboard/consultant/[consultantId]/(features)/appointments/[appointmentId]/timings/page.tsx`.

**Rule:** once a webinar has a live buyer seat (a `CONSULTEE` participant that is HELD, CONFIRMED or ATTENDED), nothing may re-plan it through Manage timings or the allocator (409 `USE_RETIME`). The host moves it with **Move to a new date** (re-time): at least 24 h ahead on the UTC half hour, same occurrence row, `movedAt` set, buyers told, and every seat bought before the move may leave with a full refund until `Webinar.retimeBy` = min(now + 7 days, new start).

## WE-29 — The menu hides Timings once a seat is sold

**Steps:**

1. As H2, open Appointments. Open the row menu of `qa-WE-05` (sold) and of `qa-WE-06` (unsold; only H2's own host participant).

**Expect:**

- Sold: no **Timings**; **Move to a new date** present; Cancel booking present.
- Unsold: **Timings** present (the host's own participant row is not a sale).

**Probe further:** does the unsold row also offer Move to a new date? If both doors exist for an unsold webinar, which should a host use? Note it.

## WE-30 — Manage timings on a sold webinar shows a stop panel

**Steps:**

1. As H2, open `/dashboard/consultant/[H2 cid]/appointments/[qa-WE-05 aid]/timings` directly.
2. Click the button.

**Expect:**

- Panel title "This event already has booked seats"; body "Its times can't be re-planned here, because that would move people who already paid without notice. Use "Move to a new date" (a webinar) or "Move upcoming sessions" (a class) on the event page instead: attendees are told, and anyone who can't make the new time may leave with a full refund."; button **Open the event** → the appointment detail.

**Probe further:** the panel, the menu and the refusal sentences now all say "Move to a new date" (the dialog says "Move this webinar to a new date"). Any surface that still tells the host to use "Re-time", a name no button has, is **COPY / INCONSISTENCY** (P2); the toast title is the known one.

## WE-31 — The allocator refuses a sold webinar with USE_RETIME

**Steps:**

1. As H2, `PATCH /api/bookings/webinars/[webinarId]/allocate` with `{ isAuto: false, slots: [<two new lattice atoms 3 days out>] }` and an `Idempotency-Key`.
2. Same with `{ isAuto: true }`.
3. Run R-03 before and after.

**Expect:**

- 409, `errorCode: "USE_RETIME"`, `error` "This webinar already has 2 booked seats, so its times can't be re-planned. Use \"Move to a new date\" to move it: attendees are told and may leave with a full refund." In the UI the toast title is "This event already has booked seats — use Re-time".
- DB unchanged (same occurrence id and times).

**Probe further:** with only a `HELD` seat (a pending card payment), is the refusal the same? It should be (HELD counts as live). Use a fresh buyer, stop before paying.

## WE-32 — The editor can't move a sold webinar's time

**Steps:**

1. As H2, open `qa-WE-05`'s editor. Change **Scheduled for** to another Free start. Save.
2. Change only the title. Save.

**Expect:**

- Step 1: 409 "Cannot reschedule a webinar with confirmed bookings. Use the reschedule workflow instead." No change.
- Step 2: 200.

**Probe further:** the message points to "the reschedule workflow", but a webinar never reschedules (the reschedule route answers `USE_RETIME`, WE-33). Report **COPY** (P2): it should name Move to a new date. Does the editor at least disable the picker for a sold webinar?

## WE-33 — The reschedule door refuses a webinar

**Steps:** as H2 and as B2, `POST /api/appointments/[qa-WE-05 aid]/reschedule` with any body.

**Expect:** 400 `USE_RETIME`, "Pick the webinar's new date with \"Move to a new date\" instead." (for B2, a 403/404 first is also acceptable; record it). B2's UI offers no Reschedule for a webinar seat.

**Probe further:** the copy speaks to a host; B2 receiving it would be confused.

## WE-34 — Re-time a sold webinar

**Why it matters:** the one legitimate way to move paid attendees.

**Steps:**

1. As H2, row menu → **Move to a new date**. Read the dialog.
2. In the picker (purpose re-time), look at today and tomorrow in the month, then a day 3 days out.
3. Pick a free start 3 days out (e.g. Friday 19:00 IST = 13:30Z). Click **Move webinar**.
4. Read the response. Run R-03.
5. As B2 and B3, open the bell, the booking and the outbox (R-07).

**Expect:**

- Dialog: title "Move this webinar to a new date", text "Everyone enrolled is told and keeps their seat. Anyone who can't make the new time can leave with a full refund." and a link to **Cancel booking** for ending it instead. Buttons **Keep the date** / **Move webinar**.
- Picker: no start before now + 24 h is listed (today, and tomorrow before the same hour, show nothing or only later starts); H2's other bookings are tagged **Booked**; the webinar's own current session reads free (the dialog passes it as a move).
- API: `POST /api/appointments/[aid]/retime` `{ startsAt }` → 200 with `retimeBy` and the clash count.
- DB: the **same** occurrence id; `startsAt` 13:30Z, `endsAt` + 90 min; `movedAt` set; `Webinar.retimeBy` = min(now + 7 days, new start). Seats unchanged. R-05 zero rows.
- Buyers: one notice each ("rescheduled", with a leave-by date); B2 sees Friday 13:30 London, B3 Friday 05:30 LA, both with the date they can leave by.

**Cross-check:** H2's Appointments shows the new time; Offerings card too; the public page shows the new time to a new visitor; staff view.

**Probe further:**

- Does the buyer notice say "leave with a full refund until <date>" with the date in the buyer's zone?
- Does the waitlist (if any) hear about the move?

## WE-35 — An attendee who clashes at the new time is flagged, not blocking

**Setup:** B2 holds an H1 consultation (03, [local]) at time X, 3 days out, on a UTC half hour, outside H2's bookings.

**Steps:** as H2, re-time `qa-WE-05` to X.

**Expect:** 200; the response counts 1 attendee with a clash; B2's notice is the clash variant (record copy); B3's is the plain one. Nothing is refused.

**Probe further:** does H2 see who clashes (name or just a count)? Does B2's notice tell them which booking clashes?

## WE-36 — Re-time refusals

**Steps (as H2 unless stated; via the dialog where possible, else `evaluate_script`):**

1. Shift `qa-WE-05` to start in 20 hours (owner-approved). Try to re-time it.
2. Restore it to 3+ days out. Re-time to a start 10 hours from now.
3. Re-time to a :15 UTC start 3 days out.
4. Re-time to a time H2 is busy (a `qa-SU-14` session or another webinar).
5. Re-time a DRAFT webinar.
6. As ST, call the retime route.
7. As B2, call it.
8. Send `{ "startsAt": "friday" }`.

**Expect:**

- 1 → 409 `RETIME_TOO_SOON`, "A webinar can't be re-timed within 24 hours of its start. Cancel it instead — everyone is refunded in full."
- 2 and 3 → 409 `RETIME_TOO_SOON`, "Pick a new time on the half hour, at least 24 hours away."
- 4 → 409 `SCHEDULE_CONFLICT`, "That time conflicts with another confirmed session on your calendar."
- 5 → 409 `RETIME_NOT_ALLOWED`, "Only a published webinar with an upcoming session can be re-timed."
- 6 → 403 `RETIME_HOST_ONLY`, "Only the webinar's host can move it to a new date. From the back office you can cancel it instead, and everyone is refunded in full."
- 7 → 404 "Only the webinar's host can re-time it."
- 8 → 400 `INVALID_RETIME`, "Pick the new date and time."
- No DB change in any case.

**Probe further:** the ADR and the PR describe an off-grid re-time as 400 `EVENT_TIME_INVALID`; the code answers 409 `RETIME_TOO_SOON` with a message about both rules. Report **DOC-DRIFT** and note the code name is misleading for an off-grid time.

## WE-37 — Re-time twice: the free leave lengthens, never shortens

**Steps:**

1. Re-time `qa-WE-05` to 3 days out (`retimeBy` R1 = new start, since that is under 7 days).
2. Re-time again to 10 days out.
3. Re-time again to 4 days out.

**Expect:** `retimeBy` after step 2 = now + 7 days (R2 > R1); after step 3 it stays R2 if R2 is later than the new value (`extendRetimeLeave` never shortens), even though the session now starts before R2. Record the values.

**Probe further:**

- After step 3, `retimeBy` can sit **after** the session's start. Can a buyer then "leave with a full refund" after the webinar has happened? Try it (shift the session into the past) and report.
- There is no cap on re-times. A host can move a webinar every day. Is that intended? Note it for the owner.

## WE-38 — Free leave before retimeBy, even inside the normal window [local]

**Setup:** `qa-WE-05` re-timed to start in 30 hours from now (new start ≥ 24 h at move time); B3 bought before the move. Then shift it (owner-approved) to start in 10 hours, keeping `retimeBy` in the future.

**Steps:**

1. As B3, open the booking. Read the cancel/leave dialog ("Leave webinar?" or similar; record).
2. Leave.

**Expect:**

- Dialog quotes a full refund (record the line).
- DB: B3's participant `REFUNDED` (or released), a `Refund` for the whole seat under `dedupeKey` `seat-leave:<participantId>`; seats left +1; waiters notified (WE-23).
- Without the move, 10 hours out would be refused (WE-47).

**Probe further:** does the dialog say *why* B3 gets a full refund ("the host moved this webinar")?

## WE-39 — After retimeBy, the normal window applies again

**Setup:** shift `Webinar.retimeBy` into the past (owner-approved), session still 10 h away.

**Steps:** as B2, try to leave.

**Expect:** 409 `REFUND_WINDOW_CLOSED`, "Free cancellation ended 24 h before the start — this seat can no longer be refunded." Seat kept.

**Probe further:** what does B2's booking say about leaving now? See WE-47 for the copy mismatch.

## WE-40 — A seat bought after the move gets no free leave

**Setup:** `qa-WE-05` re-timed (retimeBy in the future). B1 buys a seat after the move [local]. Shift the session to 10 h away.

**Steps:** as B1, try to leave.

**Expect:** 409 `REFUND_WINDOW_CLOSED` (B1 bought knowing the new time; `movedAt` is before B1's seat).

**Probe further:** does B1's checkout mention that the webinar was moved?

## WE-41 — Unsold webinar: re-time vs Timings

**Steps:**

1. As H2, on `qa-WE-06` (unsold), use **Timings** to move it 2 days later. Record `movedAt` and `retimeBy`.
2. Use **Move to a new date** (if offered) to move it again.

**Expect:**

- Step 1: the occurrence moves (allocator path); `movedAt` and `retimeBy` stay null (nobody to tell).
- Step 2: moves; `movedAt` and `retimeBy` set although nobody holds a seat (record).

**Probe further:** if a buyer then purchases, does a stale `retimeBy` from an unsold move give them a free leave they shouldn't have? (`inRetimeFreeLeave` needs the seat to predate the move, so expect no.)
