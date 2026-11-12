# 03-a · Consultations: instant booking, free booking, checkout refusals

**Needs:** 01 (F-AV1, S-08, S-09, F-BUSY). `[local]` cases need mock pay.
**Personas:** H1 (IST), B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), B4 (IST), DR (Australia/Sydney).
**Docs under test:** `docs/booking/06-booking-lifecycle.md` §5, §6, §9; `docs/booking/10-checkout-payment-integration.md`; `docs/booking/22-explore-booking-dialog.md`; `.claude/skills/booking/references/money-boundary.md` §8.

Every booking case ends with: R-03, R-04, R-05 (H1), R-07 (outbox for the appointment id), and the cross-check list below. Money depth (GST lines, credit notes, payout holds) is 08; races are 09.

Standard cross-check for a consultation (do all unless a case narrows it):

- consultee: home, `…/appointments` list, `…/appointments/[aid]` detail, `…/payments`;
- consultant: home ("today"/"upcoming"), `…/appointments`, `…/appointments/[aid]`, `…/earnings`, the H1 grid (Booked block, see 02);
- staff: `/dashboard/staff/appointments` (search by id);
- bell for both parties; `NotificationOutbox` rows (kind, recipients, `notBefore` for reminders);
- the time in **each party's zone** equals the DB UTC instant.

## CO-01 — Instant priced booking from the expert page `[local]`

**Why it matters:** the main money path; a booking must be confirmed only when paid, on every surface at once.

**Setup:** H1 in "Instant booking" (S-07). Pick Wed D+2 10:00 IST (04:30Z).

**Steps:**

1. As B1 open `/explore/experts/[H1 cid]`, choose "qa-S-08 Strategy call 60", **Book Now**.
2. Pick Wed D+2, then 10:00. Read the button ("Continue to Checkout") and any sentence under it.
3. On `/checkout/plans/consultation/[planId]` read the summary: date, time, zone, duration, price, taxes, the "Who is paying?" block (B1 has no sponsor: it should be absent).
4. Click **Mock Pay (Razorpay)**. Read the success copy and where it sends you.

**Expect:**

- UI: "Mock payment processed. Your consultation has been confirmed. Check your dashboard for details."
- DB: one `Consultation` (`bookingSource = 'DIRECT_CHECKOUT'`, status recorded: `SCHEDULED` or `APPROVED`), one `Appointment`, one occurrence 04:30Z–05:30Z `isTentative = false`; `Payment` `SUCCEEDED`, `isMockPayment = true`, amount 50000 paise + `taxAmount` (record); one `CONSULTANT` and one `CONSULTEE` participant; `BookingStatusHistory` starts with `CREATED`.
- Money: one `ConsultantEarnings` row with `holdUntil` set; platform fee + consultant share = gross.
- R-05: zero rows.

**Cross-check:** standard list. B1 and H1 both see Wed D+2 10:00 IST. The confirmation email subject (outbox) names the right time. A reminder row exists with `notBefore` before the session (record the offset).

**Probe further:** reload the success page (no second booking). Back button to checkout: does it offer to pay again? What does B1's appointment detail say about joining ("Join" appears when?), cancelling (does it show the refund policy before B1 clicks?), and rescheduling (24-hour rule stated)? Any "Awaiting schedule confirmation" text on a confirmed booking is FALSE-INFO.

## CO-02 — Buyer and host in different zones `[local]`

**Why it matters:** the commonest false-time bug is one surface rendering the wrong zone.

**Setup:** B2 profile `Europe/London`.

**Steps:** as B2 book S-08 at Thu D+3 17:00 IST (11:30Z) with Mock Pay. Read every time shown to B2 (dialog pill, checkout summary, success, appointments, detail, email subject in outbox). Then read H1's views.

**Expect:** B2 sees 11:30 (GMT, or 12:30 if BST; November is GMT) everywhere, with a zone label at least once on each page; H1 sees 17:00 IST. DB 11:30Z. Outbox: B2's mail in London time, H1's in IST.

**Cross-check:** standard list in both zones.

**Probe further:** set the browser to `Asia/Kolkata` (emulate) while signed in as B2: pages must still show London time (profile zone). Report any surface that follows the browser. Depth: 10.

## CO-03 — Checkout refuses starts too soon, off the grid, the wrong length or outside hours

