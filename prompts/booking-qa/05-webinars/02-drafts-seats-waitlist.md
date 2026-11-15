# 05-b · Webinars: drafts, buying a seat, capacity and the waitlist

**Needs:** `qa-WE-05` (H2, 90 min, ₹500, capacity 5, next Wednesday 18:00 IST) from 05-a; F-PL2 free 60-minute webinar. **[local]** for paid seats.
**Personas:** H2 (IST) host; buyers B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), DR (Australia/Sydney), B4 (IST); ST.
**Docs under test:** `docs/booking/02-event-types-and-validation.md` (capacity), `lib/payments/checkout/handlers/webinar.ts`, `lib/booking/event-waitlist.ts`, `components/booking/CancellationPolicyNote.tsx`, `docs/decisions/2026-09-27-offering-plan-draft-status.md`.

Buyers reach a webinar from the expert page or `/explore/programs/plans/webinars/[planId]`, then `/checkout/plans/webinar/[planId]?eventId=<webinarId>`. A seat is an `AppointmentParticipant` (`role = CONSULTEE`) on the webinar's one shared appointment: `HELD` while a card payment is pending, `CONFIRMED` once paid (or at once for a free webinar). Races on the last seat in depth are 09's (`CC-`).

## WE-15 — A webinar without a time is a draft

**Why it matters:** a published webinar with no session used to be sold with nothing to join.

**Steps:**

1. As H2, open a new webinar in the editor and try to save it with **Scheduled for** empty.
2. Via `evaluate_script`, POST `qa-WE-15` to `/api/bookings/webinars/crud-with-plan` with no `scheduledAt`.
3. As B1, look for `qa-WE-15` on H2's expert page and open its public URL.
4. As H2, open the Offerings list.

**Expect:**

- Step 1: the editor refuses ("Start time is required"; the description says "Required before publishing."). Record whether the editor offers any way to save a time-less draft. If not, a draft without a time can only come from the API or the org catalog: note it.
- Step 2: 2xx; `Webinar.status = DRAFT`, no appointment, no occurrence.
- Step 3: not listed; the public URL is hidden from B1 (404 or not-available page).
- Step 4: the card reads "Not scheduled yet · Schedule now".

**Probe further:** the "Sessions" section says "A webinar goes live once it has a scheduled time." Does the editor's status control (draft/publish) agree with that sentence?

## WE-16 — Schedule a draft from "Schedule now"

**Steps:**

1. As H2, click **Schedule now** on `qa-WE-15`'s card.
2. Read the page (title "Manage timings: <title> — Familiarise"). Place one 60-minute session on a Free cell next Friday 19:00 IST. Save.
3. Reload the Offerings list and the public page as B2.

**Expect:**

- URL `/dashboard/consultant/[cid]/appointments/unscheduled-webinar-<id>/timings`; the grid (desktop) for one session.
- After save: an appointment with one occurrence (13:30Z–14:30Z); record `Webinar.status` (it should become `SCHEDULED` or stay `DRAFT` until published; report what the card says).
- B2 sees Friday 13:30–14:30 London if published.

**Probe further:**

- This path uses the week grid, not the `SingleTimePicker` the editor uses. Same rules? Try an off-hours cell (grid) vs Outside your hours (picker): do they agree that a host may run a webinar outside hours?
- At 390×844 the grid shows the desktop-only notice. Can a phone host schedule a draft webinar at all? The editor's picker works on a phone; does "Schedule now" send them to the editor instead?

## WE-17 — A draft can't be published without a time; status changes only through the editor or cancel

**Steps:**

