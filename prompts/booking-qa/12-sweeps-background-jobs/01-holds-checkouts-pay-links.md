# 12-a · Sweeps: holds, abandoned checkouts and pay links

**Needs:** read [README.md](README.md) "How a sweep case runs" first. Local `next dev` for fixtures that need Mock Pay; Razorpay test mode for real `PENDING` checkouts (a real order is the only way to leave a direct checkout `PENDING`; on a preview a checkout without Mock Pay also stays `PENDING`).
**Personas:** B1, B2, B3, H1, H2, AD.
**Docs under test:** `scripts/payments/cleanup-abandoned-payments.ts`, `scripts/appointments/cleanup-tentative-occurrences.ts`, `lib/payments/constants.ts`.

Windows from code: a direct checkout holds 30 min (`DIRECT_CHECKOUT_HOLD_MS`); a seat 15 min (12 + 3); an approval pay link `min(approval + 24 h, start − 15 min)`, with one reminder at half the window; a legacy row with no `expiresAt` lapses 35 min after `createdAt`; a tentative slot with no successful payment is released 24 h after its last write unless its request is still under review (`PENDING`, `APPROVED_PENDING_PAYMENT`) or its event is live.

## SW-01 — Preflight: who runs jobs against this database right now

**Why it matters:** production's ticker processes QA rows with production's code; every later verdict depends on knowing that.

**Steps:** as AD open `/dashboard/admin/system-jobs` (or `/dashboard/staff/system-jobs`); read the last run of each booking job in the README table. Then:

```sql
SELECT "jobName", max("startedAt") AS last_run, count(*) FILTER (WHERE "startedAt" > now() - interval '1 hour') AS runs_last_hour
FROM "SystemJobExecution"
WHERE "jobName" IN ('cleanup-abandoned-payments','cleanup-tentative-occurrences','expire-stale-requests','expire-reschedule-proposals','expire-unpaid-trials',
  'auto-complete-appointments','detect-consultant-no-shows','send-appointment-reminders','retry-auto-refunds','reconcile-pending-refunds',
  'settle-cancelled-sessions','release-earnings','sync-payment-earnings','reconcile-occurrence-availability')
GROUP BY "jobName" ORDER BY "jobName";
```

**Expect:** record, per job, whether it ran in the last hour (production ticker active) and the page's view of the same. If runs are recent, every SW case must read "before" state immediately after its shift, and its "after" may come from production. If no runs, every SW case is NEEDS-OWNER-RUN.

