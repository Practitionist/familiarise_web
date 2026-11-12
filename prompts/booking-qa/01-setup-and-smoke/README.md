# 01-setup-and-smoke (S-)

Run this folder first, once per environment. It records persona ids, builds every base fixture through the UI and smokes every dashboard route. Later folders assume its fixtures exist and name them (F-AV1…, F-PL1…, F-BUSY).

| File | Cases | What |
| --- | --- | --- |
| [01-personas-and-availability.md](01-personas-and-availability.md) | S-01 – S-07 | R-01 ids and zones, F-AV1–F-AV4 through the availability editor, editor refusals, H1's booking mode switch |
| [02-plans-and-busy-block.md](02-plans-and-busy-block.md) | S-08 – S-17 | F-PL1 (H1 plans), feasibility signals at creation, F-PL2 (H2 webinars and classes), F-PL3 (OX org-hosted), F-BUSY |
| [03-dashboard-smoke.md](03-dashboard-smoke.md) | S-18 – S-25 | Every consultant, consultee, org, staff and admin route for each persona; wrong-persona URLs |

**Run order:** S-01 → S-07 (availability first), S-08 → S-16 (plans), S-17 (needs local mock pay), then S-18 → S-25. Group the smoke cases by persona to stay under the sign-in limit.

**Environment:** everything runs on a preview except S-17 (`[local]`). Without S-17 there's no busy block; 02 and 03 cases that need it are BLOCKED.

**Fixture changes found while writing this folder** (report them as DOC-DRIFT against `_shared/personas-and-fixtures.md` §3 and tell the coordinator):

1. **F-AV4** can't be weekly: the server refuses weekly hours in `Asia/Kathmandu` with code `ZONE` (`weeklyZoneRefusal` in `lib/scheduling/availability-contract.ts`). S-05 makes H4 a **custom** schedule: D…D+5, 10:15–12:15 NPT (04:30Z–06:30Z).
2. **F-PL1 request-mode consultation:** 45 min is off the 30-minute grid, and request/approval is an expert-wide switch (`ConsultantProfile.bookingMode`, Settings → Booking "Review requests first"), not a plan field. S-10 creates a 90-min ₹750 consultation; 03 flips H1's mode around its request cases.
3. **F-PL1 months plan:** the editor creates weeks plans only. S-12 creates the months plan through `POST /api/plans/subscriptions` (`durationInWeeks: null`).
4. **F-PL3:** no UI creates an org-hosted consultation plan. S-16 needs one owner-approved `UPDATE` unless a seeded plan exists, and adds **F-AV5** (OX availability) if OX has none.
5. Staff routes are `/dashboard/staff/…` and `/dashboard/admin/…` (literal tree segment), not `/dashboard/staff/[staffProfileId]/…`.

**D:** the next Monday at least 3 days away, in IST. Write it at the top of the report; every folder books relative to it.
