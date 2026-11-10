# 11-d · Notifications: webinars, classes, trials, money, reminders and preferences

**Needs:** the journeys in 05-webinars, 06-classes, 07-trials and 08-money; run each case right after the matching step. `[local]` where money moves; `[sweep]` cases are NEEDS-OWNER-RUN off production.
**Personas:** H1, H2 (IST), H3 (co-host), B1, B2, B3, DR, B4.
**Docs under test:** as 11-c, plus `lib/booking/class-sessions.ts` (class bells), `lib/booking/event-retime.ts`, `lib/booking/class-retime.ts`, `lib/booking/event-waitlist.ts`, `lib/booking/backup-interest.ts`, `lib/trials/refund-bell.ts`, `emails/booking/ClassSessionEmail.tsx`, `emails/booking/TrialAndSubscriptionEmail.tsx`.

Use the notification block and N-3 from `03-notifications-consultations-subscriptions.md` for every case.

## DB-49 — A webinar seat is bought `[local]`

**Trigger:** WE-19 (B2 buys a seat on `qa-WE-05`).

**Expect:** B2: `PAYMENT_SUCCESS` and `APPOINTMENT_BOOKED` ("Your webinar for <title> is booked for <time>."). H2: record whether the host is told a seat sold (bell or email) and what it says.

**Probe further:** if H2 hears nothing per seat, is there a summary anywhere (Home, earnings)? Co-host H3: told or not? Record.

## DB-50 — A sold webinar is re-timed

**Trigger:** WE-34 (H2 moves `qa-WE-05` with **Move to a new date**).

**Expect:** each seat holder: `APPOINTMENT_RESCHEDULED` `outcome MOVED` with `leaveBy`: "Your webinar for <title> moved from <old> to <new>. Keep your seat — nothing to do. Can't make it? Leave with a full refund until <leaveBy>." Attendees with a clash also get "You already have a session then." Email "Your webinar has moved".

**Probe further:** H2 and co-host H3: do they receive the attendee copy ("Keep your seat … Leave with a full refund")? That would be **FALSE-INFO** for a host (P2). `leaveBy` = `Webinar.retimeBy`; compare instants.

## DB-51 — A class series move

**Trigger:** CL-41 (H2 → **Move upcoming sessions**).

**Expect:** one MOVED bell per seat holder (not one per session), with the first moved session's old and new time or a summary; `leaveBy` = `Class.retimeBy`. Email per seat.

**Probe further:** a series move changes many sessions; does the bell say how many and which? "moved from <old> to <new>" for eight sessions names one. **MISSED-OPPORTUNITY** (P2) if the others aren't listed anywhere the link lands.

## DB-52 — One class session cancelled by the host

**Trigger:** CL-51.

**Expect:** seat holders: `CLASS_SESSION_CANCELLED` "A class session was cancelled" / "Your <time> session of <title> was cancelled — <H2> has until <makeUpBy> to schedule a make-up, or that session is refunded automatically." Email "Session cancelled: <title>" with an "Open dashboard" button.

**Probe further:** H2 is not a recipient (template: seat holders). Does H2 get the Home item "Schedule a make-up for …" (DB-11)? A voided session uses "A class session did not count"; trigger only if CL-60 runs.

## DB-53 — The make-up is scheduled

**Trigger:** CL-53.

**Expect:** seat holders: `CLASS_MAKEUP_SCHEDULED` "Make-up session scheduled" / "The make-up session of <title> is on <time>." plus " You already have a session then." for clashes and the keep-your-seat line when `leaveBy` is set. Email "Make-up session scheduled: <title>".

**Probe further:** a learner who can't attend may skip it for a refund (CL-55). Does the bell say so? If not, **MISSED-OPPORTUNITY**.

## DB-54 — No make-up in time, and the exit right `[sweep]`

**Trigger:** CL-56 (14 days pass), CL-58 (three misses in 30 days).

**Expect:**

- `CLASS_SESSION_REFUNDED` per seat: "A missed session of <title> was not made up, so <amount> is on its way back to you." Email "Session refund processed: <title>".
- `CLASS_EXIT_AVAILABLE` per seat: "You can leave with a full refund" / "<title> has had 3 missed sessions. You may leave the series with a full refund of the sessions still to come." Email "Full exit refund option available: <title>".

**Probe further:** the email subject says "refund processed" before the gateway confirms. Is the refund processed, or requested? Compare with R-04 `Refund.status`. **FALSE-INFO** (P3) if `PENDING`.

## DB-55 — Waitlists and held times that open up

**Trigger:** WE-23 (a seat frees on a sold-out webinar); a 1:1 "backup interest" where the product offers one (`lib/booking/backup-interest.ts`: a learner asks to hear when a held time frees).

**Expect:**

- Every waiting learner at once: `EVENT_SEAT_OPENED` "A seat just opened" / "A seat opened in <title>. It may already be gone; first come, first served." Email "A seat just opened in <title>". A second free seat within the cooldown sends nothing new (WE-23 owns the cooldown).
- Backup interest: `WINDOW_OPENED` "A time you wanted just opened" / "<window> with <expert> is free again — first to book gets it." Email "A time with <expert> just opened".

**Probe further:** where does each link land: the event page with the free seat, or a dashboard list? The learner needs the event page.

## DB-56 — Trials: booked, held, moved, cancelled

**Trigger:** TR-01 (free, confirmed), TR-04 (paid, held), TR-06 (capture), TR-19 (learner moves), TR-29 (expert cancels paid), TR-33 (learner cancels free).

**Expect:**

