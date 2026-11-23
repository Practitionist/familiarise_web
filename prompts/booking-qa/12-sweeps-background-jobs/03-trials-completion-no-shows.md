# 12-c · Sweeps: trials, completion, no-shows, reminders and class end

**Needs:** read [README.md](README.md) "How a sweep case runs". Fixtures from 03, 05, 06, 07. Joining a meeting room needs the video provider configured in the environment; where a case needs a real join and the room can't be joined, it's BLOCKED.
**Personas:** B1, B2, B3, H1, H2, ST.
**Docs under test:** `scripts/trials/expire-unpaid-trials.ts`, `scripts/appointments/auto-complete-appointments.ts`, `scripts/appointments/detect-consultant-no-shows.ts`, `lib/booking/session-outcome-sweep.ts`, `lib/booking/misses.ts`, `docs/booking/09-trials.md`.

From code: `auto-complete-appointments` classifies each past `SCHEDULED` session 1 h after its end from meeting presence: nobody joined → `UNVERIFIED` (`NOBODY_JOINED`); host absent → `VOIDED` (`HOST_ABSENT`); unclear → `UNVERIFIED` (`INCONCLUSIVE`); delivered → `COMPLETED`. A paid `UNVERIFIED` session waits for ops ("needs human") and holds the earning; a free one completes. `detect-consultant-no-shows` owns paid consultations the consultant never joined, 120 minutes after the end (`NO_SHOW_GRACE_MINUTES`). Needs-human items alert at 72 h and escalate after 7 days, once per new id per day; no money moves until ops decides.

## SW-18 — An unpaid trial hold lapses: cancelled, tombstoned, pair freed `[sweep]`

**Why it matters:** TR-08 asserts the outcome; this case checks the edge, the repair pass and the re-run.

