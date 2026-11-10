# 06-d · Classes: a sold class moves as a series

**Needs:** a sold class: `qa-CL-38` = H2, 2/week × 1 month × 60 min (8 sessions), ₹800, capacity 5, first session 3+ days out, with B2 and B3 seated [local]. Owner-approved clock shifts to put some sessions inside 24 h. H3 accepted as Co-Instructor for CL-48.
**Personas:** H2 (IST) host; B2 (Europe/London), B3 (America/Los_Angeles), B1 (IST) buyers; H3 (America/New_York) co-host; ST.
**Docs under test:** decisions 1 and 5 of the scheduling ADR; `lib/booking/allocation/guards.ts` (`assertGroupEventUnsoldInTx`); `lib/booking/class-retime.ts` (`retimeClassSeries`, `movableClassSessions`); `app/api/appointments/[appointmentId]/retime-series/route.ts`; `components/appointments/detail/ClassSeriesRetimeButton.tsx`; `lib/booking/retime-leave.ts`.

**Rule:** once a class has a live buyer seat, the allocator refuses a re-plan with 409 `USE_RETIME` (a top-up that only appends sessions is allowed). The host moves future sessions with **Move upcoming sessions** on the class detail page: every session at least 24 h away moves **in place** (same ids and ordinals) to a new pattern; nearer sessions keep their time; `movedAt` set, `isTentative = false`; **no** `hostCancelledAt` (a move is not a miss); `Class.retimeBy` = min(now + 7 days, the first new start); every seat bought before the move may leave with a full refund until `retimeBy`.

Dialog text: title "Move upcoming sessions", "Pick a new weekly pattern. Every session at least 24 hours away moves to it; anything sooner keeps its time. Learners are told, keep their seats, and anyone who can't make the new times can leave with a full refund." The pattern scheduler inside runs in re-time mode (Too soon = inside 24 h) and its button reads **Move <k> sessions**. With nothing movable: "No session is at least 24 hours away. Cancel a session and schedule a make-up instead."

After every move: R-03, R-05; record `movedAt`, `hostCancelledAt`, `retimeBy`.

## CL-38 — A sold class: no Timings, and the allocator says USE_RETIME

**Steps:**

1. As H2, open Appointments; open `qa-CL-38`'s row menu.
2. `PATCH /api/bookings/classes/[classId]/allocate` with a manual body of 16 new atoms, then with `{ isAuto: true }`.

**Expect:**

- Menu: no **Timings** (record what is there).
- API: 409 `errorCode: "USE_RETIME"`, "This class already has 2 booked seats, so its times can't be re-planned. Use Re-time to move it: attendees are told and may leave with a full refund." No change (R-03).

**Probe further:** the refusal says "Use Re-time"; the button is "Move upcoming sessions". **COPY** (P2), as CL-26.

## CL-39 — A top-up is still allowed on a sold class

**Why it matters:** appending missing sessions isn't a re-plan.

**Setup:** owner-approved: tombstone `qa-CL-38`'s last occurrence (`deletedAt = now()`) so the class holds 7 of 8.

**Steps:** as H2, `PATCH …/allocate` with `{ isAuto: false, topUp: true, slots: <2 atoms for one new session after the last> }`.

**Expect:** 200; 8 live sessions; the 7 existing ids unchanged. Without `topUp: true` → 409 `USE_RETIME`.

**Probe further:** is there any UI path to a top-up for a sold class, or is it API-only? A host whose class lost a session (ops void) needs one.

## CL-40 — Open the series move and read what it will touch

**Steps:**

1. As H2, open `qa-CL-38`'s detail page → **Move upcoming sessions**. Read the dialog.
2. Check `GET /api/appointments/[aid]/retime-series` in the network panel.

**Expect:** GET → 200 `{ count: 8, sessionMinutes: 60, firstStartsAt }` with `Cache-Control: private, no-store`. The scheduler asks for 8 times (header "<k> of 8 sessions"), First possible day = today + 24 h in IST, rows defaulting to the plan cadence.

**Probe further:** does the dialog list which sessions are staying (the ones inside 24 h)?

## CL-41 — Move the series

**Steps:**

1. In the dialog, pick **Tue 07:00** and **Fri 19:00** starting 3 days out. Read the preview labels.
2. Click **Move 8 sessions**.
3. Read the toast. Run R-03.
4. As B2 and B3, open the bell, the class and R-07.

**Expect:**

- Toast "8 sessions moved — learners have been told".
- API: `POST /api/appointments/[aid]/retime-series` `{ starts: [8 ISO] }` → 200 `{ moved: 8, retimeBy, attendeesWithClash }`.
- DB: the **same 8 occurrence ids and ordinals**, new `startsAt` (Tue 01:30Z, Fri 13:30Z), same lengths, `movedAt` set, `isTentative = false`, `hostCancelledAt` null. `Class.retimeBy` = min(now + 7 d, first new start). R-05 zero rows. No `Refund` rows (nobody left yet).
- Buyers: one notice each ("rescheduled", with a leave-by date); B2 sees Tue 01:30 / Fri 13:30 London; B3 sees **Mon** 17:30 / Fri 05:30 LA.

**Cross-check:** H2's Appointments and calendar; the public batch card (weekday label now "Tuesdays…"/"Varies"); staff view.

**Probe further:**

- The retime POST carries no `Idempotency-Key` (the allocate path does). Double-click **Move**: does the second POST fail cleanly ("This class changed while you were moving it. Refresh and try again." or a count mismatch), or move twice? Record.
- B3's Tuesday 07:00 IST sessions fall on Monday evening in LA. Does B3's notice make the weekday change clear?

## CL-42 — Sessions inside 24 hours keep their time

