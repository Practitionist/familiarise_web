# 13-b · Error codes: reschedule, cancel, class sessions and trials

**Needs:** the fixtures each trigger names (mostly from 03, 06, 07). Most triggers are one `evaluate_script` `fetch` from the signed-in page plus the same action in the UI.
**Personas:** H1, H2, B1, B2, ST.
**Docs under test:** `app/api/appointments/[appointmentId]/reschedule/route.ts`, `utils/errors/RescheduleErrors.ts`, `app/api/appointments/[appointmentId]/cancel/route.ts`, `lib/appointments/cancel-requote.ts`, `lib/booking/session-window.ts`, `lib/booking/class-sessions.ts`, `lib/booking/seat-leave.ts`, `app/api/trials/route.ts`, `app/api/trials/[trialId]/route.ts`, `lib/booking/request-route-guards.ts`, `components/appointments/detail/RescheduleProposalCard.tsx`, `components/dashboard/shared/requests/labels.ts`.

**For every code, record one row:**

| Field | What to write |
| --- | --- |
| Door | method and route; the UI action that reaches it |
| Status and shape | HTTP status; the JSON keys (`code`, `errorCode`, `errorType`, `error`, `message`) |
| Server sentence | verbatim |
| UI | toast title and description, or inline text, verbatim; the surface |
| Next step | does the user learn what to do now (and is it possible)? |
| Verdict | human? true? actionable? any raw code, `[CODE]`, id or developer text? |

Where the UI never reaches a door (API-only), say so and judge the sentence for the day a UI does. The expected sentences below are from the code; a different sentence is not a failure by itself, but quote it.

## UX-15 — `RESCHEDULE_WINDOW` (409)

**Trigger:** CO-52: as B1, reschedule a session under 24 h away (UI and `POST …/reschedule`).

**Expect:** "Cannot reschedule within 24 hours of the meeting. The earliest meeting starts in N hours." The proposal card titles it "Too close to the meeting to reschedule". The inbox passes the server sentence through (`labels.ts` keeps it out of its map on purpose).

**Probe further:** "meeting", "Cannot", and no next step (cancel tiers, message the expert). N is floored: at 23 h 50 min it says 23 hours. **COPY** (P3), **MISSED-OPPORTUNITY**.

## UX-16 — `PROPOSAL_TOO_SOON` (400)

**Trigger:** as B1, propose a new time 20 h ahead for a session 3 days away (API with `proposedSlots`).

**Expect:** "New times must be at least 24 hours away."

**Probe further:** the grid should have painted those cells "Too soon" so the UI can't send it. If the UI sends it, the toast must say the same.

## UX-17 — `MAX_RESCHEDULES_EXCEEDED` (422)

**Trigger:** CO-53 (consultee's third move of one session) and TR-20 (learner's second trial move).

**Expect:** consultation "You can move each session at most 2 times."; trial "You can move a trial once. If this time doesn't work either, cancel the trial."

**Probe further:** does the reschedule page say "1 move left" before the user spends it? 422 here vs 409 for the expert cap (UX-18): same kind of rule, two statuses.

## UX-18 — `EXPERT_RESCHEDULE_CAP` (409)

**Trigger:** CO-65 (H1's third reschedule of one booking) and TR-24 (H1's second trial move).

**Expect:** "You've already rescheduled this booking 2 times. If the time no longer works, cancel instead — the client gets a full refund."; trial "You've already moved this trial once. If the time no longer works, cancel it — the learner gets a full refund."

