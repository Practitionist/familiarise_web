# 11-a · Dashboards: the same booking seen by every role

**Needs:** bookings left by earlier folders (named per case), or create them as the case says. `[local]` where a fresh paid booking is needed.
**Personas:** H1, H2 (IST), B1 (IST), B2 (London), B3 (LA), B4 (IST, Wipro learner), DR (Sydney, dual role), OS (Wipro OWNER, sponsor), OH (LearnPro OWNER, host org), OX (LearnPro expert), ST, AD.
**Docs under test:** `lib/dashboard/money-state.ts` (`deriveBookingPresentation`, booking labels), `lib/dashboard/action-items.ts` (Home "Needs you"), `components/dashboard/shared/requests/labels.ts` (inbox chrome), `docs/booking/06-booking-lifecycle.md`, `docs/booking/17-org-funded-checkout.md`.

**Booking labels the code defines (`BOOKING_LABEL`):** Requested · Awaiting payment · Payment lapsed · Confirmed · Awaiting schedule · Completed · Cancelled · Declined. There is no label for "being moved"; a booking with an open reschedule shows one of these. Inbox chips: Answer today · Awaiting payment · Next cycle · Declined. Inbox buckets: Answer today · This week · Later · Waiting on the client.

**For every case:** read each listed surface and fill one row per surface: status label, money label, time (with zone), primary action, counts. Then compare rows. Any two rows that disagree on state, money or time are an **INCONSISTENCY**. Use N-1/N-2 from `../10-timezones-dst-locale/01-cross-zone-odd-offsets-overnight.md` for bell and email rows.

## DB-01 — The viewer matrix and the bookings this folder reads

**Steps:**

1. R-01 for every persona. Confirm DR's roles (consultant and consultee profiles, Wipro LEARNER membership) and OX's LearnPro EXPERT membership.
2. R-08 for `qa-` rows. Map each to a case below (consultation instant: CO-01; request: CO-20; awaiting payment: CO-25; lapsed: CO-36; being moved: CO-47; cancelled: CO-71; completed: any; subscription: SU-23/SU-37; webinar: WE-19; class: CL-27; trial: TR-01; Wipro-sponsored: CO-12; LearnPro-hosted: CO-17).
3. For any missing state, create it as the case says.

**Expect:** a ledger table: state → appointment id → personas who should see it.

**Probe further:** none; this is set-up.

## DB-02 — A confirmed paid consultation in every view `[local]`

**Needs:** CO-01's booking (B1 ↔ H1) or a fresh one.

**Steps:**

1. As B1: Home, Appointments (list and calendar), detail, Payments, payment detail.
2. As H1: Home ("today" or upcoming), Appointments, detail, Earnings.
3. As ST: `/dashboard/staff/appointments` (search the id), `/dashboard/staff/payments/[paymentId]`.
4. As AD: `/dashboard/admin/appointments` and the same payment.
5. R-03, R-04, N-1, N-2.

**Expect:**

- Status "Confirmed" for both parties; money "Paid" (consultee) and an earnings line for H1 with the hold (R-04 `holdUntil`).
- Same start time (each in its own zone), same plan title, same amount (₹500.00) everywhere.
- Staff and admin trees show the same row; the admin tree exposes money actions the staff tree shows read-only (`refunds.manage` is admin-only).

**Probe further:** does the consultee detail show what happens next (join window, cancel deadline, refund tiers)? Does H1's detail show the buyer's name, notes and zone? List every missed chance as **MISSED-OPPORTUNITY**.

## DB-03 — A request waiting for the expert

**Needs:** H1 in "Review requests first" mode and CO-20's request (B1), or a fresh one.

**Steps:**

1. As H1: Home ("N request(s) to answer"), Requests inbox (which bucket, which chip), the request detail.
2. As B1: Home, Appointments, detail.
3. As ST: the appointment in the staff list.

**Expect:**

