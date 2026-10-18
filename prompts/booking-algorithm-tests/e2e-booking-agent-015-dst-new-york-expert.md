# E2E Booking Algorithm Test — Agent 015: A New York Expert Across the 2026-11-01 DST Change

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Read first:** [`wave0-shared-setup.md`](./wave0-shared-setup.md)

> **Coverage marker:** a weekly availability row means a **local wall-clock
> window in its own IANA zone**. Every reader (the grid, checkout coverage, the
> allocator, the validator) projects it per date through the zone's rules. This
> case proves the instants move with daylight saving while the wall clock stays
> put, and that a time the old frozen offset would have allowed is now refused.
> Fixture suffix `-015`. The reference is `docs/booking/19-dst-and-timezone-posture.md`.

You are a senior QA engineer. The numbers below were produced by the projection
function itself (`weeklyRowIntervalsInRange`), so compare them exactly.

> The dates assume US daylight saving ends on **Sunday 2026-11-01**. If you run
> this after that date, redo the table for the next transition: the US change is
> the first Sunday of November (offset `-04:00` to `-05:00`) and the spring change
> is the second Sunday of March (2027-03-14). The method is identical.

## Critical Rules

1. Compare instants in **UTC** and the viewer's wall clock separately. A pass on
   one and a fail on the other is a failure.
2. Never trust the stored UTC columns for these rows; nothing projects through
   them. If a result matches only the UTC columns, that is a bug.
3. A weekly row with NULL local columns must be refused, not guessed (Phase 6).

---

## Phase 0 — Data seeding

Create consultant `testconsultant015@familiarise.com` whose **user timezone is
`America/New_York`** (profile `test-consultant-profile-015`, `scheduleType`
`WEEKLY`), consultee `testconsultee015@…`, a published 0.5 h plan
`test-consultation-plan-015` (₹1,000) and a 1 h plan
`test-consultation-plan-015-1h` (₹2,000). Seed two weekly rows (all five local
columns plus the UTC columns, written as the editor would: UTC = local minus the
offset on 1970-01-01, which was `-05:00`, so `utcOffsetMinutes = -300`):

| Row id             | timezone           | local start      | local end        | startTimeUtc / endTimeUtc |
| ------------------ | ------------------ | ---------------- | ---------------- | ------------------------- |
| `test-w015-mon`    | `America/New_York` | MONDAY 540 (09:00) | MONDAY 720 (12:00) | 840 / 1020 (MONDAY)     |
| `test-w015-sun`    | `America/New_York` | SUNDAY 60 (01:00)  | SUNDAY 180 (03:00) | 360 / 480 (SUNDAY)      |

## Phase 1 — The Monday window moves with the offset

Read the public grid for each Monday, with the viewer in New York:

```
GET /api/scheduling/availability-with-allocation/test-consultant-profile-015
    ?startDateInUtc=2026-10-26T00:00:00Z&endDateInUtc=2026-10-27T12:00:00Z&timezone=America/New_York
```

and again for `2026-11-02T00:00:00Z` to `2026-11-03T12:00:00Z`.

**Expected** (six 30-minute atoms each; assert the `startsAt` values of the
available slots):

| Monday     | Offset   | First atom (UTC)       | Last atom (UTC)        | Wall clock for a New York viewer |
| ---------- | -------- | ---------------------- | ---------------------- | -------------------------------- |
| 2026-10-26 | `-04:00` | `2026-10-26T13:00:00Z` | `2026-10-26T15:30:00Z` | 09:00 to 12:00                   |
| 2026-11-02 | `-05:00` | `2026-11-02T14:00:00Z` | `2026-11-02T16:30:00Z` | 09:00 to 12:00                   |

Repeat the 2026-11-02 read with `timezone=Asia/Kolkata`. **Expected:** the same
instants, which an Indian viewer sees as 19:30 to 22:30 IST (the week before they
were 18:30 to 21:30 IST).

## Phase 2 — The transition night itself

Read the Sundays `2026-10-25`, `2026-11-01` and `2026-11-08`. The Sunday row is
wall-clock 01:00 to 03:00 and the clocks fall back at 02:00 EDT on 2026-11-01.

