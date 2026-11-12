# 11-c · Notifications: consultations and subscriptions, event by event

**Needs:** the journeys in 03-consultations and 04-subscriptions; run each case right after the matching journey step (named per case) so the rows are fresh. `[local]` where money moves. `[sweep]` cases are NEEDS-OWNER-RUN off production.
**Personas:** H1 (IST), B1 (IST), B2 (London), B3 (LA), ST.
**Docs under test:** `lib/novu/templates/b2c.ts` (bell subject, body and recipients), `lib/novu/service.ts` (payload per zone), `lib/email/senders/booking.ts` and `lib/email/index.ts` (email subjects), `lib/novu/resolve-href.ts` (links), `lib/novu/policy.ts` (preferences).

**What every case checks (the "notification block"):**

1. **Recipients:** the outbox `recipients` hold exactly the user ids the template description names; nobody else (not the actor when the copy addresses the other party).
2. **Bell:** open the bell as each recipient. Quote the subject and body. Every `{{payload.x}}` is filled; no raw enum, ISO time, paise or cuid.
3. **Link:** click it. Record the landing (TZ and DB-25 cover zones and org routes).
4. **Timing:** the bell appears within a minute of the action (inline attempt) or after the relay; `NotificationOutbox.status` reaches `SENT`. Record `createdAt` → `sentAt`.
5. **Email:** `FailedEmail` row per recipient with the subject below; `status` `SENT` (or `PENDING` with a reason in `lastError`).
6. **Once:** repeat the action's idempotent replay if the case allows; still one row per recipient (`transactionId` is unique).

```sql
-- N-3: everything notified for one entity in the last hour
SELECT 'bell' AS ch, "workflowId" AS kind, recipients::text AS who, payload->>'outcome' AS outcome,
       status::text, "createdAt", "sentAt", "lastError" FROM "NotificationOutbox"
WHERE "entityRef" LIKE '%' || :id || '%' AND "createdAt" > now() - interval '1 hour'
UNION ALL
SELECT 'email', "emailType", recipient, subject, status::text, "createdAt", "sentAt", "lastError" FROM "FailedEmail"
WHERE "entityRef" LIKE '%' || :id || '%' AND "createdAt" > now() - interval '1 hour'
ORDER BY 6;
```

If `entityRef` doesn't carry the id you expect, search by recipient and time window instead, and report which `entityRef` shape the row used.

## DB-31 — A consultation request reaches the expert