- H1 Home: "1 request to answer" / "Learners are waiting on you before they can book." The inbox row sits in **Answer today** if under a day remains to reply, else **This week** or **Later**, with a deadline.
- B1: "Requested", the requested time, no pay button, a way to withdraw.
- Counts: Home count = number of rows in the inbox's Consultations tab with a reply due = R-08 pending rows for H1.

**Probe further:** does B1 see when the request expires (48 h, CO-40)? Does H1's row show the buyer's local time for the requested slot? Does the inbox hint "Answer today" match the true deadline (`expiresAt`)?

## DB-04 — Approved, waiting for payment

**Needs:** CO-25's approved priced request (a live pay link).

**Steps:**

1. As B1: Home (outstanding payment item), Appointments, detail, the pay link.
2. As H1: Requests (bucket "Waiting on the client", chip "Awaiting payment"), detail, Home.
3. R-04: `Payment.expiresAt`, `paymentStatus = PENDING`.

**Expect:**

- B1: "Awaiting payment"; the money line "You pay (link valid until <expiresAt in B1's zone>)"; Home "1 payment is outstanding · ₹750.00" / "Your booking isn't confirmed until payment clears."
- H1: the row under "Waiting on the client", hint "They need to pay, answer your new time, or finish checkout."; a Remind action.

**Probe further:** when the presentation has no hold expiry it prints "(link valid 24 h)" (`lib/dashboard/money-state.ts`). That is false when the link was clamped to start − 15 min (writer report bug 5, TZ-45). Force it: a request whose start is under 24 h away. Report **FALSE-INFO** (P1) if "valid 24 h" shows.

## DB-05 — A lapsed pay link: three names for one state

**Needs:** CO-36's EXPIRED request, or CO-34's lapsed link.

**Steps:** as B1, read the Appointments badge, the detail timeline and the Home row. As H1, read the inbox and the detail.

**Expect:** one state, one name, one next step for each side.

**Probe further:** code uses "Payment lapsed" (badge), "Payment link expired" (timeline) and "Your payment link for <expert> expired on <date>. Ask <expert> for a new link, or book another time." with a **Request again** link (Home). Report **COPY** (P3) for the three names, and check whether "Ask <expert> for a new link" is possible (is there a way to ask?) or false.

## DB-06 — A booking being moved

**Needs:** CO-47 (consultee proposal waiting) and CO-60 (expert proposal waiting).

**Steps:**

1. For each, as both parties, read the Appointments badge, the detail (proposal card), Home, the inbox (H1).
2. R-03 (`RescheduleRequest.status = PENDING`, the released occurrence `RESCHEDULED`/tentative).

**Expect:**

- The party who must answer sees the proposal and a deadline; Home shows "<name> asked to reschedule" ("Accept one of their times or decline to keep the booking as it is.") or "<name> proposed new times".
- The party who asked sees that it waits on the other side.

**Probe further:** the badge stays "Confirmed" (no "being moved" label exists). Is the original time still shown as booked while the session is released? A buyer who reads "Confirmed · Tue 6:00 pm" while that time is released is told something false. Report **FALSE-INFO** (P2) if so.

## DB-07 — A cancelled booking with a partial refund `[local]`

**Needs:** CO-72 (50 % refund) or a fresh one.

**Steps:** as B1: Appointments, detail, Payments (refund row), payment detail. As H1: Appointments, detail, Earnings (reversal). As ST and AD: the payment, `/dashboard/staff/money/refunds`. R-04.

**Expect:** "Cancelled" everywhere; B1's money line "… ₹375.00 refunded." or "… ₹375.00 refund on its way."; H1's earnings reduced in proportion (`refundedShareAmount`); one `Refund` row; the refunds queue lists it once.

**Probe further:** does B1 see why only half came back (the tier and the time they cancelled)? Does H1 see the buyer's cancel reason?

## DB-08 — A completed session

**Needs:** a session whose end has passed and the `auto-complete-appointments` sweep has run (NEEDS-OWNER-RUN), or shift an occurrence into the past with owner approval and note the sweep did not run.

**Steps:** as both parties: Appointments, detail, Home. As H1: Earnings (hold status).

