# 13-c · Error codes: scheduling, allocation, checkout, events, requests and the platform

**Needs:** as each trigger names (02, 03, 04, 05, 06, 08, 09 fixtures). Use the row format from `02-error-codes-reschedule-cancel-sessions.md` (door, status and shape, server sentence, UI, next step, verdict).
**Personas:** H1, H2, H3, H4, B1, B2, B4, OS, ST, AD.
**Docs under test:** `lib/booking/event-time-rules.ts`, `lib/booking/event-retime.ts`, `lib/booking/class-retime.ts`, `utils/scheduling-engine/errors.ts`, `lib/booking/allocation/{refusal-copy,guards,classify,preference}.ts`, `lib/scheduling/allocate-route.ts`, `lib/scheduling/allocationMessages.ts`, `lib/booking/feasibility.ts`, `lib/payments/utils/slot-validation.ts`, `lib/errors/mapping/payment-error-toast-map.ts`, `lib/booking/request-caps.ts`, `lib/booking/lead-time.ts`, `lib/booking/event-waitlist.ts`, `lib/scheduling/availability-contract.ts`, `lib/api/idempotency.ts`, `utils/appointmentlock.ts`, `middleware.ts`.

**Key-name note:** the host allocate route answers `{ error, errorCode }`; the org allocate route, reschedule, cancel, trials and most others answer `{ error, code }`; checkout answers `{ error, errorType, code? }`. For each code, record which key carried it and whether the UI read the right one (a UI that reads the wrong key falls back to its generic sentence).

## UX-45 — `EVENT_TIME_INVALID` (400)

**Trigger:** WE-07 and CL-43/CL-54: a webinar start 30 min ahead, a start at :15 past, overlapping series times, a make-up 30 min ahead.

**Expect:** "Pick a start time at least 1 hour from now." (create, make-up); "Pick a start time at least 24 hours from now." (re-time); "Pick a start time on the hour or half hour."; "Two of the new times overlap. Space the sessions apart."

**Probe further:** "on the hour or half hour" is false for a Kathmandu host, whose valid starts are :15 and :45 local (writer report bug 4, WE-09). **FALSE-INFO** (P2) for H4.

## UX-46 — `RETIME_TOO_SOON`

**Trigger:** WE-36 (re-time a webinar starting within 24 h; pick a new time inside 24 h).

**Expect:** "A webinar can't be re-timed within 24 hours of its start. Cancel it instead — everyone is refunded in full."; "Pick a new time on the half hour, at least 24 hours away."

**Probe further:** the second sentence also covers an off-grid time, so its code says "too soon" for a grid problem. **COPY** (P3).

## UX-47 — `RETIME_NOT_ALLOWED`

**Trigger:** WE-36 (re-time a draft or past webinar), CL-43 (wrong number of series times; nothing ≥ 24 h away), a stale re-time dialog.

**Expect:** "Only a published webinar with an upcoming session can be re-timed."; "This webinar changed while you were re-timing it. Refresh and try again."; class: "Pick K new times…" and the cancel-plus-make-up pointer.

**Probe further:** the writer report (04–06) found the lock copy points to "the reschedule workflow" that refuses webinars. Collect the class series sentences and check each points to a door that exists.

## UX-48 — `VALIDATION_ERROR` from the allocator, and the inbox's sentence for it

**Why it matters:** one code carries every plain-copy rule refusal, and the inbox replaces it with a false sentence.

**Trigger:**

