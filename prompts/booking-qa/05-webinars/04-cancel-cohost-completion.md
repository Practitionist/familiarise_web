# 05-d · Webinars: cancelling, leaving, co-hosts and completion

**Needs:** `qa-WE-05` (or a fresh copy) with paid seats; `qa-WE-21`; F-PL2 free webinar with B1 registered (WE-18); F-AV3 (H3). **[local]** for refunds; **[sweep]** for completion.
**Personas:** H2 (IST) host; H3 (America/New_York) co-host; B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), DR (Australia/Sydney); ST.
**Docs under test:** `docs/booking/08-cancellation-flow.md` (whole-event refunds, self-leave), `lib/payments/operations/event-refunds.ts` (`refundWholeEventPayments`, `refundRemovedAttendeeSeat`), `lib/booking/seat-leave.ts`, `lib/collaborators/availability.ts`, `components/collaborators/CollaboratorsTab.tsx`, `docs/booking/16-recurring-events-journey.md` §7.

Refund arithmetic in depth (GST credit notes, earnings reversal across collaborators) is 08's (`MO-`). Here: the right door, the right amount, and every surface agreeing.

**Seat-leave rule (code):** a webinar seat leaves with a **full** refund outside the host's free-cancellation window (default 24 h, a plan may set 24–168 h), and **cannot leave** inside it (409 `REFUND_WINDOW_CLOSED`, "Free cancellation ended <N> h before the start — this seat can no longer be refunded."), unless the webinar was re-timed after the seat was bought and `retimeBy` hasn't passed (05-c). An organiser removal always refunds in full. A host cancel refunds every seat in full.

> [!NOTE]
> `docs/booking/08-cancellation-flow.md` says a consultee self-leave "uses the attendee notice tiers". The code is binary (full outside the window, refused inside). Report **DOC-DRIFT** once.

## WE-42 — The host cancels a paid webinar: everyone is refunded in full [local]

**Setup:** a fresh `qa-WE-42`: ₹300, capacity 5, 60 min, 3 days out; B2 and B3 buy seats; DR joins nothing.

**Steps:**

1. As H2, row menu → **Cancel booking**. Read the dialog.
2. Confirm.
3. As B2 and B3, open bell, booking, Payments.

**Expect:**

- Dialog: "Cancelling this event refunds all 2 attendees in full — ₹<total> in total." (amount = sum of seat payments).
- API: `POST /api/appointments/[aid]/cancel` → 200. DB: `Webinar.status = CANCELLED` (history row); the occurrence `CANCELLED`; each seat refunded 100% (two `Refund` rows, one per payment, through the whole-event door); `refundOwedKey` cleared after the refunds land; H2's earnings reversed.
- Buyers: one notice each; bookings say the host cancelled; Payments show the refund.

**Cross-check:** H2's Appointments (Cancelled bucket), Offerings card, public page (no longer bookable: "This webinar has been cancelled."), staff refunds console, H2's reliability: record whether a strike is written for an event cancel.

**Probe further:**

- Waitlisted users: is their waitlist row expired and are they told?
- Does the dialog warn the host about a reliability strike, as the 1:1 dialog does?

## WE-43 — Cancelling a free webinar moves no money

**Steps:** as H2, cancel F-PL2's free webinar (B1 registered). Read the dialog.

**Expect:** dialog "Nobody has paid for a seat yet, so cancelling refunds nothing." (or the free-event variant; record). B1 notified; no `Refund` rows.

**Probe further:** "Nobody has paid" is true, but B1 did register. Is B1's loss acknowledged anywhere ("your registration was cancelled")?

## WE-44 — Status changes only through the cancel door

**Steps:** `PUT /api/bookings/webinars/[webinarId]` with `{ "status": "CANCELLED" }`, then with `{ "status": "COMPLETED" }`.

**Expect:** both 409 `USE_CANCEL_ROUTE`, "Cancel a webinar through its cancel action, not an update." No change. (`EventEditorStatusSchema` allows only DRAFT and SCHEDULED.)

## WE-45 — No host cancel while the webinar is under way