| Sunday     | Interval (UTC)                              | Atoms | Why                                                      |
| ---------- | ------------------------------------------- | ----- | -------------------------------------------------------- |
| 2026-10-25 | `05:00Z` to `07:00Z`                        | 4     | ordinary day, EDT                                        |
| 2026-11-01 | `05:00Z` to `08:00Z`                        | 6     | 01:00 occurs twice; the first one wins, so three real hours |
| 2026-11-08 | `06:00Z` to `08:00Z`                        | 4     | ordinary day, EST                                        |

**Expected:** the grid shows 6 atoms on 2026-11-01 (a 2-hour wall-clock row is
3 real hours that night), starting at `05:00Z`. A 1-hour booking at `05:30Z` to
`06:30Z` on that Sunday crosses from the first 01:30 into the repeated hour and
must be accepted; so must `06:00Z` to `07:00Z`, the repeated hour itself.

## Phase 3 — Booking across the change

As the consultee, book with `POST /api/checkout` (`isMockPayment: true`, a new
`clientIdempotencyKey` each time; the body is Agent 009 Phase 1's, with this
case's plan and `slotOfAvailabilityWeeklyId: test-w015-mon`):

1. Monday 2026-10-26 `13:00Z` to `13:30Z`. **Expected:** `200`; the occurrence has
   `startsAt = 2026-10-26T13:00:00Z`.
2. Monday 2026-11-02 `14:00Z` to `14:30Z`. **Expected:** `200`.
3. Monday 2026-11-02 `13:00Z` to `13:30Z` — the time the **old frozen offset** would
   have published. In New York that is 08:00 EST, before the window opens.
   **Expected:** refused (the availability family, no card charge) and **no**
   `Payment` and **no** occurrence for that time.

```sql
SELECT o."startsAt" FROM "AppointmentOccurrence" o
JOIN "Appointment" a ON a.id = o."appointmentId"
JOIN "Consultation" c ON c.id = a."consultationId"
WHERE c."consultationPlanId" = 'test-consultation-plan-015' AND o."deletedAt" IS NULL
ORDER BY o."startsAt";
-- Expected: exactly 2026-10-26 13:00Z and 2026-11-02 14:00Z
```

## Phase 4 — The allocator agrees with the grid

Create a `PENDING` request on the 1 h plan (`POST /api/scheduling/request-for-approval`)
for Monday `2026-11-02` `14:00Z` to `15:00Z`, then as the expert allocate manually
with `slots: ["2026-11-02T14:00:00Z","2026-11-02T14:30:00Z"]`. **Expected:** `200`.
Allocate a second request at `13:00Z`: **Expected** `400`, `OUTSIDE_AVAILABILITY`.

## Phase 5 — A spring-forward gap skips the date

Add a row `test-w015-gap`: SUNDAY 120 (02:00) to 240 (04:00), `America/New_York`.
Read the grid for the week of **2027-03-14**. On that date 02:00 does not exist
(clocks jump to 03:00). **Expected:** that Sunday shows **no** atoms for the row
(the date is skipped, never shifted to 03:30), while 2027-03-07 shows `07:00Z` to
`09:00Z` and 2027-03-21 shows `06:00Z` to `08:00Z`. Delete the row.

## Phase 6 — A row without local columns is refused

Insert `test-w015-null` with the UTC columns only (all `local*` and `timezone`
NULL), Tuesday 14:00 to 17:00 UTC. **Expected:** the grid shows nothing for it;
the Netlify function log carries one report per call for the incomplete row (the
event is throttled, so do not expect one per request). No checkout can book it.
Delete the row.

## Phase 7 — Cleanup

Cancel the bookings through the cancel route, delete QA rows in the order in the
shared setup, and delete rows `test-w015-*`.

## Pass/fail table

| #   | Check                                    | Expected                                  |
| --- | ---------------------------------------- | ----------------------------------------- |
| 1   | Monday 09:00 New York                    | `13:00Z` before, `14:00Z` after           |
| 2   | Fall-back Sunday                         | 6 atoms, `05:00Z` to `08:00Z`             |
| 3   | Old frozen-offset time after the change  | refused, no rows                          |
| 4   | Allocator and grid agree                 | `14:00Z` ok, `13:00Z` `OUTSIDE_AVAILABILITY` |
| 5   | Spring-forward gap                       | date skipped, neighbours normal           |
| 6   | NULL local columns                       | refused, reported once per call           |