**Why it matters:** the server is the only guard that counts; each refusal must be typed and human.

**Setup:** B1 signed in. Copy one real checkout body from CO-01's network panel (`POST /api/checkout`) and replay variants with `evaluate_script` (keep `isMockPayment: true` locally; on a preview the refusal still fires before payment).

**Steps:**

1. Start = now + 10 min (rounded to the next :00/:30 if that's inside 15 min).
2. Start at 10:15 IST (04:45Z, off the UTC grid).
3. A 2-hour window for the 60-min plan (salvaged from old 014 Phase 5).
4. A start at 14:00 IST (inside the 13:00–17:00 gap).
5. A start of Sunday 10:00 IST.

**Expect:**

- 1: 4xx `SLOT_TOO_SOON` (start within the 15-min book lead).
- 2: 400 `SLOT_NOT_ON_GRID`, "Times start on the hour or half hour".
- 3: 400 `WINDOW_DURATION_MISMATCH`, "The selected time must match the plan length (…)".
- 4 and 5: a typed 4xx for outside availability (record the code; union coverage refuses the first uncovered atom).
- None creates a `Payment`, `Appointment` or occurrence (SQL by plan id and time).

**Probe further:** the UI path for 1: open the dialog at a time just before a :00/:30, wait until the slot enters the 15-min lead, then continue. Does the checkout page refuse with words, or with "Error 4xx"? Does it send B1 back to a refreshed list?

## CO-04 — A time taken between picking and paying `[local]` `[two-browser]`

**Why it matters:** the slot lock is the only correctness guarantee; the loser must be told plainly and nobody charged.

**Steps:**

1. B1 opens S-08's checkout for Fri D+4 09:00 IST (stop on the checkout page).
2. In the second page, B2 books the same time with Mock Pay.
3. B1 clicks Mock Pay.

**Expect:** B1 gets 409 `SLOT_TAKEN` and "That time was just taken — pick another." and is returned to a refetched list without 09:00. No `Payment` for B1 (or one marked failed/expired; record). R-05 zero rows.

**Probe further:** truly parallel submits are 09's. Does B1's chosen plan and date survive the bounce, or does B1 start over?

## CO-05 — Double submit at checkout replays, never double-books `[local]`

**Why it matters:** a double click must not buy two sessions.

**Steps:** from CO-01's body, send `POST /api/checkout` twice in a row with the same `clientIdempotencyKey` (a fresh UUID) for Sat D+5 10:00 IST. Then once more with a new key for the same time.

**Expect:** the second call replays the first (same appointment id in the body; record any replay header); exactly one appointment and one payment. The third call (new key, same time) gets `SLOT_TAKEN` (the time is now booked by B1 itself) or a duplicate-booking refusal; record which and its copy.

**Probe further:** the UI disables Mock Pay while in flight (click twice fast and count `POST /api/checkout` requests). Deep idempotency matrix: 09.

## CO-06 — A paused expert takes nothing new; existing bookings are untouched

**Why it matters:** salvaged from old 014 Phase 6. Pausing is the expert's only vacation switch.

**Steps:**

1. As H1, Settings → Booking: switch off "Taking new 1:1 bookings and trials". Save.
2. As B2 open H1's expert page. Read the plan cards and the CTA.
3. From `evaluate_script` as B2: `POST /api/checkout` for S-08 (any free time) and `POST /api/scheduling/request-for-approval` for S-10.
4. As B1 open CO-01's booking: detail, cancel preview (don't confirm), reschedule page.
5. Switch the toggle back on.

**Expect:**

- 2: the CTA reads "Not taking new 1:1 bookings" and the copy "This expert is not taking new 1:1 bookings right now — pick another expert or try again later. Their webinars and classes stay open."
- 3: checkout 409 `NOT_ACCEPTING_BOOKINGS`; request 409 `CONSULTANT_PAUSED` ("This expert is not taking new requests right now. Pick another expert, or try again later."). No rows created.
- 4: works normally.

**Probe further:** does H1's own dashboard show a "paused" banner (the Requests page reads the same setting)? Do H2's webinars still sell (they should)?

## CO-07 — Free consultation: no gateway, instant confirm

**Why it matters:** free bookings skip the gateway; they must still create the full booking graph and nothing pretends money moved.

