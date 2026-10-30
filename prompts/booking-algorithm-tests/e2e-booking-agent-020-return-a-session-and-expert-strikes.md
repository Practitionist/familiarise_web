# E2E Booking Algorithm Test — Agent 020: Return a Session to the Plan, and Expert Strikes

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Read first:** [`wave0-shared-setup.md`](./wave0-shared-setup.md)

> **Coverage marker:** a subscription buyer may hand back one scheduled session
> that is **24 hours or more ahead**, at most **twice per plan**; each return
> extends the plan end by **7 days** and moves no money. An expert who cancels a
> paid booking, or is a consultant no-show, earns a **reliability strike** that
> shows on the profile at three in 90 days and in ops review; the expert pays no
> money. Fixture suffix `-020`.

You are a senior QA engineer. Prove the return is atomic (session released, counter
spent and plan end extended together or not at all), repeatable by key, capped, and
that strikes are written only for the right events.

## Critical Rules

1. Time-of-day matters: the 24-hour cutoff is read from the **database's `now()`**,
   not the browser clock. Compute cutoffs in SQL (`SELECT NOW()`).
2. `POST .../return` is replayed by `Idempotency-Key`. Without a key every call is
   its own attempt.
3. A refusal here is a typed `409` with a `code`; a `403` is "not your plan".

---

## Phase 0 — Data seeding

With suffix `-020`: consultant `testconsultant020@…` (profile
`test-consultant-profile-020`, `WEEKLY`, Mon–Fri 09:30–17:00 IST with local
columns), consultee `testconsultee020@…`, a second consultee `…020b@…`, a
published subscription plan `test-subscription-plan-020` (4 sessions, ₹4,000) and a
0.5 h consultation plan `test-consultation-plan-020` (₹1,000). Pin `D` to the
coming **Monday**. Buy the subscription by mock payment, have the expert allocate
four sessions at `D+7`, `D+8`, `D+9` and `D+10` 05:00Z, and record
`<SUB_APPT>`, the four occurrence ids `<OCC_1..4>` and:

```sql
SELECT "sessionsReturned", "planEndsAt" FROM "Subscription" WHERE id = '<SUB_ID>';
-- Record <ENDS_0>; sessionsReturned = 0. planEndsAt is the fixed plan end written at
-- purchase; a NULL means the fixture was inserted by SQL, so set it to the plan's end first.
```

Make one occurrence start **less than 24 hours from now** by moving it with SQL
(`<OCC_SOON>`, QA-ONLY) so the window-closed case is reachable.

## Phase 1 — A return, and its replay

As the consultee:

```javascript
async () => {
  const r = await fetch("/api/appointments/<SUB_APPT>/occurrences/<OCC_1>/return", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "agent-020-ret-0001" },
    body: "{}",
  });
  return { status: r.status, body: await r.json() };
};
```

**Expected:** `200` with `{ occurrenceId, sessionsReturned: 1, planEndsAt }`
where the end is exactly `<ENDS_0>` plus 7 days.

```sql
SELECT o."completionStatus", s."sessionsReturned", s."planEndsAt",
       (SELECT COUNT(*) FROM "BookingStatusHistory" h
        WHERE h."appointmentId" = '<SUB_APPT>' AND h.reason = 'RETURNED_TO_PLAN') AS history
FROM "AppointmentOccurrence" o
JOIN "Appointment" a ON a.id = o."appointmentId"
JOIN "Subscription" s ON s.id = a."subscriptionId"
WHERE o.id = '<OCC_1>';
-- Expected: CANCELLED, sessionsReturned = 1, ends = <ENDS_0> + 7 days, history = 1
```

No `Refund`, no ledger entry, no payment change. The expert receives one bell and one
email (look for an `appointment-cancelled` outbox row for the expert).

Send the **same request again with the same key**. **Expected:** the first answer is
replayed (`200`, same body); `sessionsReturned` is still 1 and the end moved only
once.

## Phase 2 — The cap, the window and the guards

1. Return `<OCC_2>` with a **new** key. **Expected:** `200`, `sessionsReturned: 2`,
   end = `<ENDS_0>` + 14 days.
