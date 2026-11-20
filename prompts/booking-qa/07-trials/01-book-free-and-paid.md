# 07-a · Trials: booking free and paid trials, holds, payment and eligibility

**Needs:** 01 (F-AV1, S-11 free 30-min trial, S-12 paid ₹100 trial, F-BUSY), H1 in "Instant booking". Paying a trial needs Razorpay test mode or an owner-run capture webhook replay: `/checkout/plans/trial/[trialId]` has no Mock Pay ("Pay to confirm" hands off to `/checkout/pay/[paymentId]`). Sweeps are `[sweep]`.
**Personas:** H1 (IST), B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), B4 (IST), DR, IL (IST, the limiter case only), ST.
**Docs under test:** `docs/booking/09-trials.md` (all), `app/api/trials/route.ts`, `lib/trials/eligibility.ts`, `lib/trials/book-trial.ts`, `app/explore/experts/[consultantId]/components/SubscriptionPricingToggle.tsx` (the mentorship dialog), `app/explore/experts/[consultantId]/components/MentorshipTrialStep.tsx`, `components/scheduling/SingleTimePicker.tsx`.

Rules under test (doc + code):

- The buyer picks one window of the plan's trial length on step two of the dark mentorship dialog: "Book Trial" on the plan card (or on the dialog's start-date step, "When do you want to start?", which picks its date on a month grid) opens "Pick a time for a <N>-minute trial." with the single-time picker (a month, then the day's free times; the day's taken times behind "Show N taken times", without "Notify me" on this step) and **Back** to the start-date step. Lead: 15 min for a free trial, 2 h for a paid one.
- Free trial: `SCHEDULED` at once with a confirmed session. Paid trial: `AWAITING_PAYMENT`, tentative session, HELD seats, `paymentDueAt` = `Payment.expiresAt` = min(now + 24 h, start − 15 min). The capture confirms the same session in place.
- One live or delivered trial per learner–expert pair (`TRIAL_ALREADY_REQUESTED`); `CANCELLED` and `REJECTED` free the pair (the old row is deleted on the new request).
- After every case: R-03 (the `Trial` row via the appointment), R-04, R-05 (H1), R-07, and this:

```sql
SELECT id, status, "subscriptionPlanId", "appointmentId", "paymentId", "paymentDueAt", notes, "completedAt", "convertedToSubscriptionId"
FROM "Trial" WHERE "consultantProfileId" = :h1Cid ORDER BY "createdAt" DESC LIMIT 5;
```

Note before starting: S-11's trial is free only if `PlatformPricingConfig.minTrialPriceInPaise = 0` (S-11 setup). If the floor is above 0, the free-trial cases are BLOCKED.

## TR-01 — A free trial: the buyer picks, it confirms at once

**Why it matters:** the basic trial path; no payment, no consultant action.

**Steps:**

1. As B4 open `/explore/experts/[H1 cid]`, find "qa-S-11 Four-week sprint" and press **Book Trial (Free, 30 min)** (record the exact label). The dark dialog opens on its trial step.
2. Read: the heading "Pick a time for a 30-minute trial.", the plan card with "Free trial", "Times in <zone>" under the day heading, the notes field ("What would you like to discuss? (Optional)"), "Your trial is confirmed as soon as you book it.", **Back** and **Book trial**. Press **Back**: the start-date step ("When do you want to start?") opens; pick a start date there, press **Book Trial** to return, then **Back** again: the date you picked is still selected.
3. In the month, pick Tue D+8, then 09:00 IST (30 min). Note "qa-TR-01". **Book trial**.

**Expect:**

- `POST /api/trials` → 201. Toast "Trial booked" / "Your trial with <H1 name> is confirmed. It's in your appointments."
- DB: `Trial` `SCHEDULED`, `notes` contains "qa-TR-01", one `Appointment` (`appointmentType = 'TRIAL'`), one occurrence 03:30Z–04:00Z non-tentative with `consultantProfileId` = H1, seats CONFIRMED; history `CREATED` then `PENDING → SCHEDULED` in one transaction (never a committed PENDING with a time).
- No `Payment` (or a ₹0 row; record).

**Cross-check:** B4 appointments (Tue D+8 9:00 am IST, labelled as a trial); H1 home and appointments; H1 Requests → Trials tab (record what a confirmed trial shows there, "Trial requests arrive in Requests, under Trials" per the editor copy); H1's grid Booked block 09:00–09:30; outbox `trial-session-scheduled` to both.