**Expect:** "Completed"; consultee Home "How was your session with <expert>?" ("A short review helps other learners choose.") and "Rate this session" on the detail; H1's earnings move toward READY after the hold.

**Probe further:** before the sweep runs, a past session still reads "Confirmed". How long can that last on a preview (no sweeps)? Is there any "awaiting completion" cue?

## DB-09 — A subscription across its dashboards `[local]`

**Needs:** SU-23's purchase (no sessions yet), then SU-37's allocation (week 1 full).

**Steps:**

1. Before allocation: B1 Home/Appointments/detail; H1 Home, Requests (Subscriptions tab), the allocate page.
2. After allocation: the same, plus the "Next cycle" row when week 2 opens.

**Expect:**

- Before: B1 "Awaiting schedule"; H1 sees "Schedule cycle 1" and, after `nudgeHours`, the bell "Waiting for session times".
- After: B1 "Confirmed" with three sessions; H1 inbox "Schedule the next 3 · 3 of 12 booked" when the next cycle opens (chip "Next cycle", badge "Next cycle open").

**Probe further:** the inbox says "cycle", the allocate page says "Week N of W", the detail may say "plan week". Report **COPY** (P3) if one thing has three names. Does B1 see when the next week's sessions will be placed?

## DB-10 — A webinar seen by host, buyers, the waitlist and staff `[local]`

**Needs:** WE-21 (sold out with a waitlist) or `qa-WE-05` with seats.

**Steps:** as H2: Appointments row, detail (attendee list, seat count), Earnings. As each buyer: detail, Payments. As a waitlisted buyer: the event page and Home. As ST: the appointment.

**Expect:** seats "x of N" equal on H2's detail and the public page; each buyer sees only their own seat; the waitlisted buyer sees "on the waitlist" and no payment.

**Probe further:** does H2 see buyers' zones? Does the waitlisted buyer's Home say anything at all?

## DB-11 — A class with a missed session and a make-up owed `[local]`

**Needs:** CL-51 (host cancelled one session; make-up not yet scheduled).

**Steps:** as H2: Home, Appointments, class detail. As a seat holder: Home, detail, bell. R-03.

**Expect:**

- H2 Home: "Schedule a make-up for <title>" / "Hold it by <date>, or every learner on that session is refunded for it."
- Seat holder: the cancelled session marked, the make-up deadline, bell `CLASS_SESSION_CANCELLED`.

**Probe further:** the make-up deadline shown to H2 and to the learner must be the same instant (each in its zone). The bell says "<host> has until <makeUpBy> to schedule a make-up, or that session is refunded automatically."; does the learner's detail say the same thing?

## DB-12 — A trial in the inbox and on both dashboards

**Needs:** TR-01 (free, scheduled) and TR-04 (paid, held).

**Steps:** as H1: Requests → Trials tab, the trial row, Home. As the buyer: Home, detail, the pay page for the held trial.

**Expect:** the paid hold shows "Awaiting payment" with the hold deadline for both; the free trial "Confirmed". Inbox empty state copy (if no trials): "No trial requests" / "Trial requests from your plan pages land here."

**Probe further:** trials are buyer-picked now; "Trial requests" implies the expert approves them. Is there anything for H1 to do on a trial row? If not, why is it in Requests? **COPY** (P3).

## DB-13 — A Wipro-sponsored booking: learner, expert, sponsor, staff

**Needs:** CO-12's booking (B4 ↔ H1, Wipro rail) and CO-14's personal-but-tagged booking.

**Steps:**

1. As B4: Appointments, detail, Payments.
2. As H1: Appointments, detail, Earnings.
3. As OS: `/dashboard/organization/[Wipro]/home`, `/appointments`, `/requests`, `/my-program`.
4. As ST: the payment.

**Expect:**

- B4: money "Sponsored by Wipro" (not "Paid"); no card amount.
- H1: earnings for the booking, same amount as the payment row.
- OS: the sponsored booking in the org list; CO-14's personal booking absent (privacy, CO-14).
- Every view shows the same status.

