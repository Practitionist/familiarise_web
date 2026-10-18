# E2E Booking Algorithm Test — Agent 019: A Refund Owed Is Never Lost

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000` (Razorpay **test mode** for Phases 4–5)
**Read first:** [`wave0-shared-setup.md`](./wave0-shared-setup.md)

> **Coverage marker:** every door that ends a paid booking stamps a durable
> per-payment **refund-owed marker** (`Payment.refundOwedKey`, `refundOwedPaise`,
> `refundOwedReason`, `refundOwedAt`, `refundOwedAttempts`) in the same commit,
> then drives the refund under that key. The `retry-auto-refunds` sweep re-drives
> any marker still set after 15 minutes. This case proves the happy path clears the
> marker, a dropped drive is re-driven exactly once, a **definitive** gateway
> refusal is retried and then escalated once, and an **ambiguous** one is left to
> reconciliation. Fixture suffix `-019`.

You are a senior QA engineer. The pass bar: money is returned **once**, under the
key, and a stuck refund is surfaced to a human exactly once, never silently lost
and never paid twice.

## Critical Rules

1. Mock payments refund successfully through the mock path; only a real test-mode
   payment can exercise a gateway failure. Mark Phases 4–5 SKIPPED if the server
   has no Razorpay test keys.
2. Several steps **emulate the state a crash would leave** by writing the marker
   with SQL. They are labelled QA-ONLY. Never do this outside a `-019` fixture.
3. Do not pre-create a `Refund` row to mark intent. A PENDING `Refund` row reduces
   the refundable balance and makes the owed sweep skip the payment.
4. Read the Netlify function logs for the sweep run. The stuck escalation is one
   system error per payment, not one Sentry event per attempt.

---

## Phase 0 — Data seeding

With suffix `-019`: consultant `testconsultant019@…` (profile
`test-consultant-profile-019`, `WEEKLY`, Mon–Fri 09:30–17:00 IST with local
columns), consultee `testconsultee019@…`, a 0.5 h plan `test-consultation-plan-019`
(₹2,000 = 200000 paise before tax; read the real charged `Payment.amount` and use
it below as `<AMOUNT>`), and a webinar `test-webinar-019` with two mock-paid
attendees. Pin `D` to the coming **Monday**. Book `<APPT_1>` and `<APPT_2>` at
`D+7` and `D+8` 05:00Z by mock payment (Agent 009 Phase 1 body). Record
`<PAYMENT_1>` and `<PAYMENT_2>`.

## Phase 1 — The happy path leaves no marker and one keyed refund

Cancel `<APPT_1>` as the consultee (more than 24 h out, so 100 %). Send
`expectedRefundPaise` from `GET .../cancel/preview`.

**Expected:** `200`.

```sql
SELECT r."dedupeKey", r."amountPaise", r.status,
       p."refundOwedKey", p."refundOwedPaise", p."refundOwedAttempts"
FROM "Refund" r JOIN "Payment" p ON p.id = r."paymentId"
WHERE p.id = '<PAYMENT_1>';
-- Expected: exactly one row; dedupeKey = 'cancel:<APPT_1>:<PAYMENT_1>';
-- amountPaise = the previewed estimatedRefundPaise; marker columns NULL / attempts 0
```

The platform bears the gateway fee: `amountPaise` is the quoted percentage of the
charge, with no fee deducted.

## Phase 2 — A dropped drive is re-driven once (QA-ONLY emulation)

Emulate "the function died after the cancel committed, before the refund call".
First put `<APPT_2>` into the shape the cancel commit leaves (booking and sessions
ended, payment untouched), then mark its payment as owing its full amount, aged
past the 15-minute grace, without calling the refund door:

```sql
UPDATE "Consultation" SET status = 'CANCELLED', "cancelledAt" = NOW()
WHERE id = (SELECT "consultationId" FROM "Appointment" WHERE id = '<APPT_2>');
UPDATE "AppointmentOccurrence" SET "completionStatus" = 'CANCELLED', "deletedAt" = NOW()
WHERE "appointmentId" = '<APPT_2>';
UPDATE "Payment"
SET "refundOwedKey" = 'cancel:<APPT_2>:<PAYMENT_2>',
    "refundOwedPaise" = <AMOUNT>,
    "refundOwedReason" = 'qa019 emulated crash after commit',
    "refundOwedAt" = NOW() - INTERVAL '20 minutes',
    "refundOwedAttempts" = 0
