# E2E Booking Algorithm Test — Agent 014: Allocation Boundaries & the Host-Side Rule

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Read first:** [`wave0-shared-setup.md`](./wave0-shared-setup.md)

> **Coverage marker:** who may allocate (the consultee may not), where a window
> may start and end (the edge atoms and an overnight tail), that a window is
> sold only at the plan's own length, and that a paused expert takes no new
> booking. Use fixture suffix `-014`.

You are a senior QA engineer. Prove each refusal returns its typed code and
leaves **no** row behind, and that each edge that should work does work.

## Critical Rules

1. Assert status, `errorCode` (allocate routes) or `code` (other routes), and the
   rows. A 400 that still wrote an occurrence is a failure.
2. Allocation is `PATCH /api/bookings/{consultations|subscriptions|webinars|classes}/<id>/allocate`
   with body `{ isAuto, slots?, ... }`; manual mode needs `slots` as ISO strings,
   each one a 30-minute atom start.
3. A refusal must not leak the other party's identity.

---

## Phase 0 — Data seeding

Create with the `-014` suffix: consultant A `testconsultant014a@…` (profile
`test-consultant-profile-014a`, `WEEKLY`, Mon–Fri 09:30–17:00 IST: UTC 240–690),
consultant B `testconsultant014b@…` (any availability), consultee
`testconsultee014@…`, an admin session for the staff checks, a 0.5 h plan
`test-consultation-plan-014` (₹1,000) and a **1 h** plan
`test-consultation-plan-014-1h` (₹2,000), both on consultant A. Seed every weekly
row with its local columns. Pin `D` to the coming **Monday**.

As the consultee, create two `PENDING` requests on the 0.5 h plan with
`POST /api/scheduling/request-for-approval`, one for `D+7` 04:30Z and one for
`D+8` 04:30Z (each holds a tentative occurrence). Record `<REQUEST_1>` and
`<REQUEST_2>` (the consultation ids). An allocation by the expert approves a
`PENDING` request and fixes its times in one step, which is exactly why only the
host side may call it.

---

## Phase 1 — The consultee cannot allocate

As the **consultee** on `<REQUEST_1>`:

```javascript
async () => {
  const r = await fetch("/api/bookings/consultations/<REQUEST_1>/allocate", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isAuto: false, slots: ["<D+7T04:30Z>"] }),
  });
  return { status: r.status, body: await r.json() };
};
```

**Expected:** `403`, `errorCode: "ALLOCATE_FORBIDDEN"`.

```sql
SELECT c.status, COUNT(o.id) AS occurrences
FROM "Consultation" c
JOIN "Appointment" a ON a."consultationId" = c.id
LEFT JOIN "AppointmentOccurrence" o ON o."appointmentId" = a.id AND o."deletedAt" IS NULL
WHERE c.id = '<REQUEST_1>' GROUP BY c.status;
-- Expected: status still PENDING (a consultee must not be able to approve their own
-- request) and occurrences = 1, the original tentative hold
```

## Phase 2 — Other experts and staff

1. As **consultant B** (not the plan's expert): `403`; no occurrence change.
2. As **ADMIN/STAFF** on `<REQUEST_1>` with `override: true` and a time outside A's
   hours (`D+7` `12:00Z`): **Expected** `200` (staff may waive availability). Cancel
   the booking afterwards through the cancel route.

## Phase 3 — Window edges

Consultant A's Monday row covers `04:00Z`–`11:30Z`. Against `<REQUEST_2>` (still
`PENDING`), send these manual allocations on `D+8` in this order. The refusals
write nothing, so the request stays `PENDING` after each:

| Slot start (UTC) | Meaning                                    | Expected                                   |
| ---------------- | ------------------------------------------ | ------------------------------------------ |
| `11:30Z`         | first atom past the end of the row         | `400`, `errorCode: "OUTSIDE_AVAILABILITY"` |
| `03:30Z`         | last atom before the start                 | `400`, `OUTSIDE_AVAILABILITY`              |
| `11:00Z`         | last atom (ends exactly at the row end)    | `200`, one occurrence at `11:00Z`          |

Cancel that booking, create a third request, and allocate `04:00Z` (the first
atom): **Expected** `200`. Then, with the expert's own session, retry an
out-of-hours time with `override: true`: **Expected** `200` (the plan's expert may
accept a time outside their own hours). Cancel it.

## Phase 4 — An overnight row keeps its tail

Give consultant A a second, overnight weekly row in **UTC** (offset 0, timezone
`UTC`): Monday 23:00 to Tuesday 01:00 (`startTimeUtc` 1380, `endTimeUtc` 60, local
columns identical). Allocate Tuesday `00:30Z` (the tail). **Expected:** `200`.
Allocate Tuesday `01:00Z`. **Expected:** `400 OUTSIDE_AVAILABILITY`. Delete the
overnight row at the end.

## Phase 5 — A window is sold at the plan's length

As the consultee, with the **1 h** plan, request a 2-hour window:

```javascript
async () => {
  const r = await fetch("/api/scheduling/request-for-approval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consultantProfileId: "test-consultant-profile-014a",
      consultationPlanId: "test-consultation-plan-014-1h",
      availabilityWindowWeeklyId: "<WEEKLY_ROW_ID>",
      startsAt: "<D+7T05:00Z>",
      endsAt: "<D+7T07:00Z>",
    }),
  });
  return { status: r.status, body: await r.json() };
};
```

**Expected:** `400`, `code: "WINDOW_DURATION_MISMATCH"`, message "The selected time
must match the plan length (...)". The same window sent through `POST /api/checkout`
(mock payment) answers the same code; **no** `Payment` and **no** occurrence is
created. A 1-hour window (`05:00Z`–`06:00Z`) succeeds.

## Phase 6 — A paused expert takes nothing new

```sql
UPDATE "ConsultantProfile" SET "acceptingRequests" = false
WHERE id = 'test-consultant-profile-014a';
```

1. `POST /api/scheduling/request-for-approval`: `409`, `code: "CONSULTANT_PAUSED"`.
2. `POST /api/checkout` (mock payment) for a free slot: `409` with
   `NOT_ACCEPTING_BOOKINGS`; no `Payment` row.
3. `POST /api/trials`: `409` with `NOT_ACCEPTING_BOOKINGS`.
4. A booking that already exists is unaffected: cancel or view it normally.

Restore `acceptingRequests = true` before Phase 7.

## Phase 7 — Cleanup

Cancel remaining bookings through the cancel route, delete QA rows in the order in
the shared setup, remove the overnight row, and restore `acceptingRequests`.

## Pass/fail table

| #   | Check                                | Expected                                   |
| --- | ------------------------------------ | ------------------------------------------ |
| 1   | Consultee allocates                  | 403 `ALLOCATE_FORBIDDEN`, still PENDING    |
| 2   | Wrong expert / staff with override   | 403 / 200                                  |
| 3   | Atoms just past each edge / first and last atom | 400, 400 / 200, 200          |
| 4   | Overnight tail                       | 00:30Z ok, 01:00Z 400                      |
| 5   | 2 h window on a 1 h plan             | 400 `WINDOW_DURATION_MISMATCH`, no rows    |
| 6   | Paused expert                        | 409 on request, checkout, trial            |