1. As H1, from the allocate page, save a time outside the open plan week, a fourth session in a 3-a-week plan, and a time H1 just closed in Availability.
2. As H1, from the Requests inbox, approve a request with **Use requested times** after making its requested time invalid (shrink H1's hours under it in another tab, then approve; or a request whose time is now inside the 2-h unpaid lead).
3. The same approval from **Batch approve**.

**Expect:** step 1: 400 `errorCode: "VALIDATION_ERROR"` with the plain rule sentence ("A subscription is scheduled one plan week at a time…", "That's more sessions than this plan week has room for…", "One of these times is outside the expert's available hours…"); the allocate page toast shows that sentence.

**Probe further:** steps 2–3: `errorSentence()` in `labels.ts` maps `VALIDATION_ERROR` to "That request could not be read. Refresh and try again." before it looks at the server sentence. The consultant is told the request is unreadable when the real reason is a rule. Report **FALSE-INFO** (P2) with both texts. The writer report (04–06) also notes that `PLAN_WEEK_FULL`, `OUTSIDE_PLAN_WEEK` and `PLAN_TOTAL_REACHED` exist only as internal tags, never as codes a client can branch on.

## UX-49 — `SCHEDULE_CONFLICT`

**Trigger:** WE-12 / WE-51 (webinar over the host's own booking or a busy co-host), CL-43 (series move onto a busy time), the consultation status PATCH path if reachable.

**Expect:** 409 with a sentence naming the clash (whose calendar, which time).

**Probe further:** the writer report (04–06) found co-host clashes described as "your calendar" and a webinar-create 409 with no code. Record each door's sentence and whether it names the co-host.

## UX-50 — `ALREADY_ALLOCATED` (409)

**Trigger:** CO-31 / H-02 style: allocate a request twice (two tabs).

**Expect:** the inbox maps it to "This request was already allocated in another tab."; the allocate page "This request was already allocated in another tab or by a teammate. Refreshing the list."

**Probe further:** the raw server sentence is "This consultation was already allocated in another session (1 confirmed slot(s) exist)." or "Event is already fully allocated with N confirmed slot(s)." If it ever reaches a user: lowercase type, "session" meaning a browser session, "slot(s)", a count. **COPY** (P2).

## UX-51 — `RESCHEDULE_STATE_CHANGED` (409)

**Trigger:** approve a reschedule in one tab after the other tab changed it (09 owns the race; reuse its run).

**Expect:** UI: "This request just changed" / "Its times were updated in another tab or by a teammate. The calendar has been refreshed — check the times and save again." Inbox: "This request changed elsewhere — refreshed".

**Probe further:** the server sentences carry counts: "Sessions changed in another session (expected 2 held, found 1). Reload and try again." Developer detail if shown. **COPY** (P2) if any surface prints it.

## UX-52 — `PROPOSAL_AWAITING_CLIENT` (409)

**Trigger:** CO-64 (H1 allocates over their own open proposal).

**Expect:** "You've asked your client to move to other times. Withdraw that request first, or wait for their answer."

**Probe further:** does the page link to the open proposal so H1 can withdraw it?

## UX-53 — `SLOT_TAKEN` (409)

**Trigger:** CO-04 (checkout), HM-27 (allocate), TR-05 (trial), CO-21 (request).

**Expect:** allocate: "One of these times was just booked. Pick another time and try again." (toast "That time was just taken — pick another"); request and trial: "Someone else is booking that time right now. Pick another time or try again."; checkout toast title from `SLOT_JUST_TAKEN_MESSAGE`.

**Probe further:** "Someone else is booking that time right now" is also used for a time that is already **booked** (not in progress). Is "right now" true? Compare with the checkout title.

## UX-54 — `LOCK_LOST` (409)

**Trigger:** 09 (CC-) owns the lock-renewal failure; reuse its run if it produced one.

**Expect:** "This booking was being changed somewhere else while we saved. Nothing was changed; please try again."

**Probe further:** is "somewhere else" true for a lock lost to a Redis hiccup? It tells the user someone else is editing. **COPY** (P3).

## UX-55 — `BOOKING_LOCK_UNAVAILABLE` (503) and `LOCK_CONTENTION` (409)

**Trigger:** 09's contention runs (two allocations at once).

**Expect:** "The booking system is briefly busy — retry in a moment." (inbox, allocate page); checkout "The Booking System Is Briefly Busy" / "We couldn't take the booking safely just now. Your card was not charged — please try again in a moment."; contention "Another change is in progress — retry in a moment" (with "Please wait Ns, then retry." when the response carries `retryAfter`).

**Probe further:** Title Case toasts at checkout vs sentence case elsewhere. **COPY** (P3).

## UX-56 — `SEARCH_TIMEOUT` (503)

**Trigger:** hard to force; try Auto on a long class with a busy calendar. Otherwise review the sentence.

**Expect:** "This calendar is taking too long to search. Try again, or pick the times yourself."

**Probe further:** the classifier maps it to 409 in one place and the error class says 503. Record the status you see.

## UX-57 — `SLOT_SHORTAGE` and the partial dialog

**Trigger:** SU-45 (Auto finds 2 of 3).

**Expect:** the partial dialog "Only 2 of 3 sessions fit" with "Schedule 2 now"; the toast after "Some sessions scheduled" / "2 of 3 sessions now have times. The remaining 1 session stays unscheduled until more availability opens."

**Probe further:** the manual sentence "You picked 2 of 3 sessions." reads as a count, not a refusal. Does the page say what to do with the third?

## UX-58 — Idempotency: `IDEMPOTENCY_IN_FLIGHT` (409), `IDEMPOTENCY_KEY_REUSED` (422), `IDEMPOTENCY_KEY_REUSE` (422)

**Trigger:** CO-58 / CO-23 replays (09 owns the races).

**Expect:** in flight: "Your earlier request is still being processed. Wait a moment, then refresh the page to see it."; reused (generic): "Idempotency-Key was already used with a different request body" or "This Idempotency-Key was already used for another request."; allocator: `IDEMPOTENCY_KEY_REUSE`.

**Probe further:** two spellings (`…_REUSED` vs `…_REUSE`) for one rule. The reused sentences name a header; a user should never see them (the client mints keys). If one reaches a toast, **COPY** (P2).

## UX-59 — `ALLOCATE_FORBIDDEN` (403)

**Trigger:** CO-09 (the consultee calls allocate on their booking).

**Expect:** "Only the expert or their organisation can set times for this booking." The consultee UI never offers it.

**Probe further:** the client copy for 403 on the allocate page is "You can't schedule this booking." Which shows?

## UX-60 — Org scheduling refusals

**Trigger:** DB-24.

**Expect:** `EXPERT_APPROVAL_REQUIRED` "The expert has to approve this booking before the organisation can set its times."; `NOT_ORG_FUNDED` "Only bookings funded by the organization's wallet, invoice, or license rail can be allocated on behalf of the organization."; `APPOINTMENT_NOT_FOUND` "Appointment not found or not eligible for organization slot allocation."

**Probe further:** "wallet, invoice, or license rail" is internal vocabulary for a sponsor owner. **COPY** (P3).

## UX-61 — `PLAN_NOT_FEASIBLE` (422) and the feasibility reasons

**Trigger:** SU-11, SU-12, SU-16 (publish); SU-14 (tight, 201 with warnings); SU-27 (checkout room hint).

**Expect:** reasons: "No availability is published, so no session can be placed."; "Each session is N minutes, but the longest published window is M minutes."; "The plan needs S sessions a week (at most C a day), but the published hours fit at most B in any week."; "K of the next W weeks can't fit S sessions around existing bookings."; "The published hours fit only B sessions in the best week, so one busy day can leave a week short."

**Probe further:** "minutes" for 210 ("Each session is 210 minutes") vs hours elsewhere in the editor. Do warnings (LOW_HEADROOM, WEEKS_SHORT) show anywhere after a 201? (Writer report: no component reads them.)

## UX-62 — `NOT_PLACEABLE`: one code, two meanings

**Trigger:** SU-28 (checkout with nothing free in week 1); CO-47 style consultee proposal whose auto-confirm was refused (reschedule outcome).

**Expect:** checkout 409, toast "No Free Time In The First Week", sentence "This expert has no free time in the first week of this plan right now. Pick a later start date, or ask them to open more hours."; reschedule 200 outcome `NOT_PLACEABLE` with "We couldn't confirm that time, so your session is released and waiting for the consultant to place it. Withdraw the request to keep your original time."

**Probe further:** the second is a success response reusing an error code's name. Clients that branch on `code` can't tell them apart. **COPY** (P3, code naming). Is the second sentence true (is the original time still restorable by withdrawing)?

## UX-63 — `SLOT_TOO_SOON` and `SLOT_NOT_ON_GRID`

**Trigger:** CO-03 (checkout a start under 15 min away; a start at :15 via the API).

**Expect:** toast titles "That Time Is Now Too Close" and "That Time Isn't Bookable"; descriptions from the server: "Bookings must be made at least 15 minutes in advance." and "Times start on the hour or half hour".

**Probe further:** "Times start on the hour or half hour" is false for :15/:45 zones (UX-45). The checkout passes the server sentence through; good. Is there a "pick another time" action on the toast or page?

## UX-64 — `WINDOW_DURATION_MISMATCH` (400)

**Trigger:** CO-03 (a 30-min window for a 60-min plan via the API).

**Expect:** "The selected time must match the plan length (1 hour)." / "Choose a start and end time for this consultation."

**Probe further:** API-only today? Record.

## UX-65 — `INVALID_PLAN_START` (400)

**Trigger:** SU-26 (a start date 91 days out or in the past, via the API).

**Expect:** "Pick a start date between today and 90 days from now."

**Probe further:** "today" in which zone? The date field's `min` is the browser date (TZ-36).

## UX-66 — `SUBSCRIPTION_ALREADY_ACTIVE` (409)

**Trigger:** SU-29.

**Expect:** "You already have this plan with N sessions left — schedule those first." (with "session" when N = 1).

**Probe further:** the buyer can't schedule; the expert does. "schedule those first" asks the buyer to do something they can't. **FALSE-INFO** (P2).

## UX-67 — Seats: `EVENT_FULL`, `EVENT_SOLD_OUT`, `ALREADY_REGISTERED`, `SEAT_REBUY_UNSUPPORTED`

**Trigger:** WE-20, WE-21, WE-25, a re-buy after leaving (WE-46).

**Expect:** "This Session Is Full" / "This session is full. Pick another time, or use Notify me on the event page to hear when a seat opens."; "You are already registered for this webinar" / "You are already enrolled in this class"; "You left this event earlier, and a seat you've left can't be bought again yet. Contact support if you'd like to rejoin."

**Probe further:** "Pick another time" for a one-off webinar: there is no other time. The raw sentences "Webinar is full" / "Class is full" if shown. **COPY** (P3).

## UX-68 — `ENROLMENT_CLOSED` and `CLASS_PRICE_CHANGED`

**Trigger:** CL-32 (after the cutoff); CL-31 race (a session starts during a late-join checkout).

**Expect:** "Enrolment for this batch has closed. Please choose a batch that has not started yet."; "A session of this batch started while you were checking out, so its price has changed. Please review the new price and try again. You have not been charged."

**Probe further:** "batch" appears only here; everywhere else it's "class". **COPY** (P3).

## UX-69 — Waitlist codes

**Trigger:** WE-22 (join, leave, join when not full, join when disabled, over the per-user cap).

**Expect:** `EVENT_NOT_FULL` "Seats are available — book now."; `WAITLIST_DISABLED` "The host is not taking a waitlist for this session."; `WAITLIST_FULL` "The waitlist for this session is full."; `EVENT_WAITLIST_CAP` "You can wait on at most N sessions at once — leave one to add another."; `EVENT_CLOSED` "This session is no longer taking sign-ups."

**Probe further:** does "book now" come with a button? Does the cap sentence list the learner's current waitlists?

## UX-70 — Request and lead-time refusals

**Trigger:** CO-22 (caps, pause), CO-21 (too soon), CO-28 (unpaid 2-h lead on approval), CO-06 / TR-14 (paused expert).

**Expect:** `REQUEST_CAP_REACHED` "You already have 3 requests waiting for an answer. Wait for an expert to reply, or withdraw one from your dashboard, then try again."; `CONSULTANT_AT_CAPACITY` "This expert's request queue is full — try again in a day or two, or pick another expert."; `CONSULTANT_PAUSED` "This expert is not taking new requests right now. Pick another expert, or try again later."; `NOT_ACCEPTING_BOOKINGS` "This expert is not taking new 1:1 bookings right now. …"; `REQUEST_TOO_SOON` "Your expert needs time to accept and you need time to pay — pick a time at least <lead> away."; `TOO_CLOSE_TO_START` "This session starts too soon for the client to pay first. Propose a later time instead."

**Probe further:** "Propose a later time instead" on an approval: can the expert propose from that screen? `CHECKOUT_IN_PROGRESS` "This client is still paying — try again in a few minutes." uses "client", the pay page "learner".

## UX-71 — `SELF_BOOKING` and `SELF_APPROVAL`

**Trigger:** CO-08 (DR books own plan), approving one's own request via the API.

**Expect:** "You cannot book your own plan." (checkout toast "This Is Your Own Event" / "You host or co-host this event, so you cannot book a seat on it." for events); "You cannot approve your own request".

**Probe further:** a 1:1 plan gets the event toast ("seat")? Record.

## UX-72 — Org-funded checkout refusals (copy only)

**Trigger:** reuse 08's org cases (MO-) and CO-13.

**Expect:** each toast in `payment-error-toast-map.ts` names who can fix it and says the card wasn't charged.

**Probe further:** `CONSENT_WITHDRAWN` (the expert withdrew their booking consent, `occupancy-validate.ts`) toasts "Booking Not Available" / "This consultant has paused bookings; your card was not charged." while the server says "This expert isn't taking bookings right now." Two words for one person on one screen; does the page also hide the expert's other plans or keep offering them? Record. `ORG_CANNOT_SPONSOR`'s server sentence includes "(canSponsor=false)": developer text if it ever reaches a toast. **COPY** (P2).

## UX-73 — Availability editor codes

**Trigger:** S-06, HM-03, HM-05, HM-06 (overlap, zero length, over 12 h, empty set, past custom date), S-05 / TZ-15 (`ZONE`).

**Expect:** `OVERLAP` "Windows 1 and 2 overlap"; `ORDER` "Window 1: start must be before end"; `RANGE` "Window 1: times must be whole minutes from 0 to 1439"; `EMPTY` "Add at least one weekly availability window"; `PAST` "Window 1 has already ended"; `ZONE` (TZ-15); `GRID` "times must start on the hour or half hour".

**Probe further:** "Window 1" means nothing to a consultant looking at a week of days. "whole minutes from 0 to 1439" is developer text. Which of these does the editor show, and which does the client replace with its own (UX-08)? **COPY** (P2) for any raw one shown.

## UX-74 — Grid endpoint refusals

**Trigger:** from the page, call the grid endpoint with a 40-day range, as B1 for H1's own appointment details, and as B2 for another buyer's quota.

**Expect:** `WINDOW_TOO_WIDE` "That date range is too wide. Ask for up to 32 days at a time — the visible week or month."; `NOT_OWNER` "Only this consultant can see their appointment details."; `QUOTA_FORBIDDEN` "You can't see the booking limits for this plan."

**Probe further:** API-only. Note any UI path (month view at a month boundary) that asks for more than 32 days.

## UX-75 — Platform refusals

**Trigger:** DB-27 (`MAINTENANCE_PRODUCTION_ONLY`), DB-29 (`JOB_RUN_PRODUCTION_ONLY`), DB-28 review (`MAINTENANCE_STATE_UNREADABLE`, degraded 503 with no `code`).

**Expect:** each sentence says what is happening and whether retrying helps.

**Probe further:** the degraded 503 has `phase` but no `code`; the allocate page's error map has no entry for it. Predict the toast from code and record it as **ERROR-HANDLING** (P2) pending the owner drill.

## UX-76 — Unknown errors and the generic fallbacks

**Trigger:** collect every generic sentence you met in this suite: allocate 500 "Couldn't save these times — check whether they appear, then retry."; validate 500 "Couldn't check these times. Try again in a moment."; `PAYMENT_LINK_FAILED` (502) "The times were saved, but generating the payment link failed. Approve again to retry the link."; `ILLEGAL_TRANSITION` → "This request changed elsewhere — refreshed"; the inbox's last resort "Something went wrong."; the toast map's "Something Went Wrong".

**Expect:** a generic sentence only for true unknowns, and always with a next step.

**Probe further:** list every place you saw "Something went wrong" and what caused it (network panel). Each one that hid a typed code is **ERROR-HANDLING** (P2).

## UX-77 — `REMIND_RATE_LIMITED` (429) and `NOT_AWAITING_PAYMENT` (409)

**Trigger:** CO-33 (remind twice), CO-34 (remind after the link lapsed).

**Expect:** server "A reminder was already sent in the last 24 hours."; inbox "A reminder went out recently — the next one can go later."; lapsed: "There is no open payment link to remind about. It may have expired or already been paid."

**Probe further:** "the next one can go later": when? The route returns `nextAllowedAt`; the success line uses it ("next in N h"); the refusal doesn't. **MISSED-OPPORTUNITY** (P3).