**Setup:** two paid-trial holds (TR-04 shape; B1 and B3 on H1's months plan). Owner-approved: B1's `Trial.paymentDueAt = now() - interval '1 minute'`; B3's `paymentDueAt = now() + interval '10 minutes'` (control). Read both trials, payments and occurrences in the same call.

**Steps:** NEEDS-OWNER-RUN `expire-unpaid-trials`; run again.

**Expect:** B1: `Trial` `AWAITING_PAYMENT → CANCELLED`; the held appointment tombstoned (`deletedAt` set; seats `CANCELLED`); the occurrence no longer blocks H1 (R-05 and H1's grid); B1 can request a trial with H1 again (pair freed). B3 untouched. Run 2: nothing new, no second notice. Also: a trial already `CANCELLED` whose appointment is not tombstoned is repaired by the bounded repair pass (if any such QA row exists, record that it's tombstoned after the run).

**Aftermath:** B1's trial page says the hold expired and offers to book again; H1's trial list shows it cancelled with the reason.

**Probe further:** which deadline did the job use, `paymentDueAt` or `Payment.expiresAt` (MO-07)? If they differ, does the checkout page show the one the job uses?

## SW-19 — A paid trial the expert never answers is refunded after 48 hours `[sweep]`

**Why it matters:** the learner paid; silence must not keep their money.

**Setup:** the cohort (from code) is a `Trial` with `status = PENDING`, `paymentId` set and `requestedAt` older than 48 h. In the buyer-picks flow a paid trial goes `AWAITING_PAYMENT → SCHEDULED` and never sits `PENDING` with a payment, so this is the older request-first shape. Look for one: `SELECT id, status, "paymentId", "requestedAt" FROM "Trial" WHERE status = 'PENDING' AND "paymentId" IS NOT NULL;`. If none exists and the product can't make one, BLOCKED; say in the report whether the arm still looks reachable (a possible dead arm is worth an owner question). If one exists on a QA persona, owner-approved: age `requestedAt` to 49 h and a control to 47 h.

**Steps:** NEEDS-OWNER-RUN `expire-unpaid-trials`; run again.

**Expect:** the old one `CANCELLED` (reason `TRIAL_UNANSWERED`; the enum has no `EXPIRED`), refunded in full under `trial-unanswered:<paymentId>`, one bell to the learner. Control untouched. Run 2: no second refund. A refund that failed after the cancel is retried for 14 days by the same job (key makes it a no-op once paid).

## SW-20 — Completion once Stream's record is read (room end + 6 hours), by what actually happened in the room `[sweep]`

**Why it matters:** completion drives feedback, earnings release and plan maths.

**Setup (owner-approved shifts):** QA sessions that ended 6 hours 10 minutes ago (move `startsAt`/`endsAt`, keep the half hour). The sweep reads Stream's record only six hours after the latest of the room end, the recorded end (`Meeting.endedAt`) and the last join (`Meeting.lastJoinedAt`), so moving the booked times does not move a call that really ran:

- A: free consultation (S-09), nobody joined;
- B: paid consultation (S-08), nobody joined;
- C: paid consultation where both parties really joined the call (only if you ran the meeting for real; otherwise skip C). Its wait counts from the call's real end, so run C only once that end is more than six hours old.

Control D: a paid session whose call ran and ended 3 hours ago.

**Steps:** NEEDS-OWNER-RUN `auto-complete-appointments`; run again.

**Expect:** A → `COMPLETED` (free, nothing to hold). B → `UNVERIFIED` with outcome `NOBODY_JOINED`, in the needs-human queue, earning held. C → `COMPLETED`, consultation `COMPLETED`, feedback prompts sent, once its call ended more than six hours ago; before that C stays `SCHEDULED`, which is correct. D untouched (its record is not read before six hours). Run 2: no change. History rows with reason `auto-complete`.

**Aftermath:** B1's view of B: does it say anything ("we're checking what happened")? H1's view? Staff Money → booking ops shows B under session outcomes with **Set outcome**.

## SW-21 — A consultant no-show is cancelled, refunded in full and struck `[sweep]`

**Why it matters:** the buyer showed up; the expert didn't.

**Setup:** a paid B2 consultation running now (owner-approved shift so it starts within minutes). B2 joins the room and stays; H1 never joins. Then owner-approved: move the session so it ended 125 minutes ago. If the room can't be joined, BLOCKED.

**Steps:** NEEDS-OWNER-RUN `auto-complete-appointments` (it must leave this one alone) and `detect-consultant-no-shows`; run both again.

**Expect:** auto-complete doesn't complete it; the no-show job cancels it, refunds 100 % under `consultant-no-show:<paymentId>`, records one `CONSULTANT_NO_SHOW` strike for H1. A session ended 100 minutes ago (inside the 120-minute grace) is not touched. Run 2: no second refund or strike. Multi-session bookings (partial refunds) are excluded from this job: record what happens to a subscription session with the same shape (expected: needs-human, not auto-refunded).

**Aftermath:** B2 is told the expert didn't attend and the refund amount; H1's dashboard shows the strike count and the reason (CO-85 for the public profile threshold).

## SW-22 — Sessions waiting on ops: a 72-hour alert, a 7-day escalation, money held `[sweep]`

**Why it matters:** a needs-human item nobody decides holds the expert's pay and, at plan end, the buyer's settlement.

**Setup:** SW-20's session B. Owner-approved: move its end to 73 h ago (alert), then to 7 days + 1 h ago (escalation).

**Steps:** NEEDS-OWNER-RUN `auto-complete-appointments` after each shift; run again after the second.

**Expect:** after 73 h: one Sentry warning / system event that a session newly passed 72 hours in the needs-human queue (not repeated inside the window). After 7 days: one standing finding per id per day, with the message "N session(s) waited over 7 days for an ops decision; M hold an ended plan's settlement". No money moves; the earning stays held (MO-49). Re-run the same day: no second finding.

**Aftermath:** ST's stuck work or session outcomes list shows the item with its age; **Set outcome** offers the decisions (record them); after ST decides "delivered", the earning becomes releasable (SW-29).

## SW-23 — Reminders at 24 h, 1 h and 15 minutes, once each, in each party's zone `[sweep]`

**Why it matters:** wrong-zone or duplicate reminders are the most visible notification bug.

**Setup:** a QA booking between H3 (New York) and B2 (London). Owner-approved: move it to start 24 h + 5 min from now.

**Steps:** NEEDS-OWNER-RUN `appointment-reminders`; shift to 1 h + 5 min, run; shift to 15 min + 2 min, run; run once more.

**Expect:** one 24-h, one 1-h and one 15-min reminder per party (`NotificationOutbox` rows with distinct kinds), each stating the time in the recipient's zone (H3: EDT/EST; B2: GMT/BST) and naming the other party; no duplicates on the extra run. A cancelled booking gets none.

**Probe further:** a booking made 30 minutes before start: does it get a 24-h reminder late, or correctly skip it?

## SW-24 — Class end stamps refunds for sessions never placed; the retry job pays them `[sweep]`

**Why it matters:** a class that ends with sessions never scheduled owes each seat those sessions.

**Setup:** an H2 class sold to B3 (and B2), with fewer live sessions than `sessionsPurchased` (CL-22's partial schedule, sold, or owner-approved deletion of one future session on a QA class). Owner-approved: move every remaining session into the past (ended > 1 h ago) and complete them.

**Steps:** NEEDS-OWNER-RUN `auto-complete-appointments` (completes the class and stamps refunds), then `retry-auto-refunds` (drives them). Run both again.

**Expect:** class `COMPLETED`; each paid seat's payment gets a marker and then a `Refund` keyed `class-end:<classId>:pay:<paymentId>` for the never-placed sessions, net of any unit already refunded (MO-41); a seat funded by credits is queued for a human instead (record). Only the retry job (a financial job) moves money; auto-complete only stamps. Run 2: nothing new.

**Aftermath:** B3's Payments shows the refund labelled by its reason; H2's earnings reverse by the same units; the class page shows "completed" with the right session count.