**Setup:** a paid H2 webinar shifted (owner-approved) to start in 10 minutes.

**Steps:** as H2, open Cancel booking; confirm.

**Expect:** 409 `SESSION_IN_PROGRESS`, "This session is in progress — end the call and we'll settle it from what happened." Nothing cancelled.

**Probe further:** what should a host do if they can't run a webinar starting in 10 minutes? Is there a "report a problem" path?

## WE-46 — A buyer leaves outside the window: full refund [local]

**Setup:** `qa-WE-05` (or `qa-WE-21`) more than 24 h away, B3 seated, not re-timed.

**Steps:**

1. As B3, open the booking. Open the leave dialog. Read the refund line.
2. Leave.

**Expect:**

- Dialog: title "Leave webinar?" (record exact), a line quoting the full seat refund, buttons "Stay enrolled" / leave.
- API: `DELETE /api/participants/webinar/[webinarId]` (self) → 200. DB: seat released/`REFUNDED`; `Refund` = full seat amount under `seat-leave:<participantId>`; seats left +1; waitlisted users notified.
- B3's Payments shows the refund; H2's Participants drops B3 and Earnings shows the reversal.

**Probe further:** does H2 get told who left? Should they?

## WE-47 — Inside the window a buyer can't leave, and the copy disagrees

**Setup:** a paid seat (B2) on a webinar shifted to start in 10 hours, never re-timed.

**Steps:**

1. As B2, open the booking. Read the cancellation note and the leave dialog.
2. Try to leave.

**Expect:**

- API: 409 `REFUND_WINDOW_CLOSED`, "Free cancellation ended 24 h before the start — this seat can no longer be refunded." The seat stays.
- UI note: "The free-cancellation window for this webinar closed; a cancellation now refunds nothing on this seat."

**Probe further:** the note implies B2 can cancel for ₹0; the server refuses the cancel outright. Report **INCONSISTENCY** (P2) with both texts. What should B2 do instead (just not attend)? Is that said?

## WE-48 — A longer host window set through the API

**Why it matters:** the plan's `refundWindowHours` (24–168) changes the buyer's deadline, but the editor doesn't expose it.

**Steps:**

1. As H2, create `qa-WE-48` via `evaluate_script` (crud-with-plan POST) with `refundWindowHours: 72`, ₹200, 4 days out.
2. Try `refundWindowHours: 12` and `200`.
3. As B4, open checkout. Read the note. Buy [local].
4. Shift the session to 48 h away. As B4, try to leave.

**Expect:**

- Step 2: 400 (outside 24–168).
- Step 3: note "Cancel at least 3 days before it starts and the seat is refunded in full. …" (record the exact phrase from `noticePhrase(72)`).
- Step 4: 409 `REFUND_WINDOW_CLOSED`, "Free cancellation ended 72 h before the start — this seat can no longer be refunded."