**Probe further:** does the system jobs page show the deploy/commit each run used? If not, MISSED-OPPORTUNITY (QA and ops can't tell which code ran).

## SW-02 — The abandoned sweep expires only the lapsed buyer, once `[sweep]`

**Why it matters:** salvaged from old 018 Phase 4; a sweep that touches a live or paid seat sells one seat twice or strands a buyer.

**Setup:** F-PL2a webinar (capacity 5). B1: `CONFIRMED` seat (Mock Pay). B2: live `PENDING` seat checkout (hold 15 min ahead). B3: `PENDING` seat checkout; owner-approved: `UPDATE "Payment" SET "expiresAt" = now() - interval '1 hour' WHERE id = :b3pid RETURNING id, "expiresAt";` and in the same call read all three seats:

```sql
SELECT p."userId", p.id, p."paymentStatus", p."expiresAt", ap.status AS seat
FROM "Payment" p LEFT JOIN "AppointmentParticipant" ap ON ap."appointmentId" = p."appointmentId" AND ap."userId" = p."userId"
WHERE p."appointmentId" = :webinarAid;
```

**Steps:** NEEDS-OWNER-RUN `abandoned-payments`; then run it again.

**Expect:** run 1: only B3's payment → `EXPIRED` and B3's seat `HELD → CANCELLED`; its gateway order cancelled (record); referral credits (if any) restored. B1 still `CONFIRMED`; B2 still `PENDING` with its `HELD` seat. Run 2: nothing changes; the result counts show nothing to do. Run record `cleanup-abandoned-payments` with counters.

**Aftermath:** seats-left on the public page +1; H2's roster without B3; B3's Payments shows no failed charge (record what it shows).

## SW-03 — A released direct-checkout hold, on every surface `[sweep]`

**Why it matters:** the slot reopens and the buyer must understand what happened.

**Setup:** B2 starts a real S-08 checkout for Thu D+10 09:00 IST and stops at the gateway sheet. Owner-approved: age `expiresAt` by 1 minute.

**Steps:** before the run: as B3 load H1's booking page (09:00 should already read free: read-time rule, MO-12). NEEDS-OWNER-RUN `abandoned-payments`. After: B2 reopens the checkout URL; B2 opens Payments and appointments; H1 opens home and the grid.

**Expect:** payment `EXPIRED`; the tentative occurrence released (`deletedAt` set or status cancelled; record); the request (`DIRECT_CHECKOUT`, `PENDING`) cancelled by the sweep (record status). B2's reopened checkout says the hold expired and offers to pick again. No booking appears for B2 or H1; no notification to H1.

**Probe further:** is B2 emailed about an abandoned checkout? If yes, quote it; if it says "payment failed", that's FALSE-INFO.

## SW-04 — A legacy row with no expiry lapses 35 minutes after it was created `[sweep]`

**Why it matters:** rows from before `expiresAt` existed must not hold slots forever.

**Setup (QA-ONLY):** a QA `PENDING` checkout; owner-approved: `UPDATE "Payment" SET "expiresAt" = NULL, "createdAt" = now() - interval '36 minutes' WHERE id = :pid;` (record the original values). A second one with `createdAt = now() - interval '30 minutes'` as the control.

**Steps:** NEEDS-OWNER-RUN `abandoned-payments`.

**Expect:** the 36-minute row expires; the 30-minute control doesn't (`expiresAt IS NULL AND createdAt < now − 35 min`).

## SW-05 — A lapsed approval pay link: EXPIRED once, one notice `[sweep]`

**Why it matters:** CO-36 asserts the journey; this case asserts the sweep's edges.

**Setup:** two approved, unpaid H1 requests (CO-25 shape) by B1 and B3. Owner-approved: B1's link `expiresAt = now() - interval '1 minute'`; B3's `expiresAt = now() + interval '20 minutes'` (control).

**Steps:** NEEDS-OWNER-RUN `abandoned-payments` twice.

**Expect:** run 1: B1's request `EXPIRED`, its payment `EXPIRED` (from `PENDING` only), hold released, exactly one lapse notice to B1 (and record whether H1 is told). B3 untouched. Run 2: no second notice (`NotificationOutbox` count unchanged), no change. A link captured before the run (CC-23) is never expired.

**Aftermath:** B1's appointments say expired (one word everywhere: "expired", not "cancelled" or "failed"); H1's requests list no longer shows "Remind".

## SW-06 — One reminder at half the pay window `[sweep]`

**Why it matters:** a buyer who forgot should be nudged once, not spammed, and never after the link died.

**Setup:** an approved, unpaid request whose link has 24 h; owner-approved: set `expiresAt = now() + interval '11 hours'` (inside the last half).

**Steps:** NEEDS-OWNER-RUN `abandoned-payments` twice; then set `expiresAt` to the past and run again.

**Expect:** run 1: one reminder bell + email to the buyer naming the amount, the expert and the deadline in the buyer's zone. Run 2: no second reminder. Run 3: the link expires (SW-05) with no reminder after expiry.

**Probe further:** quote the reminder. Is the deadline correct for B2 (London) on a link minted by an IST expert?

## SW-07 — Tentative slots: released after 24 h, never while a human is reviewing or a move is open `[sweep]`

**Why it matters:** salvaged from old 011 Phase 5; a pending request waits on the expert, not on a payment window, and a session released for a move is tentative until its request ends.

**Setup (owner-approved shifts on QA rows):**

- A: a tentative occurrence whose appointment has only an `EXPIRED` payment and whose request is `CANCELLED` or `EXPIRED`; set the occurrence `updatedAt = now() - interval '25 hours'`.
- B: a tentative occurrence of a `PENDING` request with `bookingSource = REQUEST_SUBMITTED` (CO-20 shape), `updatedAt` 25 h ago.
- C: as A but `updatedAt` 23 h ago (control).
- D: a session released for a move (`RESCHEDULED`, tentative) on a booking with an open (`PENDING_REVIEW`) reschedule request and no succeeded payment (a free consultation or a free trial being moved), `updatedAt` 25 h ago.
- E: the tentative session of a paid trial still `AWAITING_PAYMENT`, `updatedAt` 25 h ago.

**Steps:** NEEDS-OWNER-RUN `tentative-occurrences`.

**Expect:** A released; B kept (parent under review); C kept; D kept (the move is open, and the request can still be accepted afterwards); E kept (a live trial; `expire-unpaid-trials` ends an unpaid hold). Run record `cleanup-tentative-occurrences` with `slotsReleased = 1`.

**Probe further:** the script's header says "Schedule: Every 2 hours" and its comment mentions "the 2-hourly cron cadence", but the ticker runs it every 15 minutes (`lib/cron/schedule.ts`): DOC-DRIFT (minor).

## SW-08 — A stale pending payment is checked against the gateway `[sweep]`

**Why it matters:** a capture whose webhook never arrived must still confirm.

**Setup:** Razorpay test mode (owner): pay a QA checkout at the gateway while blocking or not delivering the webhook (owner's choice of method); the row stays `PENDING`.

**Steps:** NEEDS-OWNER-RUN `reconcile-payment-status`.

**Expect:** the payment becomes `SUCCEEDED` through the same confirmation pipeline (one journal, one earnings row, booking confirmed), or, if the hold already lapsed and the slot is gone, the auto-refund path (MO-66). Without a gateway: BLOCKED (no gateway).

**Probe further:** what did the buyer see between paying and the reconcile (spinner, "pending", nothing)?