1. Via `evaluate_script`, PATCH `qa-WE-15` (still DRAFT, no session if WE-16 wasn't saved; else use a fresh API draft) with `status: "SCHEDULED"` and no `scheduledAt`.
2. PATCH with `status: "CANCELLED"`.
3. `PUT /api/bookings/webinars/[webinarId]` with `{ "status": "CANCELLED" }`.

**Expect:**

- 1 → refused (record status, code and copy); still DRAFT.
- 2 and 3 → 409 `USE_CANCEL_ROUTE`, "Cancel a webinar through its cancel action, not an update."

**Probe further:** step 1's copy should tell the host to pick a time first. Raw validation text is **ERROR-HANDLING**.

## WE-18 — Register for a free webinar

**Steps:**

1. As B1, open F-PL2's free 60-minute webinar. Read the page (status line, seats, button).
2. Register.
3. As H2, open the webinar's appointment detail and Participants.

**Expect:**

- Page: "Upcoming", "Next session: <date> at <time> <zone>", a seats line, a register button (record its label).
- DB: B1 `CONSULTEE` participant `CONFIRMED`; no gateway step; a zero-amount payment row or none (record). R-05 unchanged (seats don't add host time).
- B1's Appointments lists it in IST; H2's Participants lists B1; seats left drops by 1.

**Cross-check:** bells and outbox for B1 (confirmation) and H2 (new registrant, if any).

**Probe further:** the page shows "Duration: 1 hours" for a 60-minute webinar (`{durationInHours} hours`). **COPY** (P3) if so.

## WE-19 — Buy a paid seat [local]

**Steps:**

1. As B2 (London), open `qa-WE-05`. Read the page and checkout: date in London, Duration, "Seats left 5 of 5", the cancellation note.
2. Pay with mock payment.
3. Repeat as B3 (LA) with a personal card.

**Expect:**

- Checkout note heading "If you cancel this seat", lines "Cancel at least 24 hours before it starts and the seat is refunded in full. Inside that window the seat cannot be refunded." and "You have <N> h of notice left — that is <N − 24> h inside the free-cancellation window." plus the rail line "Any refund for this seat reaches your original payment method in 5–7 working days."
- DB: each buyer `CONSULTEE` participant `CONFIRMED` after capture (it was `HELD` before), `paymentId` set; R-04 per seat: `Payment` `SUCCEEDED` ₹500 (+ tax as shown), `isMockPayment`; earnings for H2 with a 48 h hold after the session.
- B2 sees Wed 12:30–14:00 London; B3 sees Wed 04:30–06:00 Los Angeles. Seats left "3 of 5".

**Cross-check:** H2's Participants (2 buyers), H2 Earnings (pending), each buyer's Payments; bells and outbox.

**Probe further:**

- "that is <N − 24> h inside the free-cancellation window" uses "inside" for the time **before** the window closes, right after a sentence where "inside that window" means the last 24 hours. Report **COPY** (P2).
- Does B3's page say "Wednesday" when it is Wednesday 04:30 in LA, i.e. the same calendar date? Check a Monday 07:00 IST webinar too, which is Sunday 17:30 in LA.

## WE-20 — Registering twice

**Steps:** as B2, open `qa-WE-05`'s checkout again and pay.

**Expect:** the page says "Already Registered" with "Check your email for webinar details and join link."; a forced checkout POST → 409 `ALREADY_REGISTERED`, "You are already registered for this webinar". No second payment.

**Probe further:** "Check your email" — is there a join link in the app too? Where?

## WE-21 — Sold out

**Setup:** as H2, publish `qa-WE-21`: ₹200, capacity **2**, 60 minutes, a Free start 3 days out. B1 and B2 buy seats [local].

**Steps:**

1. As B3, open the public page. Read it.
2. Force a checkout POST as B3.

**Expect:**

- Page: "Sold out — all 2 seats taken", and either "Registration for this session is closed. Ask to be notified and we will tell you the moment a seat opens; the first to pay gets it." with a notify control (waitlist on, the default) or the closed variant.
- API: 409 `EVENT_FULL` ("Webinar is full"). Checkout page copy "This webinar is now full".

**Probe further:** "Webinar is full" is the raw server message; does the UI ever show it?

## WE-22 — Join and leave the waitlist

**Steps:**

1. As B3, click the notify control on `qa-WE-21`.
2. As B3, `POST /api/scheduling/event-waitlist` on a webinar that still has seats (`qa-WE-05`).
3. As H2, turn **Take a waitlist when sold out** off on a sold-out webinar; as B4, try to join.
4. As H2, set **Waitlist size** to 1 on `qa-WE-21`; as DR, try to join after B3.
5. As B3, join waitlists on 5 other sold-out events (if available), then a sixth.
6. As B3, leave `qa-WE-21`'s waitlist.

**Expect:**

- 1 → `AppointmentWaitlist` row, open status; the page says B3 will be notified.
- 2 → 409 `EVENT_NOT_FULL`, "Seats are available — book now."
- 3 → 409 `WAITLIST_DISABLED`, "The host is not taking a waitlist for this session."
- 4 → 409 `WAITLIST_FULL`, "The waitlist for this session is full."
- 5 → 409 `EVENT_WAITLIST_CAP`, "You can wait on at most 5 sessions at once — leave one to add another." (BLOCKED if you can't build 6 sold-out events cheaply.)
- 6 → row closed; B3 can rejoin.

**Probe further:** does H2 see how many are waiting? The editor shows "<n> waiting — raising capacity notifies them." next to Max participants.

## WE-23 — A seat frees: everyone waiting hears at once [local]

**Steps:**

1. B3 and DR are on `qa-WE-21`'s waitlist.
2. As B1, leave `qa-WE-21` outside the refund window (WE-46 covers the refund).
3. Check R-07 outbox for B3 and DR. As DR, follow the notice link and pay first. As B3, follow it second.
4. Within 12 hours, as B2, leave too.

**Expect:**

- Step 3: one notice each for B3 and DR (both at once), linking to `/checkout/plans/webinar/[planId]?eventId=…`. DR's checkout succeeds; B3's answers 409 `EVENT_FULL` ("The last seat went while this page was open, so we stopped the payment before you were charged." on the checkout page).
- DR's waitlist row is marked booked.
- Step 4: B3 gets no second notice inside the 12-hour cooldown (record whether the seat sits unannounced).

**Probe further:** the waitlist copy promises "we will tell you the moment a seat opens". Is a 12-hour silence a broken promise? Note for the owner.

## WE-24 — Changing capacity with people registered or waiting

**Steps:**

1. As H2, edit `qa-WE-21` (2 registered): set Max participants to 1. Save.
2. Set it to 3. Save.

**Expect:**

- 1 → 400 "Cannot set capacity to 1 — 2 people are already registered. Remove participants first."
- 2 → 200; waiters notified (as WE-23); seats left 1 of 3.

**Probe further:** the field's hint "<n> waiting — raising capacity notifies them." — does it disappear once nobody waits?

## WE-25 — Two buyers on the last seat (basic)

**Why it matters:** exactly one gets it; nobody pays for a seat they don't get.

**Setup:** `qa-WE-21` at 2 of 3 after WE-24.

**Steps:** in two browser contexts `[two-browser]`, B4 and DR open checkout and pay within a few seconds of each other.

**Expect:** one seat `CONFIRMED`; the other gets 409 `EVENT_FULL` before any charge, or a `HELD` seat that never confirms and is released. R-04: no `SUCCEEDED` payment without a seat. Depth (exact timing, idempotency, abandoned holds) in 09.

**Probe further:** while one buyer's payment is pending, the seat is `HELD` and counts toward capacity. How long? What does the other buyer see meanwhile?

## WE-26 — Registering after the start, before the end

**Setup:** an H2 webinar whose occurrence is shifted (owner-approved) to have started 10 minutes ago and end in 50.

**Steps:** as B4, open it and register. Then shift it to have ended; try again.

**Expect:**

- During: the page says "Happening Now" / "Session in Progress"; record whether registration is offered. The server allows it while the end hasn't passed.
- After: "This webinar has already ended. It can no longer accept registrations." (server) / "This webinar session has already ended. Please go back." (checkout).

**Probe further:** a late buyer is already inside the 24-hour window, so they can never leave with a refund. Does checkout say so? (`CancellationPolicyNote`: "The free-cancellation window for this webinar closed; a cancellation now refunds nothing on this seat.")

## WE-27 — The host and co-hosts can't buy their own webinar

**Steps:**

1. As H2, open `qa-WE-05`'s checkout and submit.
2. After WE-50 makes H3 a co-host, as H3, the same.

**Expect:** 409 `SELF_BOOKING`, "You cannot book your own plan." for both.

**Probe further:** does the public page hide the button for the host, or let them fail at checkout?

## WE-28 — What each side sees of a sold webinar

**Why it matters:** counts and times must agree everywhere.

**Steps:** with `qa-WE-05` holding B2 and B3, visit: H2's Appointments row and detail, Participants, Offerings card (seats `2/5`), `sell/programs` Webinars tab, Earnings; B2's and B3's Appointments and Payments; ST's booking view.

**Expect:** the same start everywhere, each in the viewer's zone (IST, London, LA; staff in its profile zone); 2 seats taken; H2's earnings pending; no buyer sees another buyer's name or payment.

**Probe further:** does any list say "1 attendee" counting H2's own host participant? (`assertGroupEventUnsoldInTx` counts buyers only; displays should too.)
