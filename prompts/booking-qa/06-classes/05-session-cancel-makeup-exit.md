# 06-e · Classes: cancelling one session, the make-up, skipping it, and the exit right

**Needs:** a sold class `qa-CL-51` = H2, 2/week × 2 months × 60 min (16 sessions), ₹1,600, B2 and B3 seated [local], sessions starting 2+ days out. H3 accepted as Co-Instructor for CL-57. Owner-approved clock shifts; **[sweep]** for the 14-day settlement.
**Personas:** H2 (IST) host; B2 (Europe/London), B3 (America/Los_Angeles) learners; H3 (America/New_York); ST.
**Docs under test:** `docs/decisions/2026-09-25-class-series-money-rules.md`; `lib/booking/class-sessions.ts` (`cancelClassSession`, `scheduleClassMakeUp`, `skipClassMakeUp`); `lib/booking/misses.ts` (`MAKEUP_WINDOW_DAYS = 14`, `missedAt`); `lib/booking/class-series.ts` (`exitRightFor`: 3 host misses inside any 30 days, or total misses ≥ max(3, 15 % of N)); `components/appointments/detail/ClassSessionControls.tsx`; `scripts/appointments/settle-cancelled-sessions.ts`.

The host's controls are on the class detail page, per upcoming session: **Cancel this session** (confirm title "Cancel this session?", body "Learners are told; you have 14 days to schedule a make-up or each seat is refunded<unit>.", **Keep it**), then **Schedule make-up** (the host's `SingleTimePicker`, purpose make-up: 1 h lead, days after the 14-day deadline disabled and later starts not listed; picker rules in 05's WE-02). The learner sees "Make-up for the <date> session is on <date>." and **Can't make it — refund this session** ("Refund this session?", "This session<unit> comes back to you instead of the make-up. You keep your seat for the rest of the series.").

Doors: `POST /api/appointments/[aid]/occurrences/[occ]/cancel`, `…/make-up` `{ startsAt }`, `…/skip-make-up`. Per-session refunds are keyed `occ:<occurrenceId>:pay:<paymentId>`. After every write: R-03, R-04 when money moves, R-05.

## CL-51 — The host cancels one future session

**Why it matters:** a cancel is a miss; learners must hear about it and the 14-day clock starts.

**Steps:**

1. As H2, open `qa-CL-51`'s detail page. On session 3, click **Cancel this session**. Read the confirm. Confirm.
2. As B2 and B3, open the bell and the class.

**Expect:**

- Confirm body names the 14 days and the per-seat unit (₹1,600 ÷ 16 = ₹100; record the exact `<unit>` text).
- DB: session 3 `completionStatus = CANCELLED`, `hostCancelledAt` set, **not** deleted (`deletedAt` null), ordinal kept. No refund yet. R-05: the freed time no longer blocks H2.
- Learners: one notice each with the make-up deadline (hostCancelledAt + 14 days) in their zone; the session shows "Session cancelled".

**Cross-check:** H2's calendar frees the hour; the public batch card still sells (remaining sessions unchanged); staff class-series view shows one miss.

**Probe further:**

- Does the learner's notice say what happens if no make-up comes (a refund of one session)?
- The confirm uses "<unit>" wording; is the amount right for a late joiner who bought fewer sessions (the unit is per seat: seat paid ÷ sessions the seat bought)?

## CL-52 — Cancel refusals

**Steps:**

1. Cancel session 3 again.
2. Shift session 4 (owner-approved) to have started 10 minutes ago; cancel it.
3. As B2, call the cancel door.
4. As ST, call it.

**Expect:**

- 1 and 2 → 409 `SESSION_NOT_CANCELLABLE`, "This session can no longer be cancelled — it has started, finished or was already cancelled."
- 3 → 403 "Only the class host can do this".
- 4 → 403 `PLATFORM_CLASS_DOOR_REQUIRED`, "Do this from the back office so the change is audited." (the back office's "Cancel this session for the host" door is 11's).

