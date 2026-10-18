# E2E Booking Algorithm Test — Agent 013: Duplicate Submits & Two Devices

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Read first:** [`wave0-shared-setup.md`](./wave0-shared-setup.md)

> **Coverage marker:** Agent 009 pins checkout's body-field key and the allocate
> routes' `Idempotency-Key` header. This case covers what 009 does not: the
> **request-for-approval** key (`Consultation.requestIdempotencyKey`), two people
> or two devices going for one slot, and a **seat re-buy** after the earlier
> payment lapsed. Use fixture suffix `-013`.

You are a senior QA engineer. Prove that a double-click, a retried request, a
second tab and a second device each produce one booking, one hold and one payment,
and that the loser always gets a typed answer, never a 500.

## Critical Rules

1. Every step asserts the HTTP status **and** the rows. A 201 that wrote two rows
   is a failure.
2. `/api/scheduling/request-for-approval` reads the **`Idempotency-Key` header**
   (8–128 characters after trimming). `/api/checkout` reads the **body field**
   `clientIdempotencyKey` and mints one itself when it is absent. Do not mix them.
3. A stray 500 on any duplicate is a bug even when the database is correct.

---

## Phase 0 — Data seeding

Create with the `-013` suffix: consultant `testconsultant013@familiarise.com`
(profile `test-consultant-profile-013`, `scheduleType` `WEEKLY`, Mon–Fri
09:30–17:00 IST = `startTimeUtc` 240 to `endTimeUtc` 690, seeded with the local
columns from the shared setup), consultees `testconsultee013a@…` and
`testconsultee013b@…` (create the accounts through the signup UI, then attach
profiles via SQL as in Agent 005 Phase 0), a published consultation plan
`test-consultation-plan-013` (0.5 h, ₹1,000 = 100000 paise), and a published
webinar plan with one webinar `test-webinar-013` (₹500 = 50000 paise, capacity 5,
no confirmed slots needed). Record the weekly row id for the Monday window as
`<WEEKLY_ROW_ID>`.

Pin `D` to the coming **Monday**. Slots below are `D+7` (the Monday after).

## Phase 1 — Without a key, a duplicate is refused, not doubled

As consultee A, POST the same body twice, sequentially:

```javascript
async () => {
  const body = {
    consultantProfileId: "test-consultant-profile-013",
    consultationPlanId: "test-consultation-plan-013",
    availabilityWindowWeeklyId: "<WEEKLY_ROW_ID>",
    startsAt: "<D+7T04:30Z>",
    endsAt: "<D+7T05:00Z>",
  };
  const send = () =>
    fetch("/api/scheduling/request-for-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { first: await send(), second: await send() };
};
```

**Expected:** first `201`; second `409` with `code: "SLOT_TAKEN"` and the message
"You already have a session booked during this time." (the consultee's own pending
request occupies the slot).

```sql
SELECT COUNT(*) AS requests
FROM "Consultation" c
JOIN "ConsulteeProfile" cp ON cp.id = c."requestedById"
JOIN "User" u ON u.id = cp."userId"
WHERE u.email = 'testconsultee013a@familiarise.com'
  AND c."consultationPlanId" = 'test-consultation-plan-013';
-- Expected: 1
```

Remove it before Phase 2: the consultee walks away through
`POST /api/bookings/<APPOINTMENT_ID>/abandon` (expected `200`, the request ends
`CANCELLED`, the tentative hold is released).

## Phase 2 — With a key, a retry replays the first answer

Repeat Phase 1 with the header `Idempotency-Key: agent-013-req-0001` on both calls.

**Expected:** both `201` with the **same** `data.id`; the second body is the first
request replayed, not a new row.

```sql
SELECT COUNT(*) AS requests, MIN("requestIdempotencyKey") AS key
FROM "Consultation" WHERE "requestIdempotencyKey" = 'agent-013-req-0001';
-- Expected: requests = 1, key = agent-013-req-0001
```

## Phase 3 — Two requests in flight with one key

Abandon the Phase 2 request, then send two calls with the new key
`agent-013-req-0002` **at the same time** (`Promise.all`).

**Expected:** both `201` and the same `data.id` (the loser hits the unique
`requestIdempotencyKey`, the route replays the winner), or the loser gets a `409`
for the per-account lock with `retryAfter` (an account lock is a typed answer);
never a `500`. Exactly one row carries the key.

## Phase 4 — The key belongs to its user, and must be well formed

