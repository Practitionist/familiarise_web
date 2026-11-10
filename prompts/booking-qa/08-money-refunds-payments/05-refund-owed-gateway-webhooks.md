# 08-e · Money: refunds owed, gateway failures and webhook disorder

**Needs:** local `next dev`; Razorpay **test mode** keys and the webhook secret for the gateway cases (owner). Owner-approved SQL for every QA-ONLY emulation. Background jobs are NEEDS-OWNER-RUN off production (see 12's README for the protocol and the shared-database caveat).
**Personas:** B1, B2, B3, H1, H2, AD, ST.
**Docs under test:** `lib/payments/operations/refund-owed.ts`, `scripts/payments/retry-auto-refunds.ts`, `scripts/refunds/reconcile-pending-refunds.ts`, `lib/payments/webhooks/{handlers,auto-refund-marker}.ts`, `.claude/skills/finance/references/verification.md` ("Replaying a webhook").

Facts from code: every door that ends a paid booking stamps `Payment.refundOwedKey`, `refundOwedPaise`, `refundOwedReason`, `refundOwedAt` in the same commit, then drives the refund under that key. `retry-auto-refunds` re-drives markers older than 15 minutes; a failed drive waits out `refundOwedNextAt` (1 h after the first failure, 4 h after the second); at `refundOwedAttempts = 3` the marker retires to an operator and stays set. A `PENDING` refund belongs to `reconcile-refunds`, which fails a placeholder only after 24 h with no matching gateway refund. The capture webhook's own auto-refunds use the `Payment.description` prefixes `Auto-refund pending:` → `Auto-refunded:` (or `Auto-refund stuck:`).

**QA-ONLY rule (salvaged from old 019):** never pre-create a `Refund` row to mark intent except in MO-59, where the case says so. A `PENDING` row reduces the refundable balance and makes the owed sweep skip the payment.

## MO-55 — The happy path stamps and clears the marker in one cancel `[local]`

**Why it matters:** a marker left behind holds the expert's earnings forever and shows in ops queues.

**Setup:** a fresh S-08 booking by B2, ≥ 24 h out (Mock Pay).

**Steps:** cancel as B2 with `expectedRefundPaise` from the preview. Immediately run R-04 and:

```sql
SELECT "refundOwedKey", "refundOwedPaise", "refundOwedReason", "refundOwedAt", "refundOwedAttempts", "refundOwedNextAt" FROM "Payment" WHERE id = :pid;
```

**Expect:** one `Refund` `cancel:<aid>:<pid>` `SUCCEEDED` with the quoted amount; marker columns null and attempts 0. The platform bears the gateway fee: the refund is the full tier of `amount`, no fee deducted.

**Probe further:** record the cancel response `refund.status` (`REFUNDED` for mock). For a real payment it may be `PENDING`; what does the buyer's copy say in that case?

## MO-56 — A drive that died after the commit is re-driven exactly once `[sweep]`

**Why it matters:** a crash between "booking cancelled" and "refund sent" must never lose the money.

**Setup (QA-ONLY emulation, owner-approved; salvaged from old 019 Phase 2):** a second B2 booking (Mock Pay). Put it in the cancelled shape without calling the refund door, and stamp the marker aged past the grace:

```sql
BEGIN;
UPDATE "Consultation" SET status = 'CANCELLED', "cancelledAt" = now() WHERE id = (SELECT "consultationId" FROM "Appointment" WHERE id = :aid);
UPDATE "AppointmentOccurrence" SET "completionStatus" = 'CANCELLED', "deletedAt" = now() WHERE "appointmentId" = :aid;
UPDATE "Payment" SET "refundOwedKey" = 'cancel:' || :aid || ':' || id, "refundOwedPaise" = amount,
  "refundOwedReason" = 'qa-MO-56 emulated crash after commit', "refundOwedAt" = now() - interval '20 minutes', "refundOwedAttempts" = 0
WHERE "appointmentId" = :aid AND "paymentStatus" = 'SUCCEEDED' RETURNING id;
COMMIT;
```

**Steps:** NEEDS-OWNER-RUN `retry-auto-refunds` twice (owner: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cleanup/retry-auto-refunds?limit=50`). Record both JSON results.

**Expect:** run 1: `owed.scanned ≥ 1`, `owed.refunded ≥ 1`; one `Refund` with the marker's key and `amountPaise = amount`; marker cleared. Run 2: no new `Refund` (the key is unique); the payment is not scanned.

**Cross-check:** B2's Payments shows one refund; staff Stuck work → "Refunds the bookings owe" no longer lists it.

**Probe further:** before the owner runs the job, what does B2 see: "Cancelled" with no refund line, or "refund pending"? The first is a MISSED-OPPORTUNITY.

## MO-57 — A fresh marker or one in backoff is left alone `[sweep]`

**Why it matters:** driving a marker inside its grace races the door that just stamped it.

**Setup (QA-ONLY):** two more cancelled-shape bookings as in MO-56; marker A with `refundOwedAt = now()`; marker B aged 20 minutes but `refundOwedNextAt = now() + interval '1 hour'`, `refundOwedAttempts = 1`.

**Steps:** NEEDS-OWNER-RUN `retry-auto-refunds` once.

**Expect:** neither A nor B is driven (no `Refund`, attempts unchanged). Then owner-approved: age A by 20 minutes and set B's `refundOwedNextAt` to the past; run again: both refunded once.

**Probe further:** record whether B's second run counts as attempt 2 or simply succeeds with attempts left at 1.

## MO-58 — A definitive gateway refusal: three attempts, one escalation, marker kept `[sweep]`

**Why it matters:** a refund that can never succeed must reach a human once, not page forever or fail silently.

**Setup (real gateway, owner; salvaged from old 019 Phase 4):** B3 pays a booking in Razorpay **test** mode. In the Razorpay **test** dashboard, refund it fully by hand (note the gateway refund id; never in live mode). Our next refund call is now refused definitively. Stamp the marker as in MO-56 (aged 20 min).

**Steps:** NEEDS-OWNER-RUN `retry-auto-refunds`; after each run read the marker and refunds; owner-approved: set `refundOwedNextAt = now() - interval '1 minute'` before the next run (the backoff is 1 h, then 4 h). Three runs, then a fourth.

**Expect:** `refundOwedAttempts` 1 → 2 → 3; each attempt leaves a `Refund` `FAILED` with a `failureReason` (only the newest carries the key; older ones have a null key); no `SUCCEEDED` refund; the refundable balance is restored after each failure. After run 3, exactly one `SystemEvent` whose message starts "Refund owed on payment <pid> failed 3 times — refund by hand". Run 4 doesn't scan the payment. `refundOwedKey` stays set.

**Cross-check:** staff Stuck work lists it under "Refunds the bookings owe" with attempts 3 and the last error; B3's Payments shows the refund as not yet returned (record the words); H1's earning stays held (MO-49).

**Probe further:** after AD refunds by hand (MO-32 door), does the marker clear, the stuck item go, and the earning release?

## MO-59 — An ambiguous outcome belongs to reconciliation, never to a second refund `[sweep]`

**Why it matters:** a timeout may already have moved money; refunding again pays twice.

**Setup (QA-ONLY emulation, owner-approved; salvaged from old 019 Phase 5):** a cancelled-shape booking with its marker as in MO-56, plus the placeholder a timed-out first attempt would leave:

```sql
INSERT INTO "Refund" (id, "amountPaise", currency, status, "refundId", "dedupeKey", "paymentGateway", "paymentId", "updatedAt")
VALUES (gen_random_uuid(), :amount, 'INR', 'PENDING', 'pending_qa-MO-59', 'cancel:' || :aid || ':' || :pid, 'RAZORPAY', :pid, now()) RETURNING id;
```

**Steps:** NEEDS-OWNER-RUN `retry-auto-refunds`, then `reconcile-refunds`.

**Expect:** the owed sweep **skips** the payment (marker kept, no second row, no gateway call). Reconcile leaves the placeholder `PENDING` while it is under 24 h old (it never fails one earlier), and fails it only after 24 h with "No refund carrying this reservation id found at gateway after 24 hours". Retire the placeholder at cleanup (`status = 'FAILED'`, `failureReason = 'qa-MO-59 cleanup'`).

**Probe further:** while the placeholder is `PENDING`, what does the buyer see? "Refund processing" is right; "Refunded" is FALSE-INFO.

## MO-60 — Every owed refund is visible to ops while it waits

**Why it matters:** the marker is the work queue; ops must see age, attempts and reason.

**Steps:** with MO-56 (before the run), MO-58 and MO-59 rows present, open as ST `/dashboard/staff/stuck-work` and Money → Refunds.

**Expect:** "Refunds the bookings owe" lists each marker older than its queue limit, oldest first, with attempts and last error, linking to Money → Refunds. Record the threshold at which an item appears. A marker older than 6 h past its last retry is also reported once a day as an ops event (`… still owe a refund more than 6 h after their door committed`).

**Probe further:** can ST open the booking from the queue in one click? Is the buyer's name and amount shown?

## MO-61 — A refund the gateway refuses on the cancel itself

**Why it matters:** the cancel commits first; the buyer must not be told "refunded" when the gateway said no.

**Setup:** real gateway (owner): B3 pays in test mode; refund it fully in the Razorpay test dashboard (as MO-58); then cancel through the UI.

**Steps:** read the cancel response and the toast; R-04; marker.

**Expect:** booking `CANCELLED`; response `refund.status` `FAILED` or `PENDING` (record), never `REFUNDED`; a `FAILED` refund row with a `failureReason`; marker set with attempts 1 and `refundOwedNextAt` = now + 1 h. The toast doesn't promise money it hasn't sent.

**Cross-check:** MO-38's surfaces (Refund failed note, Needs you, staff queue).

**Probe further:** quote the toast and the email subject. Does anything tell the buyer the team will act?

## MO-62 — A live dispute blocks refunds and holds earnings

**Why it matters:** refunding a disputed payment can pay the buyer twice (refund + chargeback).

**Setup:** needs a dispute on a QA payment. If none exists (`SELECT id, status, "paymentId" FROM "Dispute" WHERE "paymentId" IN (:qaPayments)`), BLOCKED: don't insert one.

**Steps:** try to cancel the booking; try an admin refund; run (owner) `retry-auto-refunds` with a marker on it.

**Expect:** cancel: `409` `DISPUTE_ACTIVE` "This appointment has an open payment dispute and can't be cancelled until it resolves."; admin refund: refused (`REFUND_BLOCKED_BY_DISPUTE`); the owed sweep skips it; the earning has a `DISPUTE` hold.

**Probe further:** what does the buyer see on the booking while it's disputed?

## MO-63 — The same webhook twice, and a second event for the same capture

**Why it matters:** a duplicated delivery must confirm once, journal once and earn once.

**Setup (BLOCKED on preview; local with test keys and the webhook secret, owner; salvaged from old 018 Phase 1):** B1 starts a non-mock S-08 checkout. Record the payment id, order id and amount.

**Steps:** owner posts a signed `payment.captured` for the order with event id `qa-MO-63-1`; then the identical delivery again; then the same capture under a new event id `qa-MO-63-2`.

**Expect:** all three answer `200`. After all three:

```sql
SELECT (SELECT count(*) FROM "LedgerTransaction" WHERE "idempotencyKey" = 'booking:' || :pid) AS journals,
       (SELECT count(*) FROM "ConsultantEarnings" WHERE "paymentId" = :pid) AS earnings,
       (SELECT count(*) FROM "PaymentLeg" WHERE "paymentId" = :pid) AS legs,
       (SELECT "paymentStatus" FROM "Payment" WHERE id = :pid) AS status;
```

journals 1, earnings 1, legs 1, status `SUCCEEDED`; the occurrence non-tentative; one booked notification per party.

**Probe further:** retire synthetic events at cleanup: `UPDATE "WebhookEvent" SET error = 'permanent: qa fixture', processed = true, "processedAt" = now() WHERE "eventId" LIKE 'qa-MO-%';`.

## MO-64 — Out-of-order events: `order.paid` first, a failure after success

**Why it matters:** a late failure event must never unpay a paid booking.

**Setup:** as MO-63 (local, test keys, owner; salvaged from old 018 Phase 2). B2 starts a checkout.

**Steps:** owner posts `order.paid`, then `payment.captured`, then `payment.failed` for the same order (new event ids).

**Expect:** one confirmation; the second event a no-op; one journal; after `payment.failed` the payment **stays** `SUCCEEDED` and the booking stays confirmed.

**Probe further:** does B2 get a "payment failed" email or bell after the late failure event? That would be FALSE-INFO P1.

## MO-65 — A capture for an order the database doesn't know yet

**Why it matters:** an approval pay link whose row writes failed after the gateway minted the order must still confirm, by the order's own notes.

**Setup (local, test keys, owner; salvaged from old 018 Phase 3):** CO-25's approval link (`APPROVED_PENDING_PAYMENT`). QA-ONLY: put the row back to its pre-mint shape (`paymentIntent = 'premint_qa-MO-65-' || id` on the payment and its CARD leg's `sourceRef`), keeping the real order id aside.

**Steps:** owner posts a signed `payment.captured` for the real order at its exact amount. Then on a second pre-mint row, post it at the wrong amount. Then post a capture for an order id that exists nowhere.

**Expect:** first: the server fetches the order, reads `familiarisePaymentId` from the order notes (never from the webhook's own notes), swaps the placeholder for the order id, and confirms. Second: not adopted (amount and currency must match); nothing confirmed. Third: a non-2xx or recorded error on the `WebhookEvent`, retried by `sweep-stuck-webhook-events` until it gives up; no booking, no phantom payment.

**Probe further:** the staff "Gateway webhooks not processed" queue lists the third event?

## MO-66 — A capture after the hold lapsed refunds itself `[sweep]`

**Why it matters:** the buyer paid; the seat was gone; the money must go back, once.

**Setup (local, test keys, owner):** B3 starts a webinar seat checkout; QA-ONLY: age its `expiresAt` 1 hour; owner runs `abandoned-payments` (seat released, payment `EXPIRED`).

**Steps:** owner posts a signed `payment.captured` for that order. Then owner runs `retry-auto-refunds` if the refund didn't settle inline.

**Expect:** payment `SUCCEEDED` (the capture is recorded), seat **not** re-confirmed and not resold to B3 silently; `description` starts `Auto-refund pending:` then `Auto-refunded:`; exactly one `Refund` for the full amount. Never: `SUCCEEDED` with a released seat and no refund marker; `EXPIRED` with a confirmed seat; two refunds. The race between this capture and the sweep is CC-12.

**Cross-check:** B3 sees a refund and no seat; H2's roster doesn't list B3.

**Probe further:** what does B3's email say? Does it explain the seat was released because payment took too long?

## MO-67 — A payment with no booking is found and healed

**Why it matters:** "charged, no booking" is the worst money outcome.

**Setup:** the MO-66 shape before the refund settles, or any `SUCCEEDED` QA payment with no live booking.

**Steps:** owner runs `alert-orphaned-payments` and `reconcile-orphaned-payments`.

**Expect:** the alert raises once per orphan (record where: SystemEvent/Sentry); the healer links, refunds (key `orphan-auto:<paymentId>` on its notice) or escrows it. Record which branch ran and why.

**Probe further:** does the buyer get any message while the healer decides?

## MO-68 — The capture webhook's own auto-refund gives up after its attempts `[sweep]`

**Why it matters:** the other refund queue (capture-time refunds) must also stop and page once.

**Setup:** MO-66's shape with a payment that can't be refunded (refund it by hand in the Razorpay test dashboard first, as MO-58).

**Steps:** owner runs `retry-auto-refunds` repeatedly (shift `updatedAt` past the 15-min grace between runs, owner-approved).

**Expect:** after the maximum attempts the description prefix becomes `Auto-refund stuck:` and one operator alert says "Auto-refund of payment <pid> failed N times — refund by hand"; no further attempts.

**Probe further:** does this stuck payment appear in the same staff queue as MO-58's, or somewhere else? Two places for one job is a DESIGN finding.

## MO-69 — The checkout's own gateway call fails

**Why it matters:** an order that can't be created must not leave a held slot or a phantom payment.

**Setup:** owner drill only: run local with deliberately invalid Razorpay keys (or the gateway sandbox down). Not on a shared preview.

**Steps:** B1 starts an S-08 checkout.

**Expect:** a typed error with a human message (no stack, no "Error 500"); no `SUCCEEDED` payment; the tentative hold released at once or within the 30-minute window; `yourCardWasNotCharged` or equivalent copy if the response carries it.

**Probe further:** the retry button: does it reuse the same `clientIdempotencyKey`?

## MO-70 — Folder money ledger and cleanup

**Why it matters:** refunds and ledger rows are append-only; the report must list what stays.

**Steps:** list every payment, refund, credit note, ledger transaction and earnings row this folder created (MO-29's query plus MQ-1 per payment). Cancel live bookings through the product. Delete only mock-payment graphs (R-09 order). Retire synthetic `WebhookEvent` rows. Clear QA-ONLY markers (`refundOwed*` to null) only after their case's assertions, and restore any shifted `holdUntil`, refund status or occurrence time.

**Expect:** a ledger table in the report: id, type, amount (₹), status, kept/deleted, why.