## CL-53 — Schedule the make-up with the picker

**Steps:**

1. As H2, on session 3, click **Schedule make-up**. Read the picker: today, the last allowed day in the month, the zone line.
2. Pick a free start 5 days out. Schedule.
3. As B2, B3, open the class.

**Expect:**

- Picker: no start inside 1 h is listed; days after hostCancelledAt + 14 days are disabled in the month and a start that would end after it is not listed; H2's bookings are tagged **Booked**; "Times in Asia/Kolkata" under the day heading.
- API: `POST …/occurrences/[occ]/make-up` `{ startsAt }` → 200. DB: a new occurrence with the **same ordinal** as session 3, same 60-minute length, `isTentative = false`; session 3's original row stays `CANCELLED`; `seatsSettledAt` set on the source (the make-up happened). R-05 zero rows.
- Learners: notice "Make-up for the <date> session is on <date>."; the class lists the make-up in their zone (e.g. 18:00 IST = 12:30 London = 04:30 LA).

**Probe further:** does the make-up keep the class's weekly look (the batch card) or show as an odd one-off? Is it marked "make-up" on both sides?

## CL-54 — Make-up refusals

**Steps (via the UI where possible, else `evaluate_script`):**

1. A second make-up for session 3.
2. Cancel session 5; make-up at a :15 UTC start; then at now + 30 min.
3. Make-up for session 5 at hostCancelledAt + 15 days.
4. Make-up for session 6 (not cancelled).
5. Make-up at a time H2 is busy.
6. `{ "startsAt": "soon" }`.

**Expect:**

- 1 → 409 `MAKEUP_EXISTS`, "A make-up for this session is already scheduled." (or `MAKEUP_WINDOW_LAPSED` because the source is settled; record which).
- 2 → 400 `EVENT_TIME_INVALID`, "Pick a start time on the hour or half hour." / "Pick a start time at least 1 hour from now."
- 3 → 409 `MAKEUP_WINDOW_LAPSED`, "A make-up must be held within 14 days of the missed session, and in the future."
- 4 → 409 `MAKEUP_WINDOW_LAPSED` (not a miss).
- 5 → 409 `SCHEDULE_CONFLICT`, "That time conflicts with another session on your calendar." (or the "confirmed session" variant).
- 6 → 400 "A make-up needs a start time (ISO 8601)."

**Probe further:** the 14 days run from the **cancel** (`hostCancelledAt`), not from the session's own date. A session cancelled 2 days before it was due has a deadline 12 days after its date. Is that what learners are told?

## CL-55 — A learner skips the make-up and gets that session back [local]

**Steps:**

1. With session 5's make-up scheduled (redo CL-53 for session 5), as B3 click **Can't make it — refund this session**. Read the dialog. Confirm.
2. Try again.

**Expect:**

- DB: one `Refund` for B3 of one unit (⌊seat paid ÷ sessionsPurchased⌋ = ₹100 for an on-time seat), `dedupeKey = occ:<session 5 occurrence id>:pay:<B3 payment>`; B3 keeps the seat for the rest of the series; B3 is not expected at the make-up (record how attendance shows).
- Step 2 → 409 `MAKEUP_NOT_SKIPPABLE`, "This session has no upcoming make-up to skip, or you do not hold it."

**Cross-check:** B3's Payments shows a partial refund; H2's Earnings reduce by B3's unit share only.

**Probe further:** a late joiner (CL-31) skipping a make-up for a session before their seat → 409 "This session was before your seat was bought."

## CL-56 — No make-up within 14 days: every seat gets one unit back [sweep]

**Setup:** cancel session 7 (no make-up). Owner-approved: set its `hostCancelledAt` to 15 days ago.

**Steps:** run `settle-cancelled-sessions` (NEEDS-OWNER-RUN on a preview).

**Expect:** each seat holder (B2, B3) gets a `Refund` of one unit keyed `occ:<occ>:pay:<payment>`; the source row's `seatsSettledAt` set. A seat that already skipped (CL-55 style) for that session is not refunded twice.