WHERE id = '<PAYMENT_2>' AND "paymentStatus" = 'SUCCEEDED';
```

Run `GET /api/cleanup/retry-auto-refunds?limit=50` with the cron secret.

**Expected:** the response counts `owed.scanned >= 1` and `owed.refunded >= 1`;
one `Refund` row with `dedupeKey = 'cancel:<APPT_2>:<PAYMENT_2>'` and
`amountPaise = <AMOUNT>`; the marker cleared. Run the sweep **again**: no new
`Refund` row (the key is unique), `owed.scanned` no longer includes the payment.

A marker younger than 15 minutes must **not** be driven: set `refundOwedAt` to
`NOW()` on one more mock-paid booking's payment (book it first) and confirm the sweep leaves it alone.

## Phase 3 — Two doors, two key shapes

Check that each door stamps and drives under its own key (read `Refund.dedupeKey`):

| Door                               | Action                                           | Expected key                                |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| Consultee cancel (Phase 1)         | cancel a booking                                 | `cancel:<appointmentId>:<paymentId>`        |
| Whole-event cancel                 | host cancels `test-webinar-019` (both seats paid) | `event-cancel:<eventId>:pay:<paymentId>` x2 |

For the webinar, the response may report the seats as refunded immediately or as
pending the sweep; either way, after one sweep run both seats have exactly one
refund each and no marker remains.

## Phase 4 — Definitive gateway refusal: retried, then escalated once (real payment)

1. As the consultee, pay for a booking `<APPT_4>` in Razorpay test mode (card
   `4111 1111 1111 1111`) and let the webhook confirm it.
2. In the Razorpay **test** dashboard, fully refund that payment by hand (this
   leaves a gateway refund our database never recorded: note its id in the report
   and never do this in live mode). Our next
   refund call is now refused with `BAD_REQUEST_ERROR` (a **definitive** refusal:
   no gateway refund can exist, so the reservation row goes `FAILED` at once).
3. Stamp the marker as in Phase 2 for `<PAYMENT_4>` (`refundOwedAt` 20 minutes old).
4. Run `retry-auto-refunds` three times in a row.

**Expected after each run:** `refundOwedAttempts` is 1, then 2, then 3; each failed
reservation is a `Refund` row with `status = 'FAILED'` and a `failureReason` (a
FAILED row gives up its `dedupeKey`, set to NULL, when the next attempt starts, so
only the latest row carries the key); no SUCCEEDED refund exists and the refundable
balance is restored after each failure. After the **third** run exactly one system error is
recorded, and a **fourth** run no longer scans the payment (`refundOwedAttempts <
3` is part of the cohort filter):

```sql
SELECT COUNT(*) FROM "SystemEvent"
WHERE message LIKE 'Refund owed on payment <PAYMENT_4> failed 3 times%';
-- Expected: 1
```

The marker is deliberately **left set** so an operator can refund by hand and see
the amount owed; confirm `refundOwedKey` is still not NULL.

## Phase 5 — Ambiguous outcome: reconciliation owns it (QA-ONLY emulation)

A timeout or 5xx may have moved money, so the reservation stays `PENDING`. A real
timeout cannot be produced on demand, so emulate the state. Book and mock-pay a
fifth consultation (`<APPT_5>`, `D+9` 05:00Z, `<PAYMENT_5>`), put it into the
cancelled shape and stamp its marker exactly as in Phase 2 (key
`cancel:<APPT_5>:<PAYMENT_5>`), then insert the placeholder the first attempt
would have left:

```sql
INSERT INTO "Refund" (id, "amountPaise", currency, status, "refundId", "dedupeKey",
                      "paymentGateway", "paymentId", "updatedAt")
VALUES (gen_random_uuid(), <AMOUNT>, 'INR', 'PENDING', 'pending_qa019-1',
        'cancel:<APPT_5>:<PAYMENT_5>', 'RAZORPAY', '<PAYMENT_5>', NOW());
```

Run `retry-auto-refunds`. **Expected:** the payment is **skipped** (a PENDING refund
means `reconcile-refunds` owns it), the marker stays, no second `Refund` row is
created and no gateway call is made. Run `GET /api/cleanup/reconcile-refunds`: the
placeholder is matched to a gateway refund by the reservation id in its notes, or
left PENDING until 24 hours have passed with no matching refund, and only then
`FAILED`; it is never failed earlier. Retire the placeholder by hand at the end of
the case (`status = 'FAILED'`, `failureReason = 'qa019 cleanup'`).

## Phase 6 — Cleanup

Clear remaining `-019` markers (`refundOwed*` to NULL), including `<PAYMENT_4>`'s
(the dashboard refund in Phase 4 settled that obligation by hand: record its
Razorpay refund id), make any synthetic
`WebhookEvent` terminal, delete QA rows in the order in the shared setup, and
record the ids of the `Refund` and ledger rows you leave behind (append-only).

## Pass/fail table

| #   | Check                                        | Expected                                           |
| --- | -------------------------------------------- | -------------------------------------------------- |
| 1   | Cancel, happy path                           | one keyed `Refund`, marker cleared                 |
| 2   | Dropped drive, then sweep twice              | refunded once, second run a no-op                  |
| 3   | Marker younger than 15 minutes               | not driven                                         |
| 4   | Each door's key                              | `cancel:` and `event-cancel:...:pay:` shapes       |
| 5   | Definitive refusal x3                        | attempts 1, 2, 3; one system error; then skipped   |
| 6   | Ambiguous (PENDING) refund                   | sweep skips; reconcile resolves; no second refund  |