**Trigger:** CO-20 (B1 requests H1's 90-min consultation; H1 in "Review requests first" mode).

**Expect:**

- Bell to H1 only: `NEW_BOOKING_REQUEST`, subject "New booking request", body "<B1 name> requested a consultation for <plan> on <requested time, IST>."
- Email to H1: subject "<B1 name> requested a consultation with you".
- B1 gets nothing, or a receipt; record which.

**Probe further:** does B1 get any confirmation that the request was sent and when it expires? If B1 gets nothing, report **MISSED-OPPORTUNITY**. Does the body name more than one requested time when B1 offered several?

## DB-32 — Approve a priced request: the pay link

**Trigger:** CO-25 (H1 approves with "Use requested times").

**Expect:**

- Bell to B1 only: `PAYMENT_LINK`, subject "Payment required", body "₹750.00 is due to confirm your consultation for <plan> with <H1 name> (pay by <expiresAt, B1's zone>)." Link → the pay page.
- Email to B1: subject "Payment Required - Consultation with <H1 name>"; body "Great news! … has approved your consultation request." with an "Expires:" row (TZ-45 owns its zone bug).
- H1: no bell (the toast "Approved — the learner has until <time> to pay" is enough).

**Probe further:** the email subject is Title Case with a hyphen; the bell is sentence case. **COPY** (P3). Does the bell name the session time as well as the pay deadline? A buyer can't tell which booking it is if they have two pending.

## DB-33 — Approve a free request

**Trigger:** CO-29.

**Expect:** `APPOINTMENT_BOOKED` to both: "Your consultation for <plan> is booked for <time>." Emails: B1 "Your consultation with <H1> is confirmed"; H1 "New booking: <B1> for <plan>".

**Probe further:** H1's bell starts "Your consultation …"; for the expert that reads as if H1 bought it. One payload reaches both; judge the wording from H1's seat. **COPY** (P3).

## DB-34 — Decline a request

**Trigger:** CO-38 (unpaid) and, if a paid request path exists, a decline after payment (rejection refund).

**Expect:** B1 learns the request was declined, with the reason if H1 gave one, and (paid) the refund amount. Record the workflow used (the code calls `notifyRejectedRequestPayer` on the refund path; the unpaid path may send nothing).

**Probe further:** an unpaid decline that sends B1 nothing leaves B1 waiting until they open the dashboard. **MISSED-OPPORTUNITY** (P2). Is the reason H1 typed shown verbatim?

## DB-35 — Remind the buyer to pay

**Trigger:** CO-33 (H1 clicks Remind; then again inside the limit).

**Expect:**

- First: bell `PAYMENT_LINK` with `reminder: true`: subject "Reminder: payment due", body "Reminder: ₹750.00 is still due to confirm your consultation …". Email "Reminder: payment due - Consultation with <H1>".
- Second inside 24 h: 429 `REMIND_RATE_LIMITED`; H1's toast "A reminder went out recently — the next one can go later."; no second row.

**Probe further:** H1's success line reads "Remind sent · next in N h"; the toast map says "Reminder sent". **COPY** (P3). The reminder email says the link is "still open, but not for long": does it give the deadline?

## DB-36 — A pay link nobody pays `[sweep]`

**Trigger:** CO-36 (the approved link lapses; `cleanup-abandoned-payments` or `expire-stale-requests`).

**Expect:** one expiry notice to B1 (the code's `notifyConsulteeRequestExpired`), one to H1 or none (record). Re-running the job adds nothing.

**Probe further:** quote the expiry copy. Does it tell B1 how to ask again (Home has **Request again**)?

## DB-37 — An instant paid booking `[local]`

**Trigger:** CO-01.

**Expect:**

- B1: `PAYMENT_SUCCESS` "Payment received" / "Payment of ₹500.00 received for <plan> with <H1>." and `APPOINTMENT_BOOKED`.
- H1: `APPOINTMENT_BOOKED`.
- Emails: B1 booked email (with calendar links for the next session) and payment success; H1 "New booking: <B1> for <plan>".

**Probe further:** B1 gets two bells for one action. Fine if each says something different; note the order. Does H1's email include the buyer's notes?

## DB-38 — The buyer proposes a new time (waiting)

**Trigger:** CO-47.

**Expect:** `APPOINTMENT_RESCHEDULED` `outcome PROPOSED` to both: "A new time was proposed for your consultation for <plan>: <new> instead of <old>. Please review it." Email subject "New time proposed for your consultation" with a respond-by time.

**Probe further:** B1 proposed it and is told to review it (TZ-07). Does H1's copy say who proposed? The template has no `proposedBy` in the bell; the email has `proposedBy`. Compare.

## DB-39 — A move that confirms at once

**Trigger:** CO-46 (consultee picks a free time).

**Expect:** `outcome MOVED` to both: "Your consultation for <plan> moved from <old> to <new>." Email "Your consultation has moved".

**Probe further:** no `leaveBy` on a consultation move (only host-moved events). If "Leave with a full refund until" appears here, it's **FALSE-INFO** (P1).

## DB-40 — "Any time works": a release

**Trigger:** CO-51 (consultee releases without times).

**Expect:** `outcome RELEASED` to both: "The consultation for <plan> on <old> was released. You will be told once a new time is set." Email "Your consultation time was released".

**Probe further:** H1 is the one who must set the time, yet H1's copy says "You will be told once a new time is set." For RELEASED the payload's `newDateTime` fallback is "a new time your consultant will confirm", sent to the consultant as well. Report **COPY** (P2): the expert is told to wait for themselves. Does H1 get a Home item to place the session?

## DB-41 — Decline, withdraw and expiry of a proposal

**Trigger:** CO-49 (H1 keeps the original), CO-50 (B1 withdraws), CO-55 (expiry, `[sweep]`).

**Expect:**

- DECLINED: "The proposed new time for your consultation for <plan> was declined; it stays on <old>." Email "Proposed time declined for your consultation".
- WITHDRAWN: "The reschedule request for your consultation for <plan> was withdrawn; it stays on <old>." Email "Reschedule request withdrawn for your consultation".
- EXPIRED: "The proposed new time … expired, so your original time stands: <old>." Email "Your consultation keeps its original time".

**Probe further:** CO-56 (withdraw meets a taken original time) comes back RELEASED; check that the bell says released, not "stays on <old>" (**FALSE-INFO** P1 if it claims the old time).

## DB-42 — The expert proposes

**Trigger:** CO-60, then CO-61 (client accepts) and CO-62 (client declines).

**Expect:** PROPOSED to both, then MOVED or DECLINED to both. H1 never receives "Please review it." for their own proposal (record what H1's bell says).

**Probe further:** compare DB-38 and DB-42 side by side. One template for both directions produces one wrong sentence per direction. Report once.

## DB-43 — The buyer cancels with a refund `[local]`

**Trigger:** CO-71 (≥ 24 h, full refund).

**Expect:**

- `APPOINTMENT_CANCELLED` to both: "<B1 name> cancelled the consultation for <plan> on <time>. Reason: <label or 'No reason given'>."
- `REFUND_REQUESTED` to the consultant and ops (template description); `REFUND_PROCESSED` to B1 when the gateway confirms ("Your refund of ₹500.00 for the session with <H1> has been processed. Banks usually post it within 5–7 working days.").
- Emails: "Your session on <when> was cancelled" to both (B1's with the refund line); refund processed to B1.

**Probe further:** H1's bell says "<B1> cancelled". B1's says "<B1> cancelled" too (the payload names the person, not "You"). Judge it. A mock payment may never get a gateway confirmation; record whether `REFUND_PROCESSED` fires for mock refunds.

## DB-44 — The expert cancels

**Trigger:** CO-81 (paid, under 2 h) and CO-82 (free).

**Expect:** `APPOINTMENT_CANCELLED` "<H1 name> cancelled …" to both; B1's refund line says the full amount; no refund rows on the free one. Reason label from `CANCELLATION_REASON_LABEL` (for example "the consultant was unavailable"), never the raw enum.

**Probe further:** the strike is the expert's business. Does any bell or email to B1 mention reliability or strikes? (It shouldn't.) Does H1 get told the strike was recorded?

## DB-45 — A subscription is bought and waits for times `[local]`

**Trigger:** SU-23 (purchase), then the unscheduled-plan nudge (`[sweep]`; the bell carries `nudgeHours`).

**Expect:**

- B1: `SUBSCRIPTION_STARTED` "Subscription active" / "Your subscription to <plan> with <H1> is now active." (record whether it fires at payment or only on approval; the code sends it from the approval route).
- H1: `NEW_BOOKING_REQUEST` with `nudgeHours`: "Waiting for session times" / "<B1>'s subscription for <plan> is waiting for session times — Nh since payment. Schedule cycle 1 within 48h or the buyer is refunded in full." Email "<B1>'s subscription is waiting for session times".

**Probe further:** the writer report (04–06) found the checkout toast says "now active" while the subscription is still PENDING. Is "active" true before a single session has a time? The nudge copy writes "48h" with no space; elsewhere "48 h". **COPY** (P3).

## DB-46 — Sessions placed, all or some

**Trigger:** SU-35 (Auto places week 1), SU-45 (only 2 of 3 fit).

**Expect:** full: `APPOINTMENT_BOOKED` to both. Partial: `APPOINTMENT_PARTIALLY_SCHEDULED` to both: "2 of 3 sessions for <plan> are booked. The remaining 1 will be scheduled as availability opens."

**Probe further:** "The remaining 1 will be scheduled": no noun; fine or not? Is it true that the remaining session "will be scheduled" automatically? It needs H1 to top up (SU-48). **FALSE-INFO** (P2) if nothing schedules it on its own.

## DB-47 — The weekly "sessions to schedule" reminder `[sweep]`

**Trigger:** SU-52 (the next plan week opens with nothing placed). Job: the week nudge (`lib/booking/week-nudge.ts`).

**Expect:** to H1: `NEW_BOOKING_REQUEST` with `weekSummary`: subject "Sessions to schedule this week", body "<summary> Open it to auto-schedule in one tap." Email "<B1>'s week <N> needs session times" or "<N> plans need session times this week". Quiet hours defer it (`notBefore`, TZ-40).

**Probe further:** "auto-schedule in one tap": is it one tap from where the link lands? Record the taps.

## DB-48 — A plan is cancelled or refunded for never being scheduled

**Trigger:** SU-72 (buyer cancels before any session) and SU-81 (`[sweep]`, unscheduled for 48 h).

**Expect:**

- Cancel: `SUBSCRIPTION_CANCELLED` to both: "The subscription to <plan> has been cancelled." plus refund bells.
- Unscheduled refund: `SUBSCRIPTION_UNALLOCATED_REFUNDED` to both: "<plan> was not scheduled within 48 h of payment, so <B1> is refunded in full."

**Probe further:** the cancel bell doesn't say who cancelled or how much comes back. **MISSED-OPPORTUNITY** (P3). The unallocated copy names B1 in the third person in B1's own bell.
