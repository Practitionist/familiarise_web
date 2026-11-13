# 05 · Webinars (`WE-`)

One-session group events: finding the editor, the host time picker (`SingleTimePicker`, host audience) and the event-time rules, drafts and "Schedule now", free and paid seats, capacity and the waitlist, the sold-event rule (re-time, never re-plan), leaving and cancelling, co-hosts and completion.

Read `../README.md` and `../_shared/*.md` first.

## Files

| File | Cases | Count | Needs |
| --- | --- | --- | --- |
| [`01-find-create-and-picker.md`](01-find-create-and-picker.md) | WE-01 – WE-14 | 14 | F-AV2, F-AV4, a confirmed H2 session |
| [`02-drafts-seats-waitlist.md`](02-drafts-seats-waitlist.md) | WE-15 – WE-28 | 14 | `qa-WE-05`, F-PL2 free webinar; `[local]` |
| [`03-sold-retime.md`](03-sold-retime.md) | WE-29 – WE-41 | 13 | `qa-WE-05` with 2 seats; clock shifts; `[local]` |
| [`04-cancel-cohost-completion.md`](04-cancel-cohost-completion.md) | WE-42 – WE-55 | 14 | paid seats, H3, `[local]`, `[sweep]` |

Total: 55 cases.

## Fixtures and personas

- **Host:** H2 (IST, F-AV2: Mon/Wed/Fri 18:00–21:00, Tue/Thu 07:00–09:00). H3 (America/New_York) is the co-host; H4 (Asia/Kathmandu) tests the :15/:45 lattice; OH for the org catalog door.
- **Buyers:** B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), DR (Australia/Sydney), B4 (IST). Five buyers is exactly F-PL2's capacity; `qa-WE-21` uses capacity 2 to reach sold out cheaply.
- **Webinars created here:** `qa-WE-05` (90 min, ₹500, capacity 5) is the main sold webinar for 02–04; `qa-WE-06` (unsold) for the Timings and edit cases; `qa-WE-21` (capacity 2) for sold out and the waitlist.
- **Busy fixtures:** the cases need one confirmed H2 1:1 session (B2's `qa-SU-14` subscription session from 04) or F-PL2's class series. If neither exists, create a free H2 webinar at a known time and use that.

## Run order

`01` → `02` → `03` → `04`. Run 05 after 04 (it reuses 04's H2 sessions as busy blocks) and before 06 (06 references the picker label rules in WE-02 to WE-04).

## What this folder does not cover

Class make-ups and pattern rows (06 `CL-`, which references WE-02–WE-04 for picker labels), refund arithmetic in depth (08 `MO-`), last-seat and re-time races (09 `CC-`), DST across a re-time (10 `TZ-`), notification matrices (11 `DB-`), the abandoned-hold and completion sweeps in depth (12 `SW-`), the copy and a11y sweep (13 `UX-`).

## Salvaged from the old suite

- `e2e-booking-agent-003` Test 2.2 ("re-auto-allocate an allocated webinar is refused") → WE-31, now the sold-event `USE_RETIME` rule; Test 4.1 (a webinar longer than any window) no longer applies: a host may run a webinar outside published hours (WE-06).
- `e2e-booking-agent-012` Phase 6 (co-host guard in every mode) → WE-51 and WE-52; Phase 7 (overlap on create is a 409, not a 500) → WE-12.
