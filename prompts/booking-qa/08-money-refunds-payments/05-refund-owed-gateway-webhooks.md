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
UPDATE "Consultation" SET "requestStatus" = 'CANCELLED', "cancelledAt" = now() WHERE id = (SELECT "consultationId" FROM "Appointment" WHERE id = :aid);
UPDATE "AppointmentOccurrence" SET "completionStatus" = 'CANCELLED', "deletedAt" = now() WHERE "appointmentId" = :aid;
UPDATE "Payment" SET "refundOwedKey" = 'cancel:' || :aid || ':' || id, "refundOwedPaise" = amount,
  "refundOwedReason" = 'qa-MO-56 emulated crash after commit', "refundOwedAt" = now() - interval '20 minutes', "refundOwedAttempts" = 0
WHERE "appointmentId" = :aid AND "paymentStatus" = 'SUCCEEDED' RETURNING id;
COMMIT;
```

**Steps:** NEEDS-OWNER-RUN `retry-auto-refunds` twice (owner: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cleanup/retry-auto-refunds?limit=50`). Record both JSON results. The sweep pays every refund-owed marker older than its 15-minute grace in the database it points at, not just this case's; `limit=50` only caps the batch. Run it only against an isolated database holding this case's payments, or once the owner has confirmed this case's marker is the only aged one (`SELECT id FROM "Payment" WHERE "refundOwedKey" IS NOT NULL AND "refundOwedAt" < now() - interval '15 minutes';`).

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

**Steps:** if the disputed payment is a 1:1 booking's (consultation or plan), try to cancel the booking. If it is a seat on a class or webinar, have the host cancel the event. Either way, try an admin refund, and run (owner) `retry-auto-refunds` with a marker on it.

**Expect:** 1:1 cancel: `409` `DISPUTE_ACTIVE` "This appointment has an open payment dispute and can't be cancelled until it resolves.". Class or webinar cancel: it goes ahead and every other seat is refunded as usual; the disputed seat's payment gets its owed-refund marker (`refundOwedAt` set) and no refund moves for it while the dispute is live. Admin refund: refused (`REFUND_BLOCKED_BY_DISPUTE`); the owed sweep skips the disputed payment; the earning has a `DISPUTE` hold.

**Probe further:** what does the buyer see on the booking while it's disputed?

## MO-63 — The same webhook twice, and a second event for the same capture

**Why it matters:** a duplicated delivery must confirm once, journal once and earn once.

**Setup (BLOCKED on preview; local with test keys and the webhook secret, owner; salvaged from old 018 Phase 1):** B1 starts a non-mock S-08 checkout. Record the payment id, order id and amount.

**Steps:** owner posts a signed `payment.captured` for the order with event id `qa-MO-63-1` (sent as the `x-razorpay-event-id` header, as every event id in this folder is); then the identical delivery again; then the same capture under a new event id `qa-MO-63-2`.

**Expect:** all three answer `200`. After all three:

```sql
SELECT (SELECT count(*) FROM "LedgerTransaction" WHERE "idempotencyKey" = 'booking:' || :pid) AS journals,
       (SELECT count(*) FROM "ConsultantEarnings" WHERE "paymentId" = :pid) AS earnings,
       (SELECT count(*) FROM "PaymentLeg" WHERE "paymentId" = :pid) AS legs,
       (SELECT "paymentStatus" FROM "Payment" WHERE id = :pid) AS status;
```

journals 1, earnings 1, legs 1, status `SUCCEEDED`; the occurrence non-tentative; one booked notification per party.

**Probe further:** the route stores `WebhookEvent."eventId"` as `<event type>:<entity id>:<event id>` (for example `payment.captured:pay_…:qa-MO-63-1`), taking the event id from the header only when it is 1 to 64 letters, digits, `_` or `-`, and a body hash otherwise; confirm each posted delivery's row exists under its `qa-` id before cleanup. Record every event id and entity id the owner posts in this folder, and retire only those, never by prefix (another run's fixtures share the ids). The match is on the last part and the entity together, so a real gateway event, which ends in its own `evt_` id, can never match:

```sql
UPDATE "WebhookEvent" SET error = 'permanent: qa fixture', processed = true, "processedAt" = now()
WHERE split_part("eventId", ':', 3) IN ('qa-MO-63-1', 'qa-MO-63-2' /* plus the ids posted in MO-64, MO-65, MO-70 and MO-71 */)
  AND split_part("eventId", ':', 2) IN (:postedEntityIds);
```

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