**Probe further:** the editor has no field for the window. Report **MISSED-OPPORTUNITY** for hosts (or confirm it's intentional). Does the public page show the 72-hour window before checkout?

## WE-49 — The host removes an attendee: full refund [local]

**Steps:** as H2, open Participants for a paid webinar; remove DR (record the control and its confirm text).

**Expect:** DR's seat released; a full `Refund` through the removed-attendee door; DR notified with the reason (record copy); seats left +1.

**Probe further:** can H2 remove someone inside the 24-hour window? (Organiser removals always refund in full.) Does the confirm text say so?

## WE-50 — Invite a co-host

**Steps:**

1. As H2, open `qa-WE-05`'s editor → **Collaborators** ("Other experts delivering alongside you."). Invite H3 as **Co-Host** with a revenue share of 20%.
2. As H3, open `/dashboard/consultant/[H3 cid]/collaborations`, accept.
3. As H3, open Appointments.

**Expect:**

- `Collaborator` row `PENDING` → `ACCEPTED`, `revenueShareBps = 2000`.
- H3 sees the webinar in their Appointments in New York time (Wed 18:00 IST = 07:30 New York).
- A later seat sale writes an H3 `COLLABORATOR` earnings row with only the share (08 checks the maths).

**Probe further:** shares above 90% in total, or an owner left with under 10%: the invite should refuse (record copy). Can H3 edit the webinar's time? (PUT/DELETE are owner-only.)

## WE-51 — A busy co-host blocks a move to their busy time

**Setup:** H3 accepted (WE-50). As H3, publish a free 60-minute webinar `qa-WE-51` at time Y, 4 days out (Y must be free for H2).

**Steps:**

1. As H2, open Move to a new date for `qa-WE-05`. Look at Y in the picker.
2. Re-time to Y.
3. On an unsold webinar where H3 is also an accepted co-host, change **Scheduled for** to Y in the editor. Save.

**Expect:**

- Step 1: the picker sends the event, so accepted co-hosts' busy time is folded in and H2's own appointment is left out (a free time outside a co-host's published hours is labelled "Outside a co-host's hours" and cannot be picked): Y is tagged **Booked** because of H3's webinar (record the label). A picker that lists Y as a free button is a **BUG** (P2).
- Step 2: 409 `SCHEDULE_CONFLICT`, "That time conflicts with another confirmed session on your calendar."
- Step 3: 409 "Co-host(s) unavailable at the selected time: James Anderson" (no `code`).

**Probe further:**

- Step 2's copy says "your calendar"; the clash is H3's. **FALSE-INFO** (P2): H2 will look at their own calendar and find nothing.
- If the picker names the cause as H2's own calendar rather than a co-host's, record it as **COPY** (P3); an unlabelled co-host clash is a **MISSED-OPPORTUNITY**.

## WE-52 — A pending co-host doesn't constrain the calendar

**Steps:** invite H4 as Co-Host on `qa-WE-06` but don't accept. Give H4 a booking at time Z (H4 publishes a free webinar at Z). As H2, move `qa-WE-06` to Z.

**Expect:** 200; only ACCEPTED co-hosts count. Then accept as H4 and try to move another webinar of H2 (with H4 accepted) onto H4's Z: refused as WE-51.

**Probe further:** when H4 accepts **after** H2 already scheduled over H4's booking, nothing stops the double booking. Run R-05 for H4 (co-host sessions don't carry H4's `consultantProfileId`, so R-05 won't catch it). Report what H4's calendar shows.

## WE-53 — The webinar happens and completes [sweep]

**Setup:** a paid webinar with B2 seated; owner-approved shift so it ended 2 hours ago.

**Steps:**

1. Run `auto-complete-appointments` (NEEDS-OWNER-RUN on a preview).
2. As B2, open the booking. Look for a feedback or review prompt.
3. Submit feedback (`POST /api/appointments/[aid]/feedback`) through the UI.
4. Submit again.

**Expect:**

- After the job: occurrence `COMPLETED` (meeting held) or `UNVERIFIED` (no meeting); `Webinar.status = COMPLETED` (record).
- Feedback: 2xx the first time; second → 409 `CONFLICT` (or an edit; record).
- H2's earnings: `holdUntil` 48 h after the session; `release-earnings` moves it to READY after that (12 owns the job).

**Verification SQL:** R-03 for the appointment; R-04 earnings; `SELECT * FROM "AppointmentFeedback" WHERE "appointmentOccurrenceId" = :occ;`

**Probe further:** can B2 leave (and get a refund) after the session ended? Expect refused. Does the booking say "attended" or "completed"?

## WE-54 — An attendee who joined late or never joined

**Steps:** with the webinar above, compare B2 (joined the call, if you can simulate presence) and B3 (never joined).

**Expect:** both seats count as delivered; neither is refunded automatically. Record what each buyer's booking says.

**Probe further:** is there a "report a problem" path for a buyer whose host never showed? Where?

## WE-55 — Folder cleanup

**Steps:** cancel through the product every `qa-WE-` webinar still scheduled; archive their plans; R-09 for mock-payment rows only, with owner approval; remove the H3/H4 collaborator rows you created (through the UI where possible).

**Expect:** a ledger of every id with cleanup status. R-05 for H2, H3, H4 → zero rows.
