# E2E Booking Algorithm Test — Agent 016: Stale Clients, Cancel and Reschedule Races, and the Caps

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Read first:** [`wave0-shared-setup.md`](./wave0-shared-setup.md)

> **Coverage marker:** what a tab that has been open too long can do. The grid
> self-corrects every 60 s and a taken slot answers 409 `SLOT_TAKEN` ("just
> taken"); a cancel dialog's refund figure is bound to the click (409
> `REFUND_QUOTE_CHANGED`); a cancel retry replays the committed result; cancel
> racing a reschedule leaves one consistent outcome; and reschedules are capped
> per side from the release history. Fixture suffix `-016`.

You are a senior QA engineer. Prove no stale or racing client can charge, refund
or move something other than what its user saw, and that every loser gets a typed
answer.

## Critical Rules

1. Record the refund the dialog shows (`estimatedRefundPaise` from
   `GET .../cancel/preview`) and compare it numerically with the `Refund` row.
2. For each race, run the two calls with `Promise.all` from two contexts, then
   assert the **final database state** is one of the two legal outcomes, never a mix.
3. The caps are 2 consultee reschedules per baseline session, 2 expert reschedules
   per booking. Staff are exempt.

---

## Phase 0 — Data seeding

Create with the `-016` suffix: consultant `testconsultant016@…` (profile
`test-consultant-profile-016`, `WEEKLY`, Mon–Fri 09:30–17:00 IST seeded with local
columns), consultees `testconsultee016a@…` and `testconsultee016b@…`, a 0.5 h plan
`test-consultation-plan-016` (₹2,000 = 200000 paise). Pin `D` to the coming
**Monday**. Book three mock-payment consultations for consultee A at `D+7`, `D+8`
and `D+9` at 05:00Z through `POST /api/checkout` (Agent 009 Phase 1 body).
Record `<APPT_1..3>` and `<PAYMENT_1..3>`. Each is more than 6 days out, so the
quote is the top tier: 100 % = 200000 paise.

## Phase 1 — A stale grid, then "just taken"

1. In context A, load the expert's grid for the week of `D+7` and note the
   response `ETag` and that `D+10` 05:00Z is available.
   `GET /api/scheduling/availability-with-allocation/test-consultant-profile-016?startDateInUtc=...&endDateInUtc=...&timezone=Asia/Kolkata`
2. Repeat the call with `If-None-Match: <ETag>`. **Expected:** `304`.
3. In context B (consultee B), book `D+10` 05:00Z. **Expected:** `200`.
4. Context A repeats step 2 with its old ETag. **Expected:** `200` with a **new**
   ETag, and `D+10` 05:00Z is no longer available (the poll picks the change up
   within its 60 s cadence in the UI: load the booking page, wait 60–75 s with the
   tab visible, and see the slot disappear without a manual reload).
5. Context A (still showing the slot because it never refetched) books it:
   **Expected:** `409`, `code: "SLOT_TAKEN"`, `errorType: "AVAILABILITY_ERROR"`,
   `yourCardWasNotCharged: true`, message "Someone else booked this time moments
   ago. Your card was not charged." In the UI the toast reads "That time was just
   taken — pick another." and the grid refetches.

```sql
SELECT COUNT(*) FROM "Payment" WHERE "userId" = '<CONSULTEE_A_ID>' AND "appointmentId" IN
  (SELECT a.id FROM "Appointment" a JOIN "AppointmentOccurrence" o ON o."appointmentId" = a.id
   WHERE o."startsAt" = '<D+10T05:00Z>' AND o."deletedAt" IS NULL);
-- Expected: 0 (the loser has no Payment on that slot)
```

## Phase 2 — The refund shown is the refund charged

Record the quote for `<APPT_1>`:

```javascript
async () => {
  const r = await fetch("/api/appointments/<APPT_1>/cancel/preview");
  return { status: r.status, body: await r.json() };
};
```

**Expected:** `refundPct: 100`, `estimatedRefundPaise: 200000`.

1. Send the cancel with a **wrong** figure, as a dialog from before a tier change
   would:

   ```javascript
   async () => {
     const r = await fetch("/api/appointments/<APPT_1>/cancel", {
       method: "POST",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ expectedRefundPaise: 100000, notes: "Agent 016 stale quote" }),
     });
     return { status: r.status, body: await r.json() };
   };
   ```

   **Expected:** `409`, `code: "REFUND_QUOTE_CHANGED"`, `refundPaise: 200000`,
   `refundPct: 100`, `creditRestoresInFull: false`. **Nothing is committed:**

   ```sql
   SELECT c.status, p."refundOwedKey", (SELECT COUNT(*) FROM "Refund" r WHERE r."paymentId" = p.id) AS refunds
   FROM "Consultation" c
   JOIN "Appointment" a ON a."consultationId" = c.id
   JOIN "Payment" p ON p."appointmentId" = a.id
   WHERE a.id = '<APPT_1>';
   -- Expected: status unchanged (not CANCELLED), refundOwedKey NULL, refunds = 0
   ```

