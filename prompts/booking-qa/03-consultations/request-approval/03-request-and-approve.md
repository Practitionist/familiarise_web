# 03-c · Consultations: request and approve (use requested, manual, auto)

**Needs:** 01 (S-07, S-09, S-10, F-AV1), 02's G-REQ optional. Preview OK for requesting and approving; paying the link needs a gateway (03-d).
**Personas:** H1 (IST), B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), DR.
**Docs under test:** `docs/booking/06-booking-lifecycle.md` §7 and "Approval-path corrections", `.claude/skills/booking/SKILL.md` doctrine §5, `lib/booking/approve-request.ts`, `lib/booking/request-caps.ts`, `lib/booking/lead-time.ts`.

**Mode for this file:** at the start, as H1 set Settings → Booking → "Review requests first" (S-07) and record `bookingMode = 'REQUEST'`. CO-45 (end of 03-d) switches back. While H1 is in REQUEST mode, every new H1 consultation, subscription and trial comes in as a request: don't run 04 or 07 for H1 in parallel.

How a request reaches H1: a request exists only when the expert reviews requests first (`bookingMode = 'REQUEST'`, Settings → Booking → "Review requests first"); an instant-booking expert's times go to checkout and the request door refuses them (CO-24). B presses **Book Now** on a plan card and picks a day in the month, then a time in the day's list (the dark single-time picker); under REQUEST mode the button reads **Request this time** with the line "Request this time — the expert confirms before you pay." Times already taken sit behind "Show N taken times", each with **Notify me**. The request is `POST /api/scheduling/request-for-approval`. H1 answers in `/dashboard/consultant/[H1 cid]/requests` (row actions "Approve", "Decline", later "Remind", "Withdraw approval") or on the allocate page (`…/requests/[rid]/allocate`: manual pick, Auto-schedule, Save picked times).

After every case: R-03, R-04 (if money), R-05 (H1), R-07.

## CO-20 — B1 requests a 90-min consultation

**Why it matters:** the request is a real hold on the expert's time and the start of the approval path.

**Steps:**

1. As B1 open H1's expert page → "qa-S-10 Deep dive" (90 min) → **Book Now** → in the month pick Mon D+7, then 09:00 IST (03:30Z) in the day's list.
2. Read the button and the line above it. Submit with **Request this time**.
3. Read the confirmation and B1's appointments list and detail.
4. As B2 open the same day on H1's page.

**Expect:**

- API: `POST /api/scheduling/request-for-approval` → 2xx.
- API body: carries `availabilityWindowWeeklyId` (or `availabilityWindowCustomId`) for the picked row; a body without one is refused 400 "Must provide either weekly or custom slot availability ID".
- DB: `Consultation` `PENDING`, `bookingSource = 'REQUEST_SUBMITTED'`, `requestNotes` starts "Request for approval - Slot:" and names the availability row; an `Appointment` with a tentative occurrence 03:30Z–05:00Z (or the requested window stored on the request; record which); history `CREATED`.
- B1 sees "waiting for approval" wording (quote it), no pay button.
- B2: 09:00 is no longer among the free times; "Show N taken times" lists it with **Notify me**. Press **Notify me**: it reads "Waiting" with **Withdraw**; withdraw again before moving on.
- Outbox/bell: H1 notified ("NEW_BOOKING_REQUEST").

**Cross-check:** H1 Requests row: B1's name, the time in IST "Mon <d> 9:00 am IST", the amount line, a countdown to expiry ("Nd left" / "Nh Nm left").

**Probe further:** B1's detail: does it say how long the expert has to answer (48 h) and what happens if they don't? MISSED-OPPORTUNITY if not.

## CO-21 — Request refusals: too soon, wrong length, off grid, taken

**Why it matters:** each request door refusal must be typed and readable; none may create a row.

