# 10-timezones-dst-locale (TZ-)

Every booking type with the parties in different zones, the 2027 daylight-saving changes (US, UK, Australia), off-grid offsets (Kathmandu), overnight windows and day boundaries, browser zone vs profile zone on every non-grid surface, zone changes in the middle of a plan, and how times, money and plurals are written in the UI, the bell, emails and calendar files.

| File | Cases | Count | What |
| --- | --- | --- | --- |
| [01-cross-zone-odd-offsets-overnight.md](01-cross-zone-odd-offsets-overnight.md) | TZ-01 – TZ-19 | 19 | Zone fixtures (H3 and H4 plans); IST host × London, LA, Sydney buyers; New York host × IST buyer; Kathmandu host × LA buyer; reschedule and cancel read in two zones; one-a-day cap counted on the host's day; plan-week edges from another zone; events in four zones; org pages fixed to IST; operator pages with no zone; Kathmandu buyer; Kathmandu convert refusal; overnight window across the host's midnight; "today" across zones; UTC-midnight slots; restore |
| [02-dst-transitions.md](02-dst-transitions.md) | TZ-20 – TZ-33 | 14 | New York window across 2027-03-14; the 46-row Sunday and a skipped row; fall-back "(2nd)" rows for London and Sydney viewers; booking across the change and the frozen-offset hour; allocator agreement; a 167-hour plan week; a class across the US and UK changes; a webinar on the change night; a nonexistent typed time; an ambiguous "2:30 am"; a 24-h deadline that reads 25 h; the zone line's stale offset; NULL local columns; restore |
| [03-browser-zone-notifications-locale.md](03-browser-zone-notifications-locale.md) | TZ-34 – TZ-52 | 19 | Browser-vs-profile matrix; consultation checkout; subscription start and first cycle; pay page and trial checkout; calendar view and lapsed-link row; editor validation; quiet hours; buyer and host zone changes mid-plan; bell rows per zone; email labels; payment-link email; `.ics`; date formats; money formats; plurals; 12/24 h; relative time; restore |

Total: 52 cases.

## Fixtures and personas

- **From 01:** F-AV1, F-AV3 (H3 weekly, New York), F-AV4 (H4 custom, Kathmandu), F-PL1 (S-08, S-09, S-11), F-PL2 (H2 webinars), F-BUSY.
- **Created here:** TZ-01 makes `qa-TZ-01a` (H3 consultation, 60 min, ₹500), `qa-TZ-01b` (H3 subscription, 8 weeks × 2/week × 60 min) and `qa-TZ-01c` (H4 consultation, 30 min, free). TZ-26 makes a 16-session H3 class; TZ-27 to TZ-30 make webinars in March and April 2027.
- **Temporary changes, always restored:** B4's zone (TZ-14), H3's zone (TZ-15, TZ-42), OS's zone (TZ-12), B2's zone (TZ-41), H3's weekly rows (TZ-16 overnight row, TZ-21 Sunday row), quiet hours (TZ-40). TZ-19, TZ-33 and TZ-52 restore their files.
- **Owner-approved writes:** TZ-24 shifts a subscription's start into March 2027 (checkout allows 90 days); TZ-32 inserts and deletes a broken weekly row (optional); TZ-17 and TZ-38 may shift one time each.

## Run order

`01` → `02` → `03`. Within `01`, TZ-01 first. TZ-08 cancels TZ-03's booking, so run TZ-17 before TZ-08 or rebook. TZ-45 needs H1 in "Review requests first" mode: run it while 03-c has that mode on, or flip and restore it yourself (CO-45). Group by persona to stay under the sign-in limit; the cases name a persona per step.

## Environment

Previews run the free and display cases. Paid bookings and seats are `[local]`. Reminder and nudge jobs are NEEDS-OWNER-RUN off production (`send-appointment-reminders`, the week-nudge job). Browser-zone cases need the DevTools `emulate` tool to override the time zone; without it they are BLOCKED (no zone emulation) and you still run the profile-zone half.

## What this folder does not cover

Grid zone rendering and the zone switch on grids (02 `HM-28`, `HM-29`, `HM-52`), the class editor's browser-zone start date (06 `CL-02`), the class DST host view (06 `CL-04`), Kathmandu in the pattern scheduler and webinar picker (06 `CL-17`, 05 `WE-09`), Kathmandu feasibility (04 `SU-15`), cross-zone plan weeks at checkout (04 `SU-25`), the reschedule deadline maths (03 `CO-68`), notification matrices by event and role (11 `DB-`), the copy sweep (13 `UX-`).

## Salvaged from the old suite

| Old | New |
| --- | --- |
| `e2e-booking-agent-015` Phase 1 (Monday window moves with the offset) | TZ-20 (2027 spring change) |
| 015 Phase 2 (fall-back night, 6 atoms) | TZ-22 (display of repeated rows; the 2026-11-01 night has passed) |
| 015 Phase 3 (booking across the change, frozen-offset time refused) | TZ-23 |
| 015 Phase 4 (allocator agrees with the grid) | TZ-24 |
| 015 Phase 5 (spring-forward gap skips the date) | TZ-21 |
| 015 Phase 6 (NULL local columns refused) | TZ-32 |
| `e2e-booking-agent-005` Phase 5 (overnight checkout guard, Tests 5.1–5.3) | TZ-16 |
| 005 Phases 2–4, 7 (overnight CRUD and overlap) | already in 02 (`HM-01`, `HM-02`, `HM-07`) |
| 005 Phase 8 (class session after the scheduling period) | not salvaged: classes no longer have a scheduling period end in that sense (06 owns class series) |

## Things found while writing this folder (report them, don't assume)

- `ZoneSwitch` names the offset in force **now**, not for the week on screen (TZ-31).
- Several non-grid surfaces format in the browser or server zone: consultation checkout (TZ-35), subscription start and cycle (TZ-36), the calendar view (TZ-38), the lapsed-link row (server, TZ-38), `limitBucketNote` (TZ-09), quiet hours default (TZ-40), the payment-link email (server zone, TZ-45).
- The payment-link email promises "24 hours after approval" even when the link is clamped to start − 15 min (TZ-45).
- `.ics` files have no `SEQUENCE`; the consultant has no calendar export (TZ-46).
- R-06's plan-week SQL buckets by 7 × 24 h from the purchase instant; the product uses host-zone days (TZ-10, TZ-25).
