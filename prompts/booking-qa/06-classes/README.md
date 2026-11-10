# 06 · Classes (`CL-`)

Recurring group events: the class editor and its start-date series, drafts and "Schedule now", the weekly-pattern scheduler (Manage timings' default view) and the calendar view with auto-schedule, enrolling and late join, the sold-event rule (a sold class moves only as a series), cancelling one session with its make-up or skip, the learners' exit right, whole-class cancel, completion and class-end refunds.

Read `../README.md` and `../_shared/*.md` first. Picker label rules (Free / Outside your hours / Busy / Too soon) are owned by 05 (WE-02 to WE-04); cases here test only what is class-specific.

## Files

| File | Cases | Count | Needs |
| --- | --- | --- | --- |
| [`01-editor-series-and-draft.md`](01-editor-series-and-draft.md) | CL-01 – CL-12 | 12 | F-AV2, F-AV3, F-AV4, F-PL2 |
| [`02-pattern-scheduler-and-calendar.md`](02-pattern-scheduler-and-calendar.md) | CL-13 – CL-26 | 14 | unscheduled classes, a confirmed H2 session, H3 co-host |
| [`03-purchase-latejoin-leave.md`](03-purchase-latejoin-leave.md) | CL-27 – CL-37 | 11 | `qa-CL-01` (8 sessions, cutoff 3); `[local]`; clock shifts |
| [`04-sold-series-move.md`](04-sold-series-move.md) | CL-38 – CL-50 | 13 | sold `qa-CL-38`; `[local]`; clock shifts; `[two-browser]` |
| [`05-session-cancel-makeup-exit.md`](05-session-cancel-makeup-exit.md) | CL-51 – CL-62 | 12 | sold `qa-CL-51` (16 sessions); `[local]`; `[sweep]` |
| [`06-cancel-completion-refunds.md`](06-cancel-completion-refunds.md) | CL-63 – CL-74 | 12 | sold classes; `[local]`; `[sweep]` |

Total: 74 cases.

## Fixtures and personas

- **Host:** H2 (IST, F-AV2: Mon/Wed/Fri 18:00–21:00, Tue/Thu 07:00–09:00). H3 (America/New_York) for the DST series and as co-instructor; H4 (Asia/Kathmandu) for the :45 zone; OH/OX for the org catalog class.
- **Learners:** B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), B4 (IST, used as the late joiner), DR (Australia/Sydney).
- **Classes created here:** `qa-CL-01` (8 sessions, ₹1,000, capacity 5, cutoff 3) for enrolment and late join; `qa-CL-08`/`qa-CL-13` (unscheduled) for the scheduler; `qa-CL-38` (sold) for the series move; `qa-CL-51` (16 sessions, ₹1,600) for cancels, make-ups and the exit right; fresh sold classes for CL-63 to CL-73.
- **Busy fixtures:** one confirmed H2 session in the next 4 weeks (B2's `qa-SU-14` subscription session from 04, or a webinar from 05).

## Run order

`01` → `02` → `03` (inside it: CL-27–30, CL-34–37, then CL-31–33) → `04` → `05` → `06`. Run after 05; 06 reuses 05's picker rules and H3's co-host setup.

## What this folder does not cover

Picker label semantics (05 `WE-`), refund arithmetic in depth and GST (08 `MO-`), races on seats and series moves (09 `CC-`), DST matrices beyond CL-04 (10 `TZ-`), notification matrices and the back-office class doors (11 `DB-`), sweep batching and retries (12 `SW-`), the copy and a11y sweep (13 `UX-`).

## Salvaged from the old suite

- `e2e-booking-agent-003` Test 3.1/3.2 (auto-allocate a class within the weekly cap) → CL-21 (now spaced-first, one a day, then two a day); Test 4.2 (period too tight) → CL-22 (now a partial schedule that blocks enrolment).
- `e2e-booking-agent-012` Phase 6 (co-host guard in every allocation mode) → CL-23, CL-48, CL-57; Phase 7 (overlap on class creation is a 409) → CL-18.