- Free confirm: `TRIAL_SESSION_SCHEDULED` to both: "The trial session for <plan> between <B> and <H1> is scheduled for <time>." Email to the learner "Your free trial with <H1> is confirmed"; to H1 "Trial with <B> is confirmed".
- Paid hold: email to the learner "Your free trial with <H1> is held until payment completes".
- Move: `notifyTrialMoved` (record the workflow and copy).
- Cancel: `TRIAL_SESSION_CANCELLED` to both "The trial session for <plan> on <time> was cancelled." Email "Trial cancelled: <plan>".

**Probe further:**

- The paid hold's email says "free trial" for a ₹100 trial. **FALSE-INFO** (P2).
- `TRIAL_SESSION_REQUESTED` ("<B> requested a free trial session …", email "New trial request: …") is described as "when a consultee asks for a free trial", but trials are buyer-picked and confirm at once. Does it still fire? For a paid trial, "free" is false.
- `TRIAL_REFUNDED` says "<H1> couldn't take your <plan> trial, so it is refunded in full." Its description is "declined or not answered within 48 h". If it fires when the **learner** cancelled or a late capture was refunded, the reason is false. Record every trigger you see.

## DB-57 — A trial converts to a subscription `[local]`

**Trigger:** TR-38 (the learner buys the same expert's plan within 30 days of the completed trial).

**Expect:** the plan's purchase notifications (DB-45) and `TRIAL_SESSION_COMPLETED` earlier ("Trial completed: <plan>"). Record whether anything tells H1 the trial converted.

**Probe further:** H1 sees conversion only on the trials dashboard (TR-40)? No bell is acceptable; say so.

## DB-58 — Reminders, host live and completion `[sweep]`

**Trigger:** a confirmed consultation and a webinar; `send-appointment-reminders` at 24 h, 1 h and 15 min; the host joins through the app; `auto-complete-appointments` after the end.

**Expect:**

- `APPOINTMENT_REMINDER` to both, three times: "Coming up" / "Your <type> for <plan> is coming up — <time>." Email "Reminder: your <type> is coming up".
- `SESSION_HOST_LIVE` to paid seats once per session: "<host> has joined your webinar for <title>. Join now."
- `APPOINTMENT_COMPLETED` to both: "Session complete" / "Your <type> for <plan> has ended. Open it to rate the session or find the recording."

**Probe further:** the expert receives "Open it to rate the session"; experts don't rate. **COPY** (P3). A cancelled session must get no reminder: cancel one inside the 24-h window and check N-3 after the next tick.

## DB-59 — Refunds: requested, processed, failed

**Trigger:** 08's refund cases (MO-), including a forced gateway failure if 08 can produce one.

**Expect:**

- `REFUND_REQUESTED` to the consultant and ops: "A refund of <amount> was requested …" with a readable reason (never a uuid; `lib/novu/humanize.ts` scrubs ids).
- `REFUND_PROCESSED` to the payer.
- `REFUND_FAILED` to the payer: "Refund needs attention" / "The refund of <amount> could not be completed. Our team will retry it — please contact support if it has not arrived in a few days." Home item "We couldn't return <amount>" / "Our team re-issues failed refunds by hand. Open the charge to follow up."

**Probe further:** the bell says "Our team will retry it"; Home says "re-issues … by hand". Which is true? **INCONSISTENCY** (P3). Does the org (sponsored refund) get told its wallet was credited?

## DB-60 — Org notifications for sponsored bookings

**Trigger:** CO-12 (Wipro-sponsored booking) and CO-78 (its cancel).

**Expect:** B4 and H1 get the normal booking and cancel bells. Record whether OS gets anything (org workflows in `lib/novu/org-workflows.ts`: program cap near, program exhausted, seat assigned).

**Probe further:** a sponsor spending money on a booking hears nothing per booking; is that intended? Note the org bell feed (if OS has one) for program-cap events near the limit.

## DB-61 — Turning optional notifications off

**Steps:**

1. As B2, Settings → Notifications: turn off "Bookings, reminders, unread chat, recordings, documents and collaborator updates" (appointments category) for in-app and email.
2. Trigger a reschedule PROPOSED by H1 on a B2 booking and a cancel by H1 on another.
3. N-3. Turn the setting back on.

**Expect:** the policy drops optional rows for B2 (`resolveRecipientBellPolicy`); required notices still arrive. Record which booking notices count as required (a cancellation with a refund should reach the payer).

**Probe further:** if B2 turned everything off, does B2 still learn that H1 cancelled and refunded them? If not, **BUG** (P1: a customer isn't told their booking is gone). The panel says "Required notices still appear": does it say which?

## DB-62 — Dual role and org members: one person, two copies?

**Steps:** with DR as buyer of H1 (TZ-04) and as Wipro learner, trigger one booking notice. N-3 for DR's user id.

**Expect:** one bell per event per person, on the right side (DB-15). Emails once.

**Probe further:** a person who is both a participant and an org operator for the same booking (OH booking OX? only if such a fixture exists): one copy or two? Record.

## DB-63 — Notification copy sweep across this folder

**Steps:** list every bell subject and body and every email subject you collected in 11-c and 11-d in one table: workflow · recipient role · text.

**Expect:** each sentence is true for the person who reads it, names the booking clearly, and says what to do next when there is something to do.

**Probe further:** mark each line: wrong audience (copy written for the other party), false claim, missing next step, raw value, inconsistent term (session/meeting/appointment/booking; Re-time/Move; cycle/week). Report the table as one **COPY** finding with a row per problem; P2 for false or wrong-audience lines, P3 for style.
