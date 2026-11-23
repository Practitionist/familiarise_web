# Booking QA suite

Exhaustive, agent-run QA (822 cases) for everything that books time on Familiarise: consultations, subscriptions, webinars, classes and trials, from availability and the heat map through checkout, allocation, rescheduling, cancelling, refunds, background sweeps and every dashboard that reports them.

Agents drive the product with the **Chrome DevTools MCP** (one browser instance, one tab) and read and seed data with the **Supabase MCP** (writes need owner approval). They report every outcome and every inconsistency, false statement, AI-slop copy, console or network error and missed chance to tell the user something useful. Developers fix from the report.

This suite replaces `prompts/booking-algorithm-tests/` (agents 001–020), which described flows that no longer exist. Its still-valid hard cases (webhook disorder, abandoned sweep, refund owed, gateway failures, maintenance freeze, org scope and sponsor allocation, DST, duplicate submits, caps, returning a session, expert strikes) live on in the folders below.

## Read before running anything

1. [`_shared/00-read-first.md`](_shared/00-read-first.md) — safety (shared database), Supabase CRUD with approval, browser lock, tools, run discipline.
2. [`_shared/personas-and-fixtures.md`](_shared/personas-and-fixtures.md) — personas and their time zones, the dashboards to cross-check, base fixtures, clock control.
3. [`_shared/reporting.md`](_shared/reporting.md) — verdicts, finding types, severity, evidence, the per-case block and the final report.
4. [`_shared/sql-recipes.md`](_shared/sql-recipes.md) — ids, booking graph, money, overlap invariant, plan math, idempotency, cleanup.
5. [`_shared/case-template.md`](_shared/case-template.md) — the shape of every case.

## Folders

| Folder | Cases | Covers |
| --- | --- | --- |
| [`01-setup-and-smoke/`](01-setup-and-smoke/) | `S-01`–`S-25` (25) | Persona ids, base fixtures (availability, plans, busy block), smoke of every dashboard. Run first. |
| [`02-availability-and-heatmap/`](02-availability-and-heatmap/) | `HM-01`–`HM-52` (52) | Weekly and custom availability, the heat-map grid (states, hover preview, whole-session picks, tray, context chips, month "N fit", open hours/full day), keyboard use. |
| [`03-consultations/`](03-consultations/) | `CO-01`–`CO-93` (93) | Instant booking, request/approval (use requested, manual, auto), pay links and pre-allocation, decline, expiry, reschedule both sides, caps, cancel tiers, expert cancel, parked sessions, rebook, free consultations. |
| [`04-subscriptions/`](04-subscriptions/) | `SU-01`–`SU-85` (85) | Plan editor and feasibility, checkout room hint, allocation (manual/auto, partial), plan-week rules, reschedule, return a session, cancel and prorate, plan end, renewal. |
| [`05-webinars/`](05-webinars/) | `WE-01`–`WE-55` (55) | Create and publish, host time picker, seats and waitlist, buy, re-time a sold webinar, cancel by host and by buyer, completion. |
| [`06-classes/`](06-classes/) | `CL-01`–`CL-74` (74) | Weekly-pattern scheduler, series generation, "Schedule now", sold-class series move, per-session cancel, make-up, late join, never-placed refunds at completion. |
| [`07-trials/`](07-trials/) | `TR-01`–`TR-41` (41) | Free and paid trials, buyer-picked time, tentative hold and capture, reschedule once per side, expert cancel strike, capture after start, convert to subscription. |
| [`08-money-refunds-payments/`](08-money-refunds-payments/) | `MO-01`–`MO-73` (73) | Checkout front doors, mock pay, cancel quotes and tiers, refund rows, credit notes, earnings and holds, refund owed, gateway failures, org rails, free credits. |
| [`09-concurrency-integrity/`](09-concurrency-integrity/) | `CC-01`–`CC-70` (70) | Races, duplicate submits, idempotency replay, two devices, stale clients, lock loss, illegal transitions, authz by URL, overlap invariant. |
| [`10-timezones-dst-locale/`](10-timezones-dst-locale/) | `TZ-01`–`TZ-52` (52) | Cross-zone parties, DST transitions (US, UK, Australia), odd offsets (Kathmandu), browser vs profile zone, overnight windows, locale formatting. |
| [`11-dashboards-roles-notifications/`](11-dashboards-roles-notifications/) | `DB-01`–`DB-63` (63) | Consultant, consultee, org (sponsor/host), staff and admin views of the same booking; dual role; bell notifications and emails; maintenance mode. |
| [`12-sweeps-background-jobs/`](12-sweeps-background-jobs/) | `SW-01`–`SW-39` (39) | Hold expiry, abandoned checkout, request expiry, reschedule expiry, parked escalation, auto-cancel, class end, plan end, refund-owed retry. Mostly NEEDS-OWNER-RUN on previews. |
| [`13-copy-a11y-responsive/`](13-copy-a11y-responsive/) | `UX-01`–`UX-100` (100) | Error-code copy, AI-slop sweep, missed opportunities, keyboard and screen-reader paths, contrast, four viewports. |

## Run order

1. `01` once per environment (it creates the fixtures everyone else uses).
2. `02` → `03` → `04` → `07` (1:1 host H1), then `05` → `06` (group host H2). Within a persona, run cases in file order to save sign-ins.
3. `08` and `09` after the journeys they build on.
4. `10`, `11`, `13` can run any time after `01`; they reuse bookings left by earlier folders where the case says so.
5. `12` last (sweep preconditions shift clocks).

## Running several agents

- Only one agent drives the browser at a time (the `/tmp/fw-browser.lock` lock in `00-read-first.md`). Others do SQL reads while they wait.
- At most two QA agents run at once. Give each a disjoint set of folders and a disjoint pair of buyer personas so their fixtures don't collide. That is not enough when a case changes shared host state (H1 or H2 availability, booking mode, the request cap, pause): two agents never use the same host at once, so split the work by host (H1's folders vs H2's, per the run order above) or run those cases serially.
- Each agent writes one report file, `temp/qa-reports/booking-qa-<folder>-<date>.md`, using [`_shared/reporting.md`](_shared/reporting.md). The coordinator merges them and posts one PR comment per round.

## Environments

- **Local `next dev`** (owner runs it): the only place mock payments complete. Run `[local]` cases here.
- **Deploy preview** (`https://deploy-preview-<N>--familiarise.netlify.app`): everything except captures, webhooks and job runs. Those cases are BLOCKED or NEEDS-OWNER-RUN there.
- **Production**: never run this suite against production.

## Keeping the suite current

When a booking behaviour changes, update the case that covers it in the same PR, and update `docs/booking/` and `.claude/skills/booking/`. A case that describes removed behaviour is deleted, not left to fail.
