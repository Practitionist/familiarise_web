# Personas, dashboards, time zones and base fixtures

Passwords: non-operator seed users share the seed default password in `prisma/seedFiles/1a-create-users.ts` (ask the coordinator for `SEED_PASSWORD`). STAFF and ADMIN QA operators use `SEED_OPERATOR_PASSWORD` and need no TOTP on previews or local development. Full roster: `docs/team/mock-credentials.md`.

## 1. Personas

| Alias | Account | Role and use | Profile time zone for the suite |
| --- | --- | --- | --- |
| **H1** | `hannah.anderson@yahoo.com` | Independent consultant. Main 1:1 host: consultations, subscriptions, trials | `Asia/Kolkata` (UTC+05:30) |
| **H2** | `grace.anderson@outlook.com` | Independent consultant. Group host: webinars, classes | `Asia/Kolkata` |
| **H3** | `james.anderson@protonmail.com` | Independent consultant. Co-host, busy-host conflicts, DST host | `America/New_York` (DST) |
| **H4** | `ethan.anderson@gmail.com` | Spare consultant. Odd-offset zone | `Asia/Kathmandu` (UTC+05:45) |
| **B1** | `charlotte.brown@protonmail.com` | Consultee. Main buyer | `Asia/Kolkata` |
| **B2** | `daniel.brown@gmail.com` | Consultee. Second buyer (races, seats) | `Europe/London` (DST) |
| **B3** | `david.brown@outlook.com` | Consultee. Third buyer, fills seats, creates "Busy" blocks | `America/Los_Angeles` (DST) |
| **B4** | `patrick.anderson@outlook.com` | Wipro LEARNER, plain consultee | `Asia/Kolkata` |
| **DR** | `olivia.anderson@gmail.com` | Wipro LEARNER, also used for dual-role gates (verify roles by SQL first) | `Australia/Sydney` (southern DST) |
| **OS** | `samantha.anderson@yahoo.com` | OWNER of Wipro (SPONSOR org): sponsor allocation, org spend | `Asia/Kolkata` |
| **OH** | `daniel.anderson@outlook.com` | OWNER of LearnPro Academy (HOST org): org-hosted experts, org earnings | `Asia/Kolkata` |
| **OX** | `aarav.anderson@gmail.com` | EXPERT in LearnPro Academy (payout SELF): org-hosted offering | `Asia/Kolkata` |
| **ST** | `qa-staff-1@qa.familiarise.invalid` | STAFF: back office, refunds console, parked sessions | — |
| **AD** | `qa-admin-2@qa.familiarise.invalid` | ADMIN: maintenance mode, system jobs page (read), analytics | — |

Rules:

- **Record ids first.** At the start of a run, run recipe R-01 in [sql-recipes.md](sql-recipes.md) to capture each persona's `userId`, `consultantProfileId`, `consulteeProfileId`, `timezone` and org memberships. Put them at the top of your report.
- **Time zones.** If a persona's `User.timezone` differs from the column above and a case depends on it, change it through **Settings → Profile/Preferences** in the UI (that's itself a test: the change must show everywhere at once). Restore it at the end. Only fall back to SQL with owner approval.
- **Browser zone vs profile zone.** The app should render in the profile zone, not the browser's. Where the DevTools MCP can emulate a time zone, run the zone cases once with the browser in a different zone from the profile and report any surface that follows the browser instead.
- **Don't change H1/H2 availability outside the fixture cases.** Other cases depend on it. If you must, restore it and say so.

## 2. Dashboards to cross-check

Every booking state change must agree across these surfaces. "Cross-check" in a case means visit each applicable one.