**Verification SQL:** R-04 for the class appointment; `SELECT id, "seatsSettledAt" FROM "AppointmentOccurrence" WHERE id = :occ;`

**Probe further:** what does each learner see after the sweep ("Session refunded")? Is H2 told the window lapsed?

## CL-57 — A busy co-host blocks a make-up

**Setup:** H3 accepted as Co-Instructor; H3 has a confirmed session at time T within the window.

**Steps:** schedule a make-up at T.

**Expect:** the make-up picker folds H3's busy time in, so T is tagged **Booked** and cannot be picked; sent by hand, a make-up at T answers 409 `SCHEDULE_CONFLICT` naming a clash (record copy). A picker that lists T as a free button is a **BUG** (P2).

**Probe further:** same "your calendar" wording issue as WE-51/CL-48.

## CL-58 — Three host misses in 30 days open the learners' exit right [local]

**Why it matters:** learners can leave a class that keeps missing sessions, with every undelivered session refunded.

**Setup:** `qa-CL-51` with sessions 3, 5 and 7 cancelled by the host within 30 days (CL-51, CL-54, CL-56).

**Steps:**

1. After the third cancel, as B2 open the class. Look for the exit option and read it.
2. Check R-07 outbox and the bell.
3. Leave through the exit option.

**Expect:**

- After the third miss: one `CLASS_EXIT_AVAILABLE` bell and one email per learner (deduped), and a `class-reliability:<classId>` `SystemEvent` for ops.
- The detail page offers leaving with a full refund of the remaining sessions (record the label).
- Exit: refund = every undelivered session at full value, minus any session already refunded on its own (B2's unit for session 7, if the sweep ran): ⌊1600 ÷ 16⌋ × undelivered − already refunded, clamped to the balance. `Refund` under `seat-exit:` or `seat-leave:` (record the key prefix).

**Probe further:** before the right trips, the exit door answers 409 `EXIT_NOT_AVAILABLE`, "This class has not missed enough sessions for a full-refund exit." Does the UI hide the option then?

## CL-59 — The total-miss threshold for a long class

**Steps:** on a 32-session class (2/week × 4 months), compute max(3, 15 % of 32) = 5. Cancel 4 sessions spread over 60 days (never 3 in 30). Check the exit right. Cancel a 5th.

**Expect:** after 4 → no exit right; after 5 → exit right opens. (Owner-approved `hostCancelledAt` shifts are fine to spread them.)

**Probe further:** a voided session (outage) counts toward the total but not toward the host's 30-day window; check with staff's void (11 owns the door).

## CL-60 — A make-up for a voided session

**Setup:** staff voids a past session (back office; or owner-approved `voidedAt = now()` on a past occurrence).

**Steps:** as H2, schedule a make-up for it within 14 days of `voidedAt`. A staff void is confirmed as written, so its 14 days run from the void; a void the outcome sweep wrote with a host-attributed verdict (`HOST_ABSENT`, `CUT_SHORT`) counts its 14 days from the confirmation (`outcomeConfirmedAt`) instead, and until then a make-up within 14 days of now is accepted.

**Expect:** 200; the make-up carries the voided session's ordinal; the source is settled. (The source is in the past; only the make-up must be ahead.)

## CL-61 — A class make-up on a phone

**Steps:** `resize_page` 390×844; repeat CL-53's picker steps.

**Expect:** the picker works without the desktop notice; the month sits above the times with no horizontal scroll; day cells and time buttons are at least 40 px.

## CL-62 — The host can't cancel and move the same session at once

**Steps:** cancel session 9, then try **Move upcoming sessions** while session 9 is cancelled and unmade-up.

**Expect:** the series move counts only live, confirmed sessions at least 24 h away (`MOVABLE_SESSION_WHERE`), so session 9 isn't moved; its make-up machine still owes it. Record the GET count.

**Probe further:** after a series move, a pending make-up deadline is unchanged. Is that sensible when the whole pattern moved?