**Probe further:** the picker should not list F-BUSY's time among the free ones (it sits under "Show N taken times") nor anything within 15 min. Does the step say the trial is 30 minutes and free? At 390 px, is the month above the times with no horizontal scroll? Does B4's appointment explain what happens after the trial (subscribe)? MISSED-OPPORTUNITY if not.

## TR-02 — The trial step's gates: signed out, no learner profile, ineligible

**Why it matters:** each gate must explain itself before the buyer picks a time.

**Steps:**

1. Signed out: press **Book Trial**. Read the step.
2. As a persona with no consultee profile (H2, if H2 has none): open the step, pick a time and press **Book trial**.
3. As B4 (after TR-01): open the step again, pick a time and press **Book trial**.
4. `GET /api/trials/check-eligibility?consulteeProfileId=…&consultantProfileId=…` (record the query shape from the network panel) for B4 and B2.

**Expect:**

1. "Sign in to pick a time for a trial with <H1 name>." with **Sign in to continue**; after sign-in you return to the expert page (record whether the dialog reopens on the trial step).
2. A refusal naming the missing learner profile (record the toast title and text).
3. A "Not eligible" toast with the eligibility reason "You have already requested or completed a trial with this consultant".
4. B4 ineligible with that reason; B2 eligible.

**Probe further:** steps 2 and 3: does the expert page hide the trial CTA up front, or only refuse after the buyer has picked a time? The latter is a MISSED-OPPORTUNITY.

## TR-03 — Trial window refusals

**Why it matters:** the server checks length, lead, hours and calendar before holding anything.