1. Consultee B sends a request with consultee A's still-live key
   `agent-013-req-0002`. **Expected:** `422`, `code: "IDEMPOTENCY_KEY_REUSED"`,
   and no row for B.
2. Consultee A sends `Idempotency-Key: short`. **Expected:** `400`, "Invalid
   Idempotency-Key header".

## Phase 5 — Two devices, one slot

Abandon A's request. In two separate browser contexts sign in as A and B and send
**at the same time** a request for the same Monday window with different keys
(`agent-013-dev-a`, `agent-013-dev-b`).

**Expected:** exactly one `201`; the other `409` with `code: "SLOT_TAKEN"` (the
other party's name is not in the body) or an account/slot lock `409`.

```sql
SELECT o."startsAt", o."isTentative", c."status"
FROM "AppointmentOccurrence" o
JOIN "Appointment" a ON a.id = o."appointmentId"
JOIN "Consultation" c ON c.id = a."consultationId"
WHERE c."consultationPlanId" = 'test-consultation-plan-013'
  AND o."startsAt" = '<D+7T04:30Z>' AND o."deletedAt" IS NULL;
-- Expected: exactly ONE live occurrence for the slot (the winner's tentative hold).
```

## Phase 6 — Direct checkout: one payment per key, one slot per device pair

Needs Razorpay test mode for the non-mock steps; with mock payments only, run
step 1 and SKIP the rest.

1. As A, `POST /api/checkout` twice with the same `clientIdempotencyKey`
   (`agent-013-co-0001`) for a different Monday window. **Expected:** same payment
   identity both times and one `Payment` row for the key.
2. Two devices, same free slot, **different** keys, simultaneous. **Expected:**
   exactly one success; the loser `409` with `code: "SLOT_TAKEN"`,
   `yourCardWasNotCharged: true`. No second `Payment` with `appointmentId` on the
   same slot.

## Phase 7 — Seat re-buy after a lapsed payment (real PENDING payment needed)

1. As B, start a non-mock webinar checkout for `test-webinar-013`. Record the
   `PAYMENT_ID` and its order id `<ORDER_1>` (`Payment.paymentIntent`).
2. Make the hold lapse and let the sweep expire it:

   ```sql
   UPDATE "Payment" SET "expiresAt" = NOW() - INTERVAL '1 hour' WHERE id = '<PAYMENT_ID>';
   ```

   then `GET /api/cleanup/abandoned-payments?limit=20` with the cron secret.
   **Expected:** the payment is `EXPIRED` and B's seat is released.
3. B buys the seat again (new `clientIdempotencyKey`). **Expected:** `200`, **not**
   `500`. The same `PAYMENT_ID` is reused and now `PENDING` with a new order
   `<ORDER_2>`.

   ```sql
   SELECT id, "paymentStatus", "paymentIntent", "appointmentId"
   FROM "Payment"
   WHERE id = '<PAYMENT_ID>' OR "paymentIntent" = '<ORDER_1>';
   -- Expected: two rows. <PAYMENT_ID>: PENDING, intent <ORDER_2>, appointmentId set.
   -- The tombstone: EXPIRED, intent <ORDER_1>, appointmentId NULL, description
   -- "Order replaced by a re-mint (seat re-bought ...)".
   ```

4. Press buy a third time while the second is still PENDING. **Expected:** a typed
   refusal `PAYMENT_ALREADY_EXISTS`, no second row.

## Phase 8 — Cleanup

Abandon or cancel every request and checkout this case created, expire open
PENDING payments with the sweep, then delete QA rows in the order given in the
shared setup. Leave refund and ledger rows. Make any synthetic `WebhookEvent`
terminal (`permanent:` prefix).

## Pass/fail table

| #   | Check                                          | Expected                                |
| --- | ---------------------------------------------- | --------------------------------------- |
| 1   | Duplicate without a key                        | 201 then 409 `SLOT_TAKEN`, 1 row        |
| 2   | Duplicate with a key                           | 201 and 201, same id, 1 row             |
| 3   | Concurrent same key                            | no 500, 1 row                           |
| 4   | Key reused by another user / malformed         | 422 `IDEMPOTENCY_KEY_REUSED` / 400      |
| 5   | Two devices, one slot                          | one winner, one `SLOT_TAKEN`            |
| 6   | Checkout key replay / two devices              | one Payment per key / `SLOT_TAKEN`      |
| 7   | Seat re-buy after lapse                        | 200, same row re-minted, tombstone      |