**Setup:** preview OK (no mock pay needed). S-09 (30 min, free).

**Steps:** as B4 book S-09 at Mon D+7 09:30 IST (04:00Z). Read the CTA, checkout page and success copy.

**Expect:**

- UI: no card form or "Pay" label; the CTA says something like "Book" or "Confirm"; no ₹0.00 payment step. Record the exact copy.
- DB: consultation confirmed; occurrence 04:00Z–04:30Z non-tentative; a `Payment` with amount 0 (record `paymentIntent` prefix; zero-amount path mints `free_…`) or no payment row (record which); no `ConsultantEarnings` with money, or one with 0.
- R-05 zero rows.

**Cross-check:** standard list. Earnings show nothing owed for it (not "₹0 held until …" noise; judge it). B4's payments list: does a ₹0 row appear? Is it useful or noise?

**Probe further:** cancelling a free booking moves no money (CO-77). A free plan in REQUEST mode lands APPROVED, not APPROVED_PENDING_PAYMENT (CO-31).

## CO-08 — Self-booking is refused (dual role)

**Why it matters:** an expert buying their own plan would mint earnings from nothing.

**Setup:** DR has a consultant profile with a published consultation plan (S-01 says whether). If not, BLOCKED.

**Steps:** as DR, open DR's own expert page and try to book DR's plan (UI, then `POST /api/checkout`).

**Expect:** refused with a typed 4xx and a plain message (self-booking is rejected in the in-lock revalidation). No rows.

**Probe further:** does the expert page even show Book Now to its own owner? (MISSED-OPPORTUNITY to explain "this is your page".)

## CO-09 — The consultee can't allocate their own booking

**Why it matters:** salvaged from old 014 Phase 1. Allocation is host-side only.

**Steps:** as B1, `PATCH /api/bookings/consultations/[CO-01 consultationId]/allocate` with `{ isAuto: false, slots: ["<Fri D+4>T05:30:00Z"] }`. Then as H2 (another expert) the same call.

**Expect:** both 403 with `errorCode: "ALLOCATE_FORBIDDEN"` (or 403 with a typed code; record). DB unchanged.

**Probe further:** ST (staff) on the same route: allowed or 403? Record. The full authz matrix is 09.

## CO-10 — The buyer walks away before paying (abandon door)

**Why it matters:** a held time must come back when the buyer leaves, and a late capture must not be lost.

**Setup:** needs a real `PENDING` payment (Razorpay test keys). Without keys, BLOCKED (no gateway).

**Steps:**

1. As B2 start checkout for S-08 at Tue D+8 10:00 IST and close the Razorpay window.
2. SQL: the PENDING payment and the tentative occurrence.
3. As B2, `POST /api/bookings/[bookingId]/abandon` (or the "Cancel booking" action on B2's pending-payment widget: "Keep booking" / "Cancel booking").
4. Repeat abandon.

**Expect:** step 3 cancels the consultation (`CANCELLED`, not `EXPIRED`), expires the PENDING payment by CAS, releases the hold (occurrence `CANCELLED` + `deletedAt`), and 10:00 is offered again. Step 4: idempotent or a typed 409. If a capture lands before abandon, the abandon answers 409 `ALREADY_PAID` and the normal cancel quote owns it.

**Probe further:** the unattended version (hold lapses by clock, then sweep) is HM-14 and 12.

## CO-11 — What the booking looks like tomorrow

**Why it matters:** "think one step ahead": reminders, join window and completion must line up after booking.

**Setup:** CO-01's booking (Wed D+2 10:00 IST).

**Steps:**

1. R-07 for the appointment: list every outbox row with `notBefore` and `kind`.
2. Owner-approved: shift the occurrence to start in 10 min (on the UTC half hour if possible, else note it) and reload both details.
3. Shift it to have ended 1 h ago. Reload. (Completion runs in a sweep: 12.)
4. Restore the original times.

**Expect:** reminders scheduled before the start (record offsets); within the join window both parties see "Join"; the cancel action shows `SESSION_IN_PROGRESS` copy inside 15 min (CO-73); after the end, the booking shows as awaiting completion or completed (record the words); no raw status.

**Probe further:** if a reminder has already been sent for the old time, does restoring the time leave a stale reminder? (Moves of real bookings are 03-b; flag any reminder that keeps the old time.)