**Probe further:** the org list prints times in fixed IST (TZ-12). Does OS see who the learner is, the expert, the amount and the program it drew from? Does B4 see that the org paid and how much budget is left?

## DB-14 — A LearnPro-hosted booking: learner, expert member, host owner

**Needs:** CO-17's booking (B1 ↔ OX, LearnPro-hosted).

**Steps:** as B1: detail, Payments. As OX: consultant dashboard (Appointments, Earnings) and LearnPro's org dashboard (what OX can open). As OH: `/dashboard/organization/[LearnPro]/appointments`, `/compensation`, `/payouts`. As ST: the payment.

**Expect:** OX sees the session and their share; OH sees the session and the org's share in compensation; B1 sees the expert and "Paid". Amounts reconcile with R-04 (`ConsultantEarnings` rows, org share).

**Probe further:** where does a bell for this booking send OX and OH (org route per `lib/novu/resolve-href.ts`)? Can OX open that page? Record the landing.

## DB-15 — Dual role: DR switches sides

**Steps:**

1. As DR, open the dashboard switcher. Switch consultant ↔ consultee ↔ Wipro org. Read each Home.
2. With TZ-04's booking (DR as buyer of H1), read DR's consultant Home ("Booked as a client" section) and consultee Home.
3. Click a bell entry for that booking from each side.

**Expect:** the booking appears on the consultee side as DR's booking and on the consultant Home only as "Booked as a client" (never as a session DR hosts). The bell's B2C link (`/dashboard/go/auto/appointments`) lands DR on the side DR is acting on.

**Probe further:** does the go resolver open the specific appointment or just the list? A list landing is a **MISSED-OPPORTUNITY** (the bell knows the booking). Do counts on the consultant Home include DR's own client bookings by mistake?

## DB-16 — Counts and badges agree with the database

**Steps:**

1. As H1, record: Home "N requests to answer", any nav badge on Requests, each inbox tab count, the "Answer today" bucket size.
2. As B1, record: Home outstanding-payment count and amount, upcoming count.
3. SQL: count H1's pending consultations, subscriptions awaiting schedule, open reschedules; B1's `PENDING` payments.

**Expect:** every count equals its SQL. The outstanding amount equals the sum of B1's pending payment amounts.

**Probe further:** refresh after approving one request in another tab (`[two-browser]`). Which counts update without a reload? Stale counts are **DESIGN** (P3); counts that never match are **BUG** (P2).

## DB-17 — Empty states on every booking surface

**Steps:** as a persona with nothing in a list (B4 for consultee pages after cleanup, H4 for consultant Requests tabs, OS's org requests when none are pending), open: consultee Home, Appointments, Payments; consultant Home, Requests (each tab), Appointments, Earnings; org appointments and requests.

**Expect:** each empty state says what will appear and how to make it appear. Known copy: "No consultation requests" / "New requests land here the moment someone asks for a session."; "No upcoming appointments" / "Your schedule is clear for now"; "No appointments today" / "Enjoy your free time or check upcoming sessions".

**Probe further:** quote every empty-state line. "Enjoy your free time or check upcoming sessions" and the consultant Home greeting "Here's what's happening with your appointments today" are filler; judge as **COPY / AI-SLOP** (P3). Does any empty state offer the next step (share your page, open availability, browse experts)?

## DB-18 — Unscheduled offerings: who tells the host?

**Needs:** a draft class with no times (CL-08) and a draft webinar with no time (WE-15).

**Steps:** as H2, read Home, Appointments (rows "Not scheduled yet · Schedule now" with synthetic ids `unscheduled-class-<id>` / `unscheduled-webinar-<id>`), Offerings.

**Expect:** Appointments lists both with **Schedule now**. CL-08 already records that Home shows nothing for an unscheduled class.

**Probe further:** add the webinar half: does Home mention an unscheduled webinar? Does the bell ever remind H2? A draft that sits forever unnoticed is a **MISSED-OPPORTUNITY**. Don't re-report CL-08's class finding; reference it.