**Probe further:** the consultation copy says "client", the trial copy "learner". The cancel it points to records a strike; does the sentence say so? (It shouldn't hide it.)

## UX-19 — `RESCHEDULE_ALREADY_OPEN` (409)

**Trigger:** CO-54 (a second reschedule while one is open).

**Expect:** "A reschedule request is already open for this booking." Card title "You already have a reschedule open". Inbox map: same sentence.

**Probe further:** does it link to the open request or say who must answer it?

## UX-20 — `RELEASE_ONE_WEEK` (409)

**Trigger:** SU-63 (move sessions from two plan weeks together).

**Expect:** the `RELEASE_ONE_WEEK_MESSAGE` sentence: record it. It should say "one plan week at a time" in the same words as the allocate copy.

**Probe further:** can the UI produce this request at all (does the reschedule page let a buyer pick sessions across weeks)?

## UX-21 — `TIMES_TAKEN` (409)

**Trigger:** CO-57 (a green time taken between load and submit, `[two-browser]`) and TR-22 (trial).

**Expect:** "Some of the times you picked were just taken. Your booking keeps its original time — pick another time."; trial "That time was just taken. Your trial keeps its original time — pick another time." The grid's "These times were just taken" toast names the times.

**Probe further:** does the page refresh the grid so the taken time shows as booked? Is the move counted against the cap? (TR-22 says it must not be.)

## UX-22 — `TIME_NOT_BOOKABLE` (409)

**Trigger:** TR-22 (a trial move to a time outside the expert's hours or too soon, via the API).

**Expect:** "That time can't be booked: it isn't in the expert's open hours or it's too soon. Your trial keeps its original time — pick another time."

**Probe further:** "or" — the server knows which one. A sentence that names the actual reason is better; note **MISSED-OPPORTUNITY** (P3).

## UX-23 — `PROPOSAL_REQUIRED` (400)

**Trigger:** TR-21 (a trial move with no time).

**Expect:** "Pick the new time for the trial."

**Probe further:** consultations allow "Any time works" (writer report open question 7); the trial page must not offer that option. Does it?

## UX-24 — `PROPOSAL_COUNT_MISMATCH` (400)

**Trigger:** via the API, propose one 30-min atom for a 60-min session.

**Expect:** "Pick 1 hour of new time in total — the same length as what you're moving." The inbox maps it to "This request changed elsewhere — refreshed"; the card titles it "The proposed times changed".

**Probe further:** the inbox and card claim the request "changed elsewhere", which is false when the cause is a length mismatch. **FALSE-INFO** (P3).

## UX-25 — `PROPOSAL_WINDOW_CLOSED` (400)

**Trigger:** only reachable if the 24-h gate and the deadline maths drift (code comment). Try: a session exactly 24 h 1 min away, propose; then answer an expert proposal after its deadline passed (shift `expiresAt` with owner approval).

**Expect:** "This session is too close to propose a new time for." Card title "The answer window has closed"; inbox "This request changed elsewhere — refreshed".

**Probe further:** record which path produced it; the copy differs by surface for one code.

## UX-26 — `PAY_LINK_LIVE` (409)

**Trigger:** CO-59 (reschedule a booking waiting for payment).

**Expect:** "This booking is still waiting for payment. Pay for it or cancel it first, then reschedule." The block covers any booking with a `PENDING` payment whose `expiresAt` is still ahead (or null), not only an approved request; a lapsed link no longer blocks.

**Probe further:** does the consultee page hide Reschedule while a pay link is live (better than refusing)? For H1, "Pay or cancel it first" is addressed to the buyer.

## UX-27 — `NOT_RESCHEDULABLE` (409)

**Trigger:** reschedule a cancelled or completed booking by URL or API.

**Expect:** "This appointment can no longer be rescheduled (already cancelled or completed)."

**Probe further:** "appointment" vs "booking". The parenthesis guesses; the server knows which. **COPY** (P3).

## UX-28 — `NO_RESCHEDULABLE_SLOTS` (409)

**Trigger:** reschedule a booking whose sessions are all past or terminal, or one with no session yet.

**Expect:** "There's no session left to move on this booking. Message the other party or contact support to agree a new time." / "There's no session to move on this booking yet. …"

**Probe further:** "Message the other party": is there a message button on that page? If not, the advice can't be followed. **MISSED-OPPORTUNITY**.

## UX-29 — `USE_RETIME` (400 on reschedule, 409 on allocate)

**Trigger:** WE-33 (reschedule a webinar) and WE-31 (allocate a sold webinar).

**Expect:** reschedule: "Pick the webinar's new date with \"Move to a new date\" instead."; allocate: "This webinar already has N booked seats, so its times can't be re-planned. Use \"Move to a new date\" to move it: attendees are told and may leave with a full refund." (a class says \"Move upcoming sessions\"). Toast title "This event already has booked seats — use Re-time".

**Probe further:** the sentences name real buttons, but the toast title still says "use Re-time" and no button is called that (UX-14). A buyer receiving the reschedule sentence (WE-33) is told to use a host tool.

## UX-30 — `USE_SESSION_CANCEL` (400)

**Trigger:** reschedule a class session via the API.

**Expect:** "Move a class session by cancelling it and scheduling a make-up."

**Probe further:** addressed to a host; a learner calling it gets host advice. For a sold class, "Move upcoming sessions" exists too; should the sentence mention it?

## UX-31 — `TRIAL_PARTY_ONLY` (403)

**Trigger:** TR-27 (ST or a third persona moves a trial).

**Expect:** "Only the trial's expert or learner can move it. Cancel it from the back office instead."

**Probe further:** fine for staff; a stranger should get 404 (09 owns the authz). Record what B2 gets.

## UX-32 — `PLATFORM_CANCEL_DOOR_REQUIRED` and `PLATFORM_RESCHEDULE_DOOR_REQUIRED` (403)

**Trigger:** DB-21.

**Expect:** "Cancel this booking from the back office so the refund is audited." / "Reschedule this booking from the back office so the change is audited."

**Probe further:** does the staff console have a reschedule door at all? If not, the second sentence points nowhere. **MISSED-OPPORTUNITY**.

## UX-33 — `DISPUTE_ACTIVE` (409)

**Trigger:** needs a payment with an open dispute on a 1:1 booking (a consultation or a plan; 08 may seed one with owner approval). Then cancel it, ask to reschedule it, accept a reschedule request on it, and return one of a plan's sessions. Separately, with a disputed seat on a class or webinar: the host cancels the event, the host re-times the webinar, and the disputing learner leaves their own seat.

**Expect:** on the 1:1 booking, `409` `DISPUTE_ACTIVE`: "This appointment has an open payment dispute and can't be cancelled until it resolves." on the cancel, the "rescheduled" variant on the reschedule request and on accepting one, and "This plan has an open payment dispute, so its sessions can't be returned until it resolves." on the session return. On the class or webinar, no `DISPUTE_ACTIVE` at all: one seat's dispute never freezes the event for the other seats, so the cancel and the re-time go ahead, and the learner's own seat leave is not refused either. There is no "re-timed" variant of the sentence.

**Probe further:** does the user learn what a dispute is, who opened it, or how long it lasts? After the event cancel, does the disputing learner see that their refund waits for the dispute (MO-62)? BLOCKED if no dispute fixture.

## UX-34 — `SESSION_IN_PROGRESS` and `SESSION_ALREADY_DELIVERED` (409)

**Trigger:** CO-74 (cancel inside 15 min) and cancel after the end.

**Expect:** in progress: record the sentence; delivered: "This session has already taken place, so the booking can't be cancelled. If something went wrong, report a problem from the booking."

**Probe further:** the cancel button should be gone before the user meets this. Is "report a problem" a real control on that page?

## UX-35 — `REFUND_QUOTE_CHANGED` and `REFUND_QUOTE_REQUIRED` (409)

**Trigger:** CO-75 (move `startsAt` across a tier between dialog and confirm); TR-35 / a paid trial PATCH (`REFUND_QUOTE_REQUIRED`: "This trial was paid for. Cancel it from the cancel dialog, which shows the refund first.").

**Expect:** the dialog refreshes with the new quote and says why; nothing committed.

**Probe further:** does the new quote say what changed ("The refund is now ₹250 because the session is under 24 h away")? A bare "quote changed" is **MISSED-OPPORTUNITY**.

## UX-36 — `REFUND_WINDOW_CLOSED`

**Trigger:** WE-47 (leave a seat inside the window).

**Expect:** "Free cancellation ended N h before the start — this seat can no longer be refunded."

**Probe further:** the writer report (04–06) found copy that disagrees here; WE-47 owns it. Record only whether the sentence offers anything (transfer, support).

## UX-37 — `USE_CANCEL_ENDPOINT`

**Trigger:** PATCH a consultation's status to CANCELLED (`/api/bookings/consultations/[id]`), and a trial's (`/api/trials/[id]`), and approve an already-confirmed request.

**Expect:** trial: "Cancel a scheduled trial from its cancel dialog, which shows the refund first."; confirmed request: "This booking was already confirmed. Place a new time, or cancel it to refund the client."

**Probe further:** the consultation path's sentence is "Cancelling bookings via status PATCH is not supported. Use POST /api/appointments/{appointmentId}/cancel instead." Developer text. If any UI can show it, **COPY** (P2); otherwise note it as API-only.

## UX-38 — `USE_CANCEL_ROUTE` (409)

**Trigger:** CL-11 / WE-44 (PUT a status on a class or webinar).

**Expect:** "Cancel a class through its cancel action, not an update." / "Cancel a webinar through its cancel action, not an update."

**Probe further:** `USE_CANCEL_ENDPOINT` and `USE_CANCEL_ROUTE` are two codes for one rule. **COPY** (P3) for clients that branch on codes.

## UX-39 — `SESSION_NOT_CANCELLABLE`

**Trigger:** CL-52 (cancel a class session that started, ended or was already cancelled).

**Expect:** "This session can no longer be cancelled — it has started, finished or was already cancelled." The proposal card maps this code to "This session can no longer be rescheduled".

**Probe further:** the card's title talks about rescheduling for a cancel refusal. Record where each version appears.

## UX-40 — `MAKEUP_WINDOW_LAPSED`

**Trigger:** CL-54 (a make-up more than 14 days after the missed session, via the API).

**Expect:** "A make-up must be held within 14 days of the missed session, and in the future."

**Probe further:** the picker clamps to the window (`allowedEnd`); does it say the last allowed date?

## UX-41 — `MAKEUP_EXISTS`

**Trigger:** CL-54 (a second make-up for the same session).

**Expect:** "A make-up for this session is already scheduled."

**Probe further:** does the sentence or page show when it is, and how to change it?

## UX-42 — `MAKEUP_NOT_SKIPPABLE`

**Trigger:** CL-55 variants: skip with no upcoming make-up; skip a session before your seat; skip after it can no longer be refunded.

**Expect:** "This session has no upcoming make-up to skip, or you do not hold it." / "This session was before your seat was bought." / "This session can no longer be refunded."

**Probe further:** the first sentence joins two causes with "or". The learner can't tell which. **COPY** (P3).

## UX-43 — `EXIT_NOT_AVAILABLE`

**Trigger:** a learner calls the exit door on a class with fewer than 3 misses.

**Expect:** "This class has not missed enough sessions for a full-refund exit."

**Probe further:** the UI should hide the exit action; if it shows a disabled one, does it say how many misses unlock it?

## UX-44 — Trial booking refusals: `TRIAL_ALREADY_REQUESTED`, `SLOT_BUSY` (423), `SLOT_TAKEN`, `TRIAL_UNPAID`, `ORG_LEARNER_REQUIRED`

**Trigger:** TR-12 (second trial), TR-05 (held time; two buyers in parallel for 423), a PATCH accept of an unpaid trial, a non-learner linking a trial to an org.

**Expect:** "You have already requested a trial with this consultant"; "Someone else is booking that time right now. Pick another time or try again." (423 and 409 share it); "This trial has not been paid yet — it can be accepted once the learner's payment is confirmed."; "Only learners in an organisation can link a trial to it. Request the trial without the organisation."

**Probe further:** "requested a trial" for a flow where the buyer books it; "consultant" vs "expert" on the same modal. 423 is an unusual status; does the client treat it like 409 (refresh slots)?