## MO-70 — A gateway-captured subscription purchase confirms, first purchase and renewal `[local]`

**Why it matters:** a mock payment skips capture validation, so only a real capture proves that a subscription's order notes match what the webhook expects; a mismatch parks a charged sale for an operator.

**Setup (BLOCKED on preview; local with test keys and the webhook secret, owner):** B1 starts a non-mock subscription checkout (first purchase) and stops before paying. Record the payment id, order id and amount. Repeat once for a renewal of an active subscription (the renewal checkout), as a second row.

**Steps:** for each row, copy the notes from the order the app actually minted (read them from the created order at the gateway, or from the stored payment row's source; never hand-write them) into a signed `payment.captured` for that order with a fresh event id (`qa-MO-70-1`, `qa-MO-70-2`), and post it.

**What this proves and what it doesn't:** it proves the capture handler confirms a subscription when the payment entity carries the order's notes. It proves nothing about the real payload: a real `payment.captured` hands the handler the payment entity's notes, `order.paid` the order's, and the browser return reads the notes from a gateway fetch of the payment, so a recipe that copies the order's notes supplies exactly what is in question. MO-72 covers the real payload; never record a pass here as a pass for it.

**Expect:** the delivery answers `200`. For each payment:

- `paymentStatus = SUCCEEDED`, `description` carrying no `REQUIRES_MANUAL_RECOVERY` text, and its `appointmentId` still the plan's placeholder appointment made at checkout (the capture creates no second subscription or appointment).
- The buyer's `AppointmentParticipant` on that appointment `CONFIRMED` (it was `HELD`).
- The `Subscription` still `PENDING` with no sessions placed: the capture moves no plan status, and the plan now waits in the expert's Requests for its first cycle to be allocated.
- Renewal row only: a new `Subscription` whose `renewedFromSubscriptionId` is the predecessor's id, with its own `schedulingPeriodStartsAt` and `schedulingPeriodEndsAt`; the predecessor row is not changed by the capture.
- Exactly one `LedgerTransaction` with `idempotencyKey = 'booking:<paymentId>'`.
- One `ConsultantEarnings` row per sold cycle, `cycleOrdinal` 0 to N−1 with no gaps, where N is the sold `sessionsTotal` divided by the sold `sessionsPerWeek` (the subscription's own columns, or its plan's where those are null), rounded up (16 sessions at 2 a week is 8 rows, 0 to 7); every row's `holdUntil` null; `grossAmount` summed over the rows equals the payment's `originalAmount` for a one-expert plan.

Run MQ-1 for each, and the MO-63 count query read as journals 1, earnings N, legs 1, then:

```sql
SELECT array_agg("cycleOrdinal" ORDER BY "cycleOrdinal") AS ordinals,
       sum("grossAmount") AS gross, count(*) FILTER (WHERE "holdUntil" IS NOT NULL) AS held
FROM "ConsultantEarnings" WHERE "paymentId" = :pid;
```

**Probe further:** on `dev` before the fix for issue #2962 the expected result is the parked state, and the report must say which of these it saw: (a) parked: the plan, its placeholder appointment and the `HELD` participant exist from checkout but look unpaid, the payment is `SUCCEEDED` with a `REQUIRES_MANUAL_RECOVERY` description, one `LedgerTransaction` with `idempotencyKey = 'unapplied:<paymentId>'`, no `booking:` journal and no earnings; (b) no booking at all (no plan or appointment for the payment); (c) no journals at all, not even the `unapplied:` receipt. Only (a) is the known parked state; (b) and (c) are separate findings. Retire the posted event ids at cleanup as in MO-63.

## MO-71 — A gateway-captured paid trial confirms on the order minted at request time `[local]`

**Why it matters:** a paid trial's order is minted when the trial is requested, before any pay-link visit; a capture on it must confirm the trial the same way a checkout capture does.

**Setup (BLOCKED on preview; local with test keys and the webhook secret, owner):** TR-04's held paid trial (B1, ₹100), without Mock Pay (a pay link has no mock path). Record the trial id, the payment id and the order id.

**Steps:** copy the notes from the order the app actually minted (read them from the created order at the gateway, or from the stored payment row's source; never hand-write them) into a signed `payment.captured` for that order with event id `qa-MO-71-1`, and post it.

**What this proves and what it doesn't:** as MO-70, the copied notes carry the `trialId` the handler needs, so this proves the handler and nothing about the payment entity a real capture delivers. MO-72 covers the real payload.

**Expect:** the delivery answers `200`; `paymentStatus = SUCCEEDED` with no `REQUIRES_MANUAL_RECOVERY` description; the `Trial` `SCHEDULED` with `paymentId` set to this payment and `pendingPaymentUrl` and `paymentDueAt` null; its occurrence non-tentative; one `LedgerTransaction` with `idempotencyKey = 'booking:<paymentId>'`; one `ConsultantEarnings` row (record its `holdUntil`, MO-48).

**Probe further:** on `dev` before the fix for issue #2962 the expected result is the parked state, and the report must say which of these it saw: (a) parked: the trial still `AWAITING_PAYMENT` with its tentative occurrence, the payment `SUCCEEDED` with a `REQUIRES_MANUAL_RECOVERY` description, one `unapplied:<paymentId>` journal, no `booking:` journal and no earnings; (b) no trial or appointment for the payment; (c) no journals at all. Only (a) is the known parked state. Retire the event id at cleanup as in MO-63.

## MO-72 — A real test-mode purchase confirms through whichever door wins `[local]`

**Why it matters:** MO-70 and MO-71 hand the handler the order's notes; only a real purchase shows what notes the payment entity carries and whether the door that confirms first can confirm on them.

**Setup (local with test keys, owner-run; real gateway webhooks reach the server only through a tunnel, so record whether one was up):** three rows, each paid for real in Razorpay test mode through the browser, never Mock Pay and never a hand-posted delivery: B1 buys a subscription (first purchase); B1 renews an active subscription (the renewal checkout); B1 pays TR-04's held paid trial at its pay page (`/checkout/pay/<paymentId>`). Record each payment id, order id and gateway payment id.

**Steps:** for each row:

1. Pay with a test card and let the browser return finish.
2. Read which door confirmed: neither door writes a record saying it won. The payment's `capturedAt` is stamped by the transaction that confirmed. The browser return writes a `SystemEvent` (message `client-side payment confirmation`, `correlationId` = the order id) just before it runs the handler; the webhook door writes its `WebhookEvent` (`eventId` = `<event type>:<entity id>:<gateway event id>`) before its handler runs and sets `processedAt` when the handler finishes. A door whose start record is later than `capturedAt` lost. If both start before `capturedAt`, the rows cannot name the winner: record "undecided" with all four times (`SystemEvent.createdAt`, `WebhookEvent.receivedAt`, `capturedAt`, `processedAt`). Without a tunnel the browser return is the only door; say so.
3. Read the payment entity's notes and the order's notes from the gateway (test dashboard, or the Razorpay MCP's `fetch_payment` and `fetch_order`), and the `payment.captured` `WebhookEvent.payload` notes if one arrived. Put the two notes objects side by side in the report as evidence; never copy one into the other or post a delivery built from them.

**Expect:** when the payment entity's notes match the order's: the subscription rows as MO-70's Expect and the trial row as MO-71's Expect, with the same pre-fix control on `dev`. When the payment entity's notes are empty or lack the fields the order carries, the expected result depends on PR #2969 (a capture on a booking that already exists, identified from the app's own rows); until it is merged, grade nothing for that branch: record the state found, using MO-70's and MO-71's (a)/(b)/(c) wording, and the door that produced it. Either way: one `booking:` journal at most, and the second door to arrive changes nothing.

**Probe further:** the buyer's success page while the plan or trial is parked: does it say "confirming your booking" forever, or tell them anything true? These are real gateway events; leave their `WebhookEvent` rows as they are at cleanup.

## MO-73 — Folder money ledger and cleanup

**Why it matters:** refunds and ledger rows are append-only; the report must list what stays.

**Steps:** list every payment, refund, credit note, ledger transaction and earnings row this folder created (MO-29's query plus MQ-1 per payment). Cancel live bookings through the product. Delete only mock-payment graphs (R-09 order). Retire synthetic `WebhookEvent` rows with MO-63's query. Clear QA-ONLY markers (`refundOwed*` to null) only after their case's assertions, and restore any shifted `holdUntil`, refund status or occurrence time.

**Expect:** a ledger table in the report: id, type, amount (₹), status, kept/deleted, why.