2. Resend with the figure the 409 returned (`expectedRefundPaise: 200000`).
   **Expected:** `200`. The `Refund` row's `amountPaise` equals `200000` and its
   `dedupeKey` is `cancel:<APPT_1>:<PAYMENT_1>`; the marker is cleared after the
   refund (`refundOwedKey` NULL).
3. A body **without** `expectedRefundPaise` (an older client) is accepted unbound:
   cancel `<APPT_2>` that way. **Expected:** `200`, refund `200000`.

## Phase 3 — Cancelling twice, and cancelling someone else's cancel

1. `<APPT_3>`: send the cancel twice in a row from the same consultee (a
   double-click or a retry after a lost response). **Expected:** the first `200`;
   the second `200` with `replayed: true` and the **same** refund figure and
   status, not `NOT_CANCELLABLE`. Exactly one `Refund` row for the payment.
2. Then, as the **consultant**, cancel `<APPT_3>`. **Expected:** `409`,
   `code: "NOT_CANCELLABLE"` (someone else already ended it). Still one refund.

## Phase 4 — Cancel races a reschedule answer

Book a fourth consultation `<APPT_4>` (`D+11`, 05:00Z). As the consultant propose
a new time (`POST /api/appointments/<APPT_4>/reschedule` with `slotIds`,
`proposedSlots` of one atom, as in Agent 007 Phase 3). Then, from two contexts at
once:

- consultee A accepts: `POST /api/appointments/<APPT_4>/reschedule/respond`;
- consultee A's other tab cancels: `POST /api/appointments/<APPT_4>/cancel`.

**Expected:** exactly one wins and the loser gets a typed `409`
(`PROPOSAL_NOT_OPEN`, `NOT_CANCELLABLE`, `ILLEGAL_TRANSITION` or
`RESCHEDULE_STATE_CHANGED`), never `500`. Assert the final state is **one** of:

| Winner  | Booking          | Occurrences                     | Proposal            | Refund                 |
| ------- | ---------------- | ------------------------------- | ------------------- | ---------------------- |
| Accept  | not cancelled    | one live at the new time        | ACCEPTED/AUTO_ACCEPTED | none                |
| Cancel  | `CANCELLED`      | none live, history kept         | closed (declined)   | one `Refund` row       |

and in both cases `openForAppointmentId IS NULL` for the proposal row (no orphaned
lock) and no live occurrence at **both** times.

## Phase 5 — The reschedule caps count releases, not rows

Use a fresh consultation `<APPT_5>` for consultee A. Each reschedule is: the
consultee releases the session with `POST /api/appointments/<APPT_5>/reschedule`
(`{ "slotIds": [<current occurrence ids>] }`, no proposed times), then the expert
places a new time through the allocate route (manual, `isReschedule: true`,
`expectedTentativeSlotCount` read from the live count; copy the dialog's request
from the network panel if the body differs).

After each cycle count:

```sql
SELECT COUNT(DISTINCT h."createdAt") AS releases
FROM "BookingStatusHistory" h
WHERE h."appointmentId" = '<APPT_5>' AND h.entity = 'OCCURRENCE'
  AND h."toStatus" = 'RESCHEDULED' AND h."actorUserId" = '<CONSULTEE_A_USER_ID>';
```

**Expected:** cycles 1 and 2 succeed (`releases` 1, then 2); the **third** consultee
release answers `422`, `code: "MAX_RESCHEDULES_EXCEEDED"` (2 per baseline session).
The allocator replacing occurrences between cycles must not reset the count.

Repeat for the **expert** on a fresh booking `<APPT_6>`: the first two expert
reschedules succeed and the third answers `409`, `code: "EXPERT_RESCHEDULE_CAP"`
with the message "...If the time no longer works, cancel instead — the client gets
a full refund." As ADMIN the same third call is not capped.

## Phase 6 — Cleanup

Cancel open bookings through the cancel route (refunds are append-only; record
their ids), delete QA rows in the order in the shared setup, and make any
synthetic `WebhookEvent` terminal.

## Pass/fail table

| #   | Check                                   | Expected                                         |
| --- | --------------------------------------- | ------------------------------------------------ |
| 1   | ETag unchanged / changed                | 304 / 200 with new ETag, slot gone               |
| 2   | Booking a slot another user just took   | 409 `SLOT_TAKEN`, card not charged               |
| 3   | Wrong `expectedRefundPaise`             | 409 `REFUND_QUOTE_CHANGED`, nothing committed    |
| 4   | Correct figure / absent figure          | 200, refund equals the quote                     |
| 5   | Cancel twice / by the other party       | `replayed: true` / 409 `NOT_CANCELLABLE`         |
| 6   | Cancel vs accept                        | one outcome, loser typed 409, no orphan lock     |
| 7   | Third consultee / third expert release  | 422 `MAX_RESCHEDULES_EXCEEDED` / 409 `EXPERT_RESCHEDULE_CAP` |