**Setup:** a fresh sold copy (`qa-CL-42`, B2 seated) whose first session is shifted (owner-approved) to 10 h from now.

**Steps:** open Move upcoming sessions; read the count; move the rest.

**Expect:** GET `count: 7`; the scheduler asks for 7; after the move the first session is unchanged (no `movedAt`), sessions 2–8 moved in place.

**Probe further:** the first session may now be **after** a moved session (e.g. a moved session lands earlier in the same week). Check ordinals vs time order and the per-day cap (2) on that day.

## CL-43 — Series move refusals

**Steps (as H2 unless stated; `evaluate_script` on the retime-series POST):**

1. Send 7 starts when 8 are movable.
2. Send 8 starts where two overlap (same time, or 60-minute sessions 30 minutes apart).
3. Send one start 10 h from now.
4. Send one start at :15 UTC.
5. Move a DRAFT class.
6. Move a class whose sessions are all inside 24 h.
7. Send a start where H2 is busy (an H2 1:1 or webinar).
8. As ST, as B2.
9. Send `{ "starts": ["monday"] }`.

**Expect:**

- 1 → 409 `RETIME_NOT_ALLOWED`, "Pick 8 new times, one for each session at least 24 hours away."
- 2 → 400 `EVENT_TIME_INVALID`, "Two of the new times overlap. Space the sessions apart."
- 3 → 400 `EVENT_TIME_INVALID`, "Pick a start time at least 24 hours from now."
- 4 → 400 `EVENT_TIME_INVALID`, "Pick a start time on the hour or half hour."
- 5 → 409 `RETIME_NOT_ALLOWED`, "Only a published class with upcoming sessions can be moved."
- 6 → 409 `RETIME_NOT_ALLOWED`, "No session is at least 24 hours away, so there is nothing to move. Cancel a session and schedule a make-up instead." (the dialog shows its own variant).
- 7 → 409 `SCHEDULE_CONFLICT`, "One of the new times conflicts with another confirmed session on your calendar."
- 8 → 403 "Only the class host can move its sessions".
- 9 → 400 "Send the new start times as ISO 8601 strings."
- No DB change in any case.

**Probe further:** the server doesn't re-check the class per-day cap here. Send 8 starts with 3 on one day: accepted? A class meets at most twice a day (`MAX_CLASS_SESSIONS_PER_DAY`). Report **BUG** (P2) if 3 land on one day.

## CL-44 — The editor can't move a sold class's dates

**Steps:** as H2, change `qa-CL-38`'s Start date in the editor. Save. Then change only the title.

**Expect:** the date change → 409 "Cannot modify class schedule with enrolled participants. Use the reschedule workflow instead."; title → 200.

**Probe further:** the copy points to "the reschedule workflow"; for a class the reschedule route answers 400 `USE_SESSION_CANCEL` ("Move a class session by cancelling it and scheduling a make-up."). Neither names **Move upcoming sessions**. **COPY** (P2).

## CL-45 — Swap-style move: session 2 takes session 3's old time

**Why it matters:** an in-place move must not trip the overlap constraint against the series' own old rows.

**Setup:** move `qa-CL-38` (or a sold copy) to **Tue 07:00 and Fri 07:00** (three days apart, every session at least 24 h away).

**Steps:** move again to **Fri 07:00 and Mon 07:00**, starting with the first Friday of the old series, so session 1 takes session 2's old time, session 2 takes session 3's, and so on. (07:00 on Fri/Mon is outside H2's hours: labelled, allowed.)

**Expect:** 200; same ids; R-05 zero rows. A 409 here is **BUG** (P1: the move lifts rows out of the constraint inside one transaction).

## CL-46 — The free leave after a move [local]

**Setup:** after CL-41, B3 (bought before the move). Shift the next session (owner-approved) to 10 h away, keeping `retimeBy` ahead.

**Steps:** as B3, open the leave dialog; leave.

**Expect:** a full refund of what is undelivered (the dialog quotes it), even inside 24 h. `Refund` under `seat-leave:<participantId>`.

**Probe further:** compare with a seat bought after the move (B1): the same leave inside 24 h → refused or class quote, not full.

## CL-47 — A move records no miss and doesn't count toward the exit right

**Steps:** after CL-41 and CL-45, read the class's miss ledger: `SELECT "hostCancelledAt","voidedAt","movedAt" FROM "AppointmentOccurrence" WHERE "appointmentId" = :aid;` and the learners' exit option.

**Expect:** `hostCancelledAt` null everywhere; no exit option offered to learners; no `class-reliability:<classId>` `SystemEvent`.

**Probe further:** move the series 3 times in 30 days: still no exit right (decision 5). Is there any cap on series moves? Note it for the owner.

## CL-48 — A busy co-host blocks a series move

**Setup:** H3 accepted as Co-Instructor on `qa-CL-38`; H3 holds a confirmed session at time T (H3's free webinar).

**Steps:** move the series so one new start overlaps T.

**Expect:** 409 `SCHEDULE_CONFLICT` with the co-host's clash (record the copy). No change.

**Probe further:** if the copy says "your calendar", it misleads H2 (see WE-51). The preview labels only H2's calendar.

## CL-49 — An attendee clash is flagged, not blocking

**Setup:** B2 holds an H1 consultation at a time T2 one of the new starts will hit.

**Steps:** move the series to include T2.

**Expect:** 200 with `attendeesWithClash: 1`; B2's notice is the clash variant; others plain.

## CL-50 — Seats sold during a move see the new times

**Steps:** `[two-browser]` as H2 start a series move while B1 checks out a seat; let both finish.

**Expect:** both succeed; B1's seat lists the new times; B1 has no free leave if their seat was created after `movedAt`. Depth in 09 (`CC-`).