**Steps (as B2, `evaluate_script`, copy TR-01's body and vary `slot`):**

1. A 60-min window for the 30-min trial.
2. A free trial starting in 10 min.
3. A paid trial (S-12) starting in 90 min.
4. A window at 14:00 IST (inside the 13:00–17:00 gap).
5. A window starting 09:15 IST (off grid).
6. F-BUSY's time (Tue D+1 18:00 IST).

**Expect:** 1: 400 `WINDOW_DURATION_MISMATCH`. 2 and 3: 409 `REQUEST_TOO_SOON`. 4: 400 `OUTSIDE_AVAILABILITY`. 5: a typed 400 (record the code; trials send their window as 30-min atoms). 6: 409 `SLOT_TAKEN` "That time was just taken. Pick another time." No `Trial` rows created; B2 stays eligible. A refused request costs no limiter attempt: every validity check runs before the limiter, and only a created trial spends one of B2's 3 per 24 hours. Send all six refusals as B2. Then, as IL (who books no other trial in 07), create three trials in a row (against three different experts, or H1 three times, cancelling each to free the pair): the three succeed. A fourth answers 429 `RATE_LIMITED` "You've reached today's trial request limit." with `retryAfterSeconds`, `retryAt` (ISO 8601) and a `Retry-After` header, and the trial step shows when IL may retry in IL's zone. B2's allowance must stay whole for TR-16 and 07-b's T-2: if either is refused with 429, the six refusals spent it, which is a **BUG** (P2).

## TR-04 — A paid trial holds its time until payment

**Why it matters:** the hold must block the time without confirming an unpaid session.

**Steps:**

1. As B1 press S-12's **Book Trial** (₹100, 30 min). Read the button (**Continue to payment**) and the price on the plan card.
2. Pick Wed D+9 17:00 IST. Continue.
3. On `/checkout/plans/trial/[trialId]` read "Complete your trial booking", the amount, the held session in B1's zone, when the hold lapses, and **Pay to confirm**. Don't pay yet.

**Expect:**

- `POST /api/trials` → 201 with `checkoutUrl` pointing to `/checkout/plans/trial/[id]`.
- DB: `Trial` `AWAITING_PAYMENT`, `paymentDueAt` = min(request + 24 h, Wed D+9 11:30Z − 15 min) (compute); occurrence 11:30Z–12:00Z `isTentative = true`; seats HELD; a `Payment` `PENDING` (after the gateway mint) with `expiresAt` = `paymentDueAt`, amount 10000 paise (+ tax; record).
- The checkout page shows the same lapse time as `paymentDueAt`, in IST.

**Cross-check:** B1's appointments show the trial as awaiting payment with a pay action that leads to the trial checkout page (every "Pay Now" must land there, `bookingPayHref`). H1's Requests/Trials and grid: the time is held (record how it's painted).

**Probe further:** without gateway keys on a preview, record what the mint failure looks like (the trial must not be left holding forever with no way to pay).

## TR-05 — Another buyer can't take a held time

**Steps:** as B2 try S-12 trial (or S-11 free) at Wed D+9 17:00 IST.

**Expect:** 17:00 is not among the free times; it is listed under "Show N taken times"; a forced POST → 409 `SLOT_TAKEN`. An `AWAITING_PAYMENT` trial occupies its time.

**Probe further:** two buyers racing the same free time (one wins, one `SLOT_TAKEN`; the loser's pick clears, the pane says "That time was just taken — pick another." and the taken list opens) is the doc's worked example; run it lightly with two pages if you can, depth in 09.

## TR-06 — The capture confirms the held session in place

**Why it matters:** payment must confirm exactly the held session, no new row.

**Setup:** Razorpay test mode, or NEEDS-OWNER-RUN capture webhook replay for TR-04's payment.

**Steps:** as B1 click **Pay to confirm** and pay with a test method.

**Expect:** `Payment` `SUCCEEDED`; `Trial` `SCHEDULED` with `paymentId` stamped; the **same** occurrence id now non-tentative; seats CONFIRMED; booked emails to both; earnings for H1. Reopening the trial checkout page shows "This trial is already paid for."

## TR-07 — A paid trial booked close to its start gets a short pay window

**Steps:** as B3 book S-12's trial for the first time offered at least 2 h 30 min ahead.

**Expect:** `paymentDueAt` = start − 15 min (not 24 h). The checkout page states it plainly ("pay by <time>"). After `paymentDueAt` the trial can't be paid (TR-08).

**Probe further:** `payWindowEnd` (`lib/payments/operations/approval-payment.ts`: 24 h, never later than start − 15 min) is the only pay-window rule; a row whose `paymentDueAt` is the session start itself is a **BUG**.

## TR-08 — An unpaid hold lapses and frees the time `[sweep]`

**Steps:**

1. On B3's TR-07 trial (or a fresh one), owner-approved: `UPDATE "Trial" SET "paymentDueAt" = now() - interval '1 minute'` and the PENDING payment's `"expiresAt"` the same.
2. Open the trial checkout page as B3.
3. NEEDS-OWNER-RUN `expire-unpaid-trials`.

**Expect:** 2: "This trial is no longer awaiting payment — it may have been cancelled, or the payment window may have closed. You can request a new trial with this expert." (or still payable until the sweep: record which). 3: `Trial` `CANCELLED`; occurrence `CANCELLED` + `deletedAt`; appointment `deletedAt`; payment `EXPIRED` in the same commit as the trial (payment first, then the trial), and the gateway order cancelled after it; the time offered again; B3 can request a new trial with H1 (pair freed).

**Probe further:** the notice to B3 says "lapsed", not "cancelled by expert". H1 is told? (Not required; record.)

## TR-09 — A capture after the held session started is refunded, never scheduled `[sweep]`

**Why it matters:** money that arrives too late must not confirm a session that's already gone.

**Setup:** a paid trial hold. Owner-approved: shift its occurrence to have started 10 min ago (UTC half hour) and leave `paymentDueAt` past. Then NEEDS-OWNER-RUN a capture webhook replay for its payment (or pay through the gateway if the page still allows it).

**Expect:** the webhook outcome `captured_after_release`; `Trial` `CANCELLED` (never `SCHEDULED`); hold tombstoned; `Payment` `SUCCEEDED` with `description` starting "Auto-refund pending:" (for a trial already off its hold: "Auto-refund pending: capture landed on a <status> trial. Booking NOT confirmed.") and the capture parked for the automatic full refund. Both the learner and the expert get the existing cancelled notice (`trial-session-cancelled`), staged with the release; a refund bell follows only once money moves. The brief expects the refund-owed key `trial-cancel:<trialId>:<paymentId>`; in code that key belongs to the trial cancel door (`lib/trials/cancellation.ts`), and the late-capture path parks through `parkCapture` in `lib/payments/webhooks/handlers.ts`. Record the actual `refundOwedKey`/reason and report any mismatch. `retry-auto-refunds` drives the refund (12).

**Probe further:** what does B1 see between capture and refund? "Paid" with no session would be alarming: quote it.

## TR-10 — The learner walks away from an unpaid hold

**Steps:** on a fresh paid hold, as the learner use the abandon door (`POST /api/bookings/[bookingId]/abandon`, or the cancel action on the pending trial).

**Expect:** `Trial` `CANCELLED`; payment expired by CAS; hold released; pair freed. A capture that already committed → 409 `ALREADY_PAID`. Cancelling the held trial through `DELETE`, or the expert's decline through `PATCH`, also leaves the `PENDING` payment `EXPIRED` in the same transaction (no payable order is left behind); a captured payment is untouched and goes through the quoted refund.

## TR-11 — Nobody can confirm an unpaid hold by hand

**Steps:** as H1 (and as ST), `PATCH /api/trials/[trialId]` `{ status: "SCHEDULED" }` on an `AWAITING_PAYMENT` trial.

**Expect:** refused (409 `TRIAL_UNPAID` or an illegal-transition 409; record). Trial stays `AWAITING_PAYMENT`. The client schema can't even express `AWAITING_PAYMENT` as a target.

## TR-12 — One trial per learner and expert; declined or cancelled frees the pair

**Steps:**

1. As B4 (TR-01 trial `SCHEDULED`) `POST /api/trials` for S-12 with H1.
2. Cancel a learner's trial (TR-10's B-persona) and request again with the same expert.

**Expect:** 1: 409 `TRIAL_ALREADY_REQUESTED` "You have already requested a trial with this consultant" (the pair rule spans all of H1's plans). 2: 201; the old `CANCELLED` row is deleted and a new row created (unique pair).

**Probe further:** report the abuse trade-off documented in `lib/trials/eligibility.ts` (request → cancel → request holds slots repeatedly). An expert-cancelled trial also frees the pair: is that intended? Open question.

## TR-13 — A plan without trials, and an unpublished plan

**Steps:** as B2 look at H1's S-08 (consultation, no trial) and the S-13 draft subscription; then `POST /api/trials` for a subscription plan with `trialEnabled = false` (create "qa-TR-13" without a trial, publish) and for the draft plan.

**Expect:** no trial CTA on the page for those plans; eligibility "This plan does not offer trials"; POST 400 "A trial is not available for this plan"; draft → 4xx `PLAN_NOT_PUBLISHED` "This plan isn't available to book right now." Archive "qa-TR-13" afterwards.

## TR-14 — A paused expert takes no trials

**Steps:** as H1 switch off "Taking new 1:1 bookings and trials"; as B2 open the trial step and POST. Switch back on.

**Expect:** 409 `NOT_ACCEPTING_BOOKINGS` "This expert is not taking new 1:1 bookings or trials right now. Pick another expert, or try again later." The page shows the paused state before the dialog. TR-01's existing trial is unaffected.

## TR-15 — An expert with no room in the next two weeks

**Why it matters:** the step must say there's nothing to pick and what to do, not show an empty list.

**Setup:** H4 (custom schedule). As H4 create a subscription "qa-TR-15" with a free 30-min trial and publish. In H4's custom editor remove every date in the next 14 days and add one date 30 days out (10:15–12:15 NPT). Save. Restore S-05's rows at the end.

**Steps:** as B2 open qa-TR-15's trial step and move through the month.

**Expect:** no day in the next two weeks carries a free dot; on a chosen day the pane says "No free times on this day" with "Next free: <date>" pointing 30 days out (the picker reads the following month when this one has nothing left). No console errors.

**Probe further:** does the expert page itself say "no trial times available" before the dialog? (The subscription feasibility gate also bites here: publishing a plan with no hours in 4 weeks may be refused with `PLAN_NOT_FEASIBLE`; if so, publish before removing the dates.)

## TR-16 — "Review requests first" and trials

**Why it matters:** the booking-mode copy says "Every time comes to you as a request"; the trial route never reads `bookingMode`.

**Setup:** H1 in "Review requests first" (S-07). Restore Instant at the end.

**Steps:** as B2 (eligible) book S-11's free trial at Thu D+10 09:00 IST.

**Expect (from code):** the trial is `SCHEDULED` at once (no approval step). Record what actually happens. If it confirms instantly, the Settings copy is FALSE-INFO for trials (P2): either trials should follow the mode or the copy should exclude them. Quote both. Then, as B2, cancel this trial: a `CANCELLED` trial frees the B2–H1 pair for 07-b's T-2.

## TR-17 — A learner who is also an expert: both calendars count

**Setup:** DR, if DR has a consultant profile with a booking of their own (as host) at some time T. Otherwise BLOCKED.

**Steps:** as DR request a trial with H1 at T.

**Expect:** refused (`SLOT_TAKEN` or a typed 409) because the learner's own calendar is busy (the lock batch covers the learner's consultant calendar too). Record the copy: it should say *you* are busy, not that the expert is.

## TR-18 — Trials and the expert's open-request cap

**Why it matters:** the trial route takes the expert's request-cap lock; whether trials count toward "Limit open requests to" isn't documented.

**Steps:** as H1 set "Limit open requests to" = 1 while one consultation request is open (03-c style); as B3 (eligible) book a free trial.

**Expect:** record whether the trial is refused with `CONSULTANT_AT_CAPACITY` or goes through. Either may be intended; report it as an open question with the result. Clear the limit afterwards.