| Surface | Route |
| --- | --- |
| Consultant home (Needs-you, today) | `/dashboard/consultant/[cid]/home` |
| Consultant requests and allocate | `/dashboard/consultant/[cid]/requests`, `…/requests/[rid]/allocate` |
| Consultant appointments | `/dashboard/consultant/[cid]/appointments`, `…/appointments/[aid]`, `…/[aid]/timings`, `…/[aid]/reschedule` |
| Consultant availability | `/dashboard/consultant/[cid]/availability` |
| Consultant offerings and selling | `…/offerings/[type]/new`, `…/offerings/[type]/[id]/edit`, `…/sell/sessions`, `…/sell/programs` |
| Consultant earnings | `/dashboard/consultant/[cid]/earnings` |
| Consultee home | `/dashboard/consultee/[uid]/home` |
| Consultee appointments | `/dashboard/consultee/[uid]/appointments`, `…/[aid]`, `…/[aid]/reschedule`, `…/[aid]/rebook` |
| Consultee payments and refunds | `/dashboard/consultee/[uid]/payments` |
| Public expert page and checkout | `/explore/experts/[consultantId]`, `/explore/programs/plans/…`, `/checkout/plans/{consultation,subscription,webinar,class}/[planId]`, `/checkout/plans/trial/[trialId]` |
| Org workspace / org dashboard | `/dashboard/org-workspace/[id]/…`, `/dashboard/organization/[orgId]/{home,my-program,compensation}` |
| Staff back office | `/dashboard/staff/[staffProfileId]/…` (bookings, refunds, parked sessions, support) |
| Admin | `/dashboard/admin/…` (maintenance, system jobs, analytics) |
| Notifications | bell menu on each dashboard; outgoing mail rows in `NotificationOutbox` |

## 3. Base fixtures (folder `01-setup-and-smoke` creates them)

Create these through the UI. Each later folder says which it needs.

- **F-AV1 — H1 availability** (weekly, `Asia/Kolkata`): Mon–Fri 09:00–13:00 and 17:00–21:00; Sat 10:00–14:00; Sun closed. The 13:00–17:00 weekday gap must stay visible on the grid.
- **F-AV2 — H2 availability:** Mon/Wed/Fri 18:00–21:00; Tue/Thu 07:00–09:00 (tight, for feasibility).
- **F-AV3 — H3 availability** (`America/New_York`): Mon–Fri 09:00–17:00 local.
- **F-AV4 — H4 availability** (`Asia/Kathmandu`): Mon–Sat 10:00–12:00 local (tests :45 offsets on a half-hour grid).
- **F-PL1 — H1 plans:**
  - consultation 60 min, priced (₹500);
  - consultation 30 min, free;
  - consultation 45 min, priced, **request/approval** booking mode (if the editor offers it; otherwise note it);
  - subscription **weeks** plan: 4 weeks × 3/week × 60 min, priced, free 30-min trial;
  - subscription **months** plan: 2 months × 2/week × 90 min, priced, paid trial (₹100).
- **F-PL2 — H2 plans:**
  - webinar 90 min, capacity 5, priced;
  - webinar 60 min, free;
  - class: 2/week, 60 min, capacity 5, priced, start date about 10 days out;
  - a second class left **DRAFT** with no start date.
- **F-PL3 — OX plan (LearnPro-hosted):** consultation 60 min, priced, to test org-hosted earnings and the OH dashboard.
- **F-BUSY — busy block:** B3 books H1's 60-min consultation at next Tuesday 18:00 IST, so H1's grid shows a "Busy" block.

After setup, assert with recipe R-02: availability rows have non-null `timezone` and `local*` columns; plan rows have the expected `sessionsPerWeek`, `sessionDurationInHours`, `durationInWeeks`, `totalSessions` (weeks plan: 12) and `status`.

## 4. Clock control

Most edge cases need "now" to be somewhere specific (24 h before a session, after a deadline). You can't move the server clock. Move the **data** instead, with owner approval:

- shift a session: `UPDATE "AppointmentOccurrence" SET "startsAt" = now() + interval '23 hours', "endsAt" = now() + interval '24 hours' WHERE id = '…'`;
- expire a hold: `UPDATE "Payment" SET "expiresAt" = now() - interval '1 minute' …`;
- age a reschedule: `UPDATE "RescheduleRequest" SET "expiresAt" = now() - interval '1 minute' …`.

Keep times on the **UTC half hour** when you shift sessions, or the event-time rule will (correctly) refuse later actions. Say in the report which rows you shifted and by how much.