**Steps (as B2, `evaluate_script`, copy CO-20's request body and vary it):**

1. Start = now + 90 min (a priced request inside the 2-h request lead).
2. A 60-min window for the 90-min plan (salvaged from old 014 Phase 5).
3. Start at 09:15 IST (off the UTC half hour).
4. CO-20's exact time (already held by B1's request).
5. A plan id that is a DRAFT (S-13's draft plan is a subscription; use any DRAFT consultation you create as "qa-CO-21 draft").

**Expect:**

- 1: 409 `REQUEST_TOO_SOON` (copy names the 2-hour notice).
- 2: 400 `WINDOW_DURATION_MISMATCH`.
- 3: 400 `SLOT_NOT_ON_GRID` "Times start on the hour or half hour".
- 4: 409 `SLOT_TAKEN`.
- 5: 4xx `PLAN_NOT_PUBLISHED`.
- No new `Consultation` rows (R-08).

**Probe further:** the UI path for 1: does the expert page even list times inside 2 h for a REQUEST-mode priced plan (it shouldn't; the picker uses the request lead, and those times are not in the taken list either)? For 4, through the UI: B2 picks a time B1's request holds before the page refreshes; the pick clears, "That time was just taken — pick another." shows and the taken list opens with that time.

## CO-22 — Request caps: consultee's three, the expert's queue limit, the pause

**Why it matters:** caps keep a queue answerable; each must say what to do next.

**Steps:**

1. As B3 send requests to H1 for S-10 at three different free times (Tue D+8 09:00, Wed D+9 09:00, Thu D+10 09:00 IST). Then a fourth (Fri D+11 09:00).
2. As H1 set "Limit open requests to" = 1 (Settings → Booking). As B2 request Tue D+8 17:00.
3. Clear the limit. As H1 switch off "Taking new 1:1 bookings and trials"; as B2 request again. Switch it back on.
4. As B3 cancel the three requests from B3's appointments ("Cancel consultation request?" → "Nothing was paid for this, so there is nothing to refund.").

**Expect:**

- 1: the fourth gets 4xx `REQUEST_CAP_REACHED`: "You already have 3 requests waiting for an answer. Wait for an expert to reply, or withdraw one from your dashboard, then try again."
- 2: 409 `CONSULTANT_AT_CAPACITY`: "This expert's request queue is full — try again in a day or two, or pick another expert." (H1 already has more than one open request.)
- 3: 409 `CONSULTANT_PAUSED`.
- 4: the three become `CANCELLED` (abandon door; not EXPIRED, not REJECTED); their holds released.

**Probe further:** does H1's Requests page show a banner when paused or at capacity? Does B3 see in advance that the expert's queue is full (before typing a note)?

## CO-23 — Request submission is idempotent

**Why it matters:** a double tap must not create two requests or two holds.

**Steps:** as B2, send CO-20's body (new time: Tue D+8 11:00 IST) twice with the same `Idempotency-Key` header; then the same key with a different time.

**Expect:** the second call replays (same consultation id; `Idempotent-Replay: true` header if implemented; record). One `Consultation`. The third call: 4xx `IDEMPOTENCY_KEY_REUSED`. R-07 `IdempotencyRecord` rows for B2.

**Probe further:** the UI submit is disabled while in flight (count requests on a double click). Deep matrix: 09.

## CO-24 — Instant mode never turns a held time into a request

**Why it matters:** a request exists only for a review-first expert. Under "Instant booking", a time someone else holds is taken, with "Notify me"; it never becomes an unpaid request the expert must approve.

**Setup:** switch H1 to "Instant booking" for this case only. CO-20's request holds Mon D+7 09:00.

**Steps:**

1. As B2 open H1's expert page → S-10 → **Book Now** → Mon D+7. Read the free times, the button and "Show N taken times".
2. Open the taken list; read the 09:00 row.
3. Via `evaluate_script`, send CO-20's request body for another free time to `POST /api/scheduling/request-for-approval`.

**Expect:**

- 1: 09:00 is not among the free times; the button reads **Continue to Checkout** with no request line.
- 2: 09:00 is listed greyed with **Notify me** and the line "You can wait on up to 3 times."
- 3: 409 `REQUEST_NOT_OFFERED`, "This expert takes instant bookings. Pick a free time and continue to checkout."; no row.

Switch H1 back to "Review requests first".

**Probe further:** is a time that is simply free ever listed as taken (false positive)? Check two free times against the grid.

## CO-25 — Approve with "Use requested times" (priced): pay link and pre-allocation

**Why it matters:** an approval of an unpaid request must never confirm a booking nobody paid for.

**Steps:**

1. As H1 open Requests. On B1's CO-20 row click **Approve** (requested times exist, so Approve confirms them).
2. Read the toast ("Sessions scheduled" / "The requested times are confirmed." or similar) and the row afterwards.
3. As B1 open home, appointments and detail.

**Expect:**

- DB: `Consultation.status = 'APPROVED_PENDING_PAYMENT'`; `pendingPaymentUrl` set; a `Payment` `PENDING` written **before** the gateway call (pre-mint) with `expiresAt` = min(approval + 24 h, session start − 15 min); the occurrence at Mon D+7 03:30Z exists (pre-allocated; record `isTentative`).
- On a preview without gateway keys the mint may fail: record `PAYMENT_LINK_FAILED` and what H1 and B1 see (the request must not be left APPROVED without money).
- B1: a pay call to action (pending-payments widget) with the amount, the deadline in IST and "Cancel booking"/"Keep booking".
- H1's row now offers "Remind" and "Withdraw approval"; the amount line shows awaiting payment.
- Outbox: pay-link email to B1; bell for B1.

**Cross-check:** H1's grid paints the time as held; staff `/dashboard/staff/…` "Awaiting payment" panel ("Approved, not paid yet. …").

**Probe further:** the pay deadline shown to B1 equals `Payment.expiresAt` in B1's zone. "The pay link stays open for 24 hours" (S-07 copy) is false when the session is less than 24 h away: check with a request for tomorrow (CO-28).

## CO-26 — Approve by picking a different time on the allocate page (manual)

**Why it matters:** the expert may answer a request with another time; the requested window must close and the client must hear the real time.

**Setup:** a new request from B2 for S-10 at Tue D+8 09:00 IST.

**Steps:**

1. As H1 open the request's allocate page. The requested time has the "Requested" outline (02).
2. Pick Tue D+8 17:00 instead (90 min). Click **Save picked times**.

**Expect:**

- `APPROVED_PENDING_PAYMENT`, the occurrence at 11:30Z–13:00Z, a pay link; the 09:00 hold released.
- B2 sees 17:00 IST as 11:30 GMT with wording that the time changed from what they asked (quote it; MISSED-OPPORTUNITY if B2 isn't told it differs).
- History reason token `schedule:by-hand` (or the consultation equivalent; record).

**Probe further:** the tray shows "Session 1 · Tue … 5:00 pm–6:30 pm"; the context row "Requested window". Does the success toast say "The times you picked are confirmed." even though payment is pending? That would be FALSE-INFO.

## CO-27 — Approve with Auto

**Why it matters:** auto must pick the earliest fit inside hours, honouring the unpaid 2-h lead.

**Setup:** a new request from B3 for S-10 at Wed D+9 17:00 IST.

**Steps:** as H1 open its allocate page → **Auto-schedule**. Read the result.

**Expect:** one 90-min occurrence at the earliest free fit at least 2 h ahead inside F-AV1 (likely today/tomorrow morning, not B3's requested time; record), `APPROVED_PENDING_PAYMENT`, pay link. Toast "Sessions scheduled" / "All sessions were placed automatically." History records the auto choice.

**Probe further:** report whether Auto ignoring the client's requested time is what an expert expects. Should Auto prefer the requested window? (Product question; note.) Salvaged from old 003 Test 4.3: on another fresh request, send the allocate PATCH with both `isAuto: true` and a `slots` array; record which wins (the doc says `useRequestedSlots` wins, else `isAuto`, else manual). R-05 zero rows.

## CO-28 — The unpaid 2-hour lead on approval

**Why it matters:** an unpaid approval needs time to pay; the grid and the server must agree.

**Steps:**

1. B2 requests S-10 for the first time offered today or tomorrow (at least 2 h ahead).
2. Owner-approved: move the requested window so the slot starts in 90 min (keep the UTC half hour).
3. As H1 Approve (Use requested times).

**Expect:** 409 `TOO_CLOSE_TO_START` (copy says it's too close to pay for; record); the request stays `PENDING`. On the allocate grid the next 2 h paint Too soon ("Earliest start" chip = now + 2 h).

**Probe further:** what should H1 do next? The UI should offer another time or Auto. Is the pay deadline min(24 h, start − 15 min) visible when approving a session 3 h away?

## CO-29 — Approving a free request lands APPROVED with no pay link

**Why it matters:** a free plan has nothing to pay; it must confirm on approval.

**Steps:** as B1 request "qa-S-09 Intro call 30" for Thu D+10 10:00 IST. As H1 Approve.

**Expect:** `Consultation.status = 'APPROVED'` (or `SCHEDULED`; record), no `pendingPaymentUrl`, no PENDING `Payment`, a confirmed occurrence. B1 sees a confirmed booking.

**Probe further:** any "awaiting payment" or "pay now" copy anywhere is FALSE-INFO (P1).

## CO-30 — Approval guards: own request, a booking being moved, already confirmed

**Why it matters:** the decision doors refuse the shapes that would corrupt a booking.

**Steps (`evaluate_script`):**

1. DR (if dual-role) requests DR's own plan and approves it as DR: `PATCH /api/bookings/consultations/[id]` `{ status: "APPROVED" }`.
2. As H1, `PATCH … { status: "APPROVED" }` on CO-29's already-approved booking.
3. On a booking with an open reschedule (from 03-e), `PATCH … { status: "REJECTED" }`.

**Expect:** 1: 4xx `SELF_APPROVAL` "You cannot approve your own request" (or BLOCKED if DR isn't dual-role). 2: a typed 409 ("This booking was already confirmed. Place a new time, or cancel it to refund the client." or `ILLEGAL_TRANSITION`). 3: 409 `USE_RESCHEDULE_RESPOND` "This booking is being moved, not requested. …".

**Probe further:** these are API-level; does any UI button lead to them? Hidden buttons are the right fix; quote any visible one.

## CO-31 — Stale tab: approving a request the expert already handled

**Why it matters:** two tabs must not approve twice or place two sessions.

**Steps:** open B3's CO-27 request page in two tabs before approving; approve in tab 1 (Auto); in tab 2 click Approve / Save picked times.

**Expect:** tab 2 gets 409 `ALREADY_ALLOCATED` ("Already allocated" toast, dialog closes, row drops) or `RESCHEDULE_STATE_CHANGED` ("Request changed — please resubmit"). One occurrence. Depth: 09.