2. Return `<OCC_3>`. **Expected:** `409`, `code: "RETURN_CAP_REACHED"`, "You've
   already returned 2 sessions to this plan."; counters unchanged.
3. On a fresh plan (or after resetting the counter on a `-020` row), return
   `<OCC_SOON>`. **Expected:** `409`, `code: "RETURN_WINDOW_CLOSED"`, "...starts in
   less than 24 hours... If you miss it, it counts as delivered."
4. Return an already returned session (`<OCC_1>` again, new key): `409`,
   `code: "SESSION_NOT_RETURNABLE"`.
5. As **consultee B** (not the buyer): `403`. As the expert: `403`. Unauthenticated:
   `401`.
6. While a reschedule proposal is open on the plan: `409`,
   `code: "RETURN_RESCHEDULE_OPEN"`. With an open dispute on the plan's payment:
   `409`, `code: "DISPUTE_ACTIVE"`.
7. Two returns at the same instant on different sessions with different keys, when
   the counter is at 1: **Expected:** exactly one succeeds and the other is
   `RETURN_CAP_REACHED`; `sessionsReturned` never exceeds 2 (the
   `subscription_sessions_returned_range` CHECK is the backstop).

## Phase 3 — Expert strikes

Count strikes before and after each action:

```sql
SELECT COUNT(*) FROM "SystemEvent"
WHERE "correlationId" = 'expert-reliability:test-consultant-profile-020';
```

1. Book a paid consultation (mock payment) for the consultee at `D+11`. As the
   **consultee**, cancel it. **Expected:** the count is unchanged (the client's own
   cancel is not an expert miss).
2. Book another at `D+12`. As the **expert**, cancel it. **Expected:** `200`, the
   booking is refunded 100 % under the cancel key, and the count rises by exactly
   **one** (`context.strike = 'EXPERT_CANCEL'`, same transaction as the cancel).
3. Cancel an **unpaid** request as the expert (a `PENDING` request). **Expected:**
   no strike (nothing paid).
4. As an ADMIN who is also an operator of the expert's host organisation, cancel a
   paid booking. **Expected:** no strike (a platform or admin cancel is not the
   expert's miss).
5. (Optional, needs Stream presence data) let a paid session pass with the expert
   absent and run `GET /api/cleanup/detect-consultant-no-shows?limit=5`.
   **Expected:** one `CONSULTANT_NO_SHOW` strike and the 100 % refund under
   `consultant-no-show:<paymentId>`; a second run adds nothing.

## Phase 4 — Where strikes show

1. Insert two more strikes for the expert by repeating step 2 of Phase 3 on
   fresh bookings (three in total inside 90 days). Open the expert's public page:
   **Expected:** the reliability notice is shown. At two strikes it is not.
2. As ADMIN or STAFF, `GET /api/admin/sessions/expert-strikes`. **Expected:**
   `200`, the expert listed with `strikes: 3` and a `lastStrikeAt`. A consultee
   gets `403`.
3. Age two strikes past the window (QA-ONLY: set their `createdAt` to 100 days
   ago) and reload: the notice disappears and the list drops to `strikes: 1`.

## Phase 5 — Cleanup

Cancel remaining bookings through the cancel route, restore any `-020` rows you
moved or aged, delete QA rows in the order in the shared setup, and leave the
`SystemEvent` strike rows (append-only evidence) with their ids recorded.

## Pass/fail table

| #   | Check                                   | Expected                                      |
| --- | --------------------------------------- | --------------------------------------------- |
| 1   | Return, replay by key                   | 200; end +7 days once                         |
| 2   | Third return                            | 409 `RETURN_CAP_REACHED`                      |
| 3   | Inside 24 h / already returned          | 409 `RETURN_WINDOW_CLOSED` / `SESSION_NOT_RETURNABLE` |
| 4   | Not the buyer                           | 403                                           |
| 5   | Two returns racing at the cap           | one wins; counter never above 2               |
| 6   | Consultee cancel / unpaid cancel / admin | no strike                                    |
| 7   | Expert cancels a paid booking           | exactly one strike, 100 % refund              |
| 8   | Three strikes in 90 days                | profile notice; ops list shows 3              |
