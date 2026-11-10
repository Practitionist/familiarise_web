# 11-b · Dashboards: access by role, org scope, sponsor scheduling, back office and maintenance

**Needs:** the bookings from 11-a's ledger (DB-01): a B1 ↔ H1 consultation, CO-12 (Wipro-sponsored), CO-14 (personal but Wipro-tagged), CO-15 (sponsor allocation fixtures), CO-17 (LearnPro-hosted).
**Personas:** B1, B2, B4, H1, H2, DR, OS, OH, OX, ST, AD.
**Docs under test:** `lib/backoffice/capability.ts` (one tree `/dashboard/{admin,staff}`; staff opening `/dashboard/admin/…` go to the staff twin), `lib/auth/backoffice-permissions.ts`, `lib/api/scope/parse.ts` (`orgScope`), `app/api/organizations/[orgId]/appointments/[appointmentId]/allocate/route.ts`, `middleware.ts` (maintenance gate), `app/api/admin/maintenance/route.ts`.

**Scope split with 09:** 09-concurrency-integrity owns API authorisation attacks (a persona calling another persona's write routes). This file checks what each role **sees** on pages, which actions the page offers, and what the refusal page or toast says. When a case here calls an API, it's to read a list or to check refusal copy.

## DB-19 — Page access matrix

**Steps:** for each row, open the route signed in as each persona listed. Record: landed URL, HTTP status, what the page says.

| Route | Owner | Try as |
| --- | --- | --- |
| `/dashboard/consultee/[B1 uid]/appointments/[aid]` | B1 | B2, H1 (the host), ST, OS |
| `/dashboard/consultee/[B1 uid]/appointments/[aid]/reschedule` | B1 | B2, H1 |
| `/dashboard/consultee/[B1 uid]/payments/[paymentId]` | B1 | B2, H1, ST |
| `/dashboard/consultant/[H1 cid]/appointments/[aid]` | H1 | H2, B1 (the buyer), ST |
| `/dashboard/consultant/[H1 cid]/requests/[rid]/allocate` | H1 | H2, B1, OS |
| `/dashboard/consultant/[H1 cid]/earnings` | H1 | H2, B1 |
| `/dashboard/organization/[Wipro]/appointments` | OS | B4 (learner), H1, OH |
| `/dashboard/organization/[LearnPro]/compensation` | OH | OX, B1, OS |
| `/dashboard/staff/appointments` | ST, AD | H1, B1 |
| `/dashboard/admin/maintenance` | AD | ST, H1 |

**Expect:** the owner reaches the page. Others land somewhere sane: their own equivalent page, or a "not found / no access" page with a way back. The host opening the buyer's URL lands on the host's view of the same booking (the go resolver) or a clear refusal, never on the buyer's page. ST opening `/dashboard/admin/maintenance` lands on `/dashboard/staff/support` (no staff twin of maintenance; `maintenance.manage` is admin-only).

**Probe further:** quote every refusal page. A blank page, a spinner that never ends, a raw "403" or a sign-out loop is **ERROR-HANDLING** (P2). Does any refused page leak data in the HTML before redirecting (view-source / `get_network_request`)? That is **SECURITY** (P0). S-25 smoke-tests a few of these; this matrix is the full set.

## DB-20 — Staff and admin trees show different consoles for one booking

**Steps:**

1. As ST, open `/dashboard/admin/appointments` (staff on the admin tree). Note the landing.
2. As AD, open `/dashboard/staff/appointments` and `/dashboard/admin/appointments`. Compare actions.
3. On one paid booking, compare what each tree offers: cancel for the platform, refund, class-series doors, approval-payment actions.

**Expect:**

- ST on `/dashboard/admin/…` → the same page under `/dashboard/staff/…` (`staffTwinHref`).
- AD on the staff tree sees exactly the staff console (audience STAFF).
- Staff: `appointments.cancelForPlatform` and `classSeries.support` yes; `refunds.manage`, `classSeries.money`, `approvalPayments.manage`, `subscriptions.manage` no (read-only views).
- Admin tree: those money actions present.

**Probe further:** do hidden actions also refuse server-side when called from the staff tree (09 owns the attack; here note whether the page explains why an action is missing, e.g. "Admins only")? A missing button with no reason is **MISSED-OPPORTUNITY**.

## DB-21 — Staff use the back-office doors, not the participant doors

**Steps:**

1. As ST, from the staff console, cancel a QA booking for the platform (B1 ↔ H1, ≥ 24 h away). Read the refund it shows first.
2. As ST, call the participant door `POST /api/appointments/[aid]/cancel` from the page for another QA booking.
3. As ST, call `POST /api/appointments/[aid]/reschedule` with any body.
4. R-03, R-04, N-1 for step 1.

**Expect:**

- Step 1: cancelled through the back office, refund as quoted, an audit trail (reason required).
- Step 2: 403 `PLATFORM_CANCEL_DOOR_REQUIRED`, "Cancel this booking from the back office so the refund is audited."
- Step 3: 403 `PLATFORM_RESCHEDULE_DOOR_REQUIRED`, "Reschedule this booking from the back office so the change is audited."
- Step 1's bell to both parties: `APPOINTMENT_CANCELLED` with `cancelledBy` "The platform".

**Probe further:** "The platform cancelled the consultation … Reason: <label>." Is the reason the staff typed shown to the customer verbatim? If staff typed internal notes, they leak. Check the reason field's label on the staff form ("kept in the audit log"?) against what the customer reads.

## DB-22 — `orgScope` on every booking list

Salvaged from old `e2e-booking-agent-017` Phase 5 (scoped lists); CO-19 checks the org list's rows, this case checks the scope variants and their copy.

**Steps:** from the signed-in page, call each list with each scope and persona:

| Caller | Request | Expect |
| --- | --- | --- |
| OS | `GET /api/appointments?orgScope=[Wipro]` | 200; CO-12 present; CO-14 absent |
| B4 | same | 200, only B4's own Wipro rows |
| B4 | `?orgScope=[LearnPro]` | 403 `ORG_MEMBERSHIP_REQUIRED` |
| B4 | `?orgScope=all` | 403 `ALL_REQUIRES_PRIVILEGED_ROLE` |
| AD | `?orgScope=all` | 200, unfiltered |
| OS | `GET /api/organizations/[Wipro]/appointments` | the same rows as the first line |
| OS, B4 | `GET /api/bookings/consultations?orgScope=[Wipro]`, `…/subscriptions?…`, `…/classes?…`, `/api/bookings/inbox?orgScope=[Wipro]` | the same scoping rules per list |
| OH | `GET /api/appointments?orgScope=[LearnPro]` | CO-17 present |

**Expect:** the table holds for every list. The UI lists (`/dashboard/organization/[orgId]/appointments`, `/requests`) show the same rows as the API.

**Probe further:** the `ALL_REQUIRES_PRIVILEGED_ROLE` message reads "?orgScope=all is reserved for ADMIN / STAFF users; pass `personal` or a specific orgId." and `ORG_MEMBERSHIP_REQUIRED` "You are not an active member of org <cuid>." Both are developer text with a raw id. If any page can surface them, report **COPY** (P2). Is the scope sticky in the UI (switching org in the switcher changes every list)?

## DB-23 — What each org role can do on the org dashboard

**Steps:**

1. As OS (Wipro OWNER): Home, Appointments, Requests, My program, Programs, Members, Billing.
2. As B4 (Wipro LEARNER): the same URLs.
3. As OH (LearnPro OWNER): Home, Appointments, Catalog, Compensation, Payouts.
4. As OX (LearnPro EXPERT): the same URLs.

**Expect:** OWNER sees the org's booking lists and spend; LEARNER sees only "My program" and their own rows; EXPERT sees their own sessions and pay, not the org's compensation table. Each hidden section is absent from the nav, not just refused.

**Probe further:** where a member opens a hidden URL directly, what does the page say? Does B4's My program show remaining budget, sessions used, and what a booking will draw from? Missing figures are **MISSED-OPPORTUNITY**.

## DB-24 — The sponsor schedules a booking only after the expert approves

Salvaged from old 017 Phases 1–4; CO-15 runs the core journey. This case reads the org-side UI and every refusal's copy.

**Steps:**

1. With a Wipro-funded request still PENDING (CO-15 fixture), as OS open the org Requests page. Look for a scheduling action. Call `POST /api/organizations/[Wipro]/appointments/[aid]/allocate` with a time inside H1's hours.
2. After H1 approves, schedule from the org UI inside H1's hours. Then try a time outside H1's hours. Then schedule the same booking again.
3. As OS, call the allocate route on CO-14's personal booking (`NOT_ORG_FUNDED`) and with a LearnPro appointment id (`APPOINTMENT_NOT_FOUND`).
4. `SELECT action, details FROM "OrgAuditLog" WHERE "organizationId" = :wipro ORDER BY "createdAt" DESC LIMIT 3;`

**Expect:**

- Step 1: 409 `EXPERT_APPROVAL_REQUIRED`, "The expert has to approve this booking before the organisation can set its times." The UI hides or disables the action and says why.
- Step 2: 200 inside hours (audit row `APPOINTMENT_ALLOCATED_FOR_ORG`); outside hours refused (plain copy, "One of these times is outside the expert's available hours…"); again → 409 `ALREADY_ALLOCATED`.
- Step 3: 403 `NOT_ORG_FUNDED` ("Only bookings funded by the organization's wallet, invoice, or license rail can be allocated on behalf of the organization."); 404 `APPOINTMENT_NOT_FOUND`.
- B4 and H1 get the booked bell when the sponsor schedules.

**Probe further:** this route answers with `code`; the host allocate route answers with `errorCode`. Does the org UI read the right key, or does it fall back to a generic sentence? "organization" (US) and "organisation" (UK) appear in adjacent messages; **COPY** (P3).

## DB-25 — Bell links land each role on the right page

**Steps:** for these bookings, click the bell entry as each recipient and record the landing URL: B1 ↔ H1 consultation (B2C); CO-12 Wipro-sponsored (B4, H1); CO-17 LearnPro-hosted (B1, OX); a class session cancellation (seat holder); DR's booking (DB-15).

**Expect (from `lib/novu/resolve-href.ts`):** B2C work links to `/dashboard/go/auto/<surface>`, which the go resolver sends to each viewer's own side; org-hosted work links to `/dashboard/organization/<orgId>/<surface>`.

**Probe further:**

- For CO-12 (Wipro is a **sponsor**, H1 is not a Wipro member): if the appointment's `organizationId` is Wipro and the bell links to `/dashboard/organization/[Wipro]/appointments`, H1 lands on a page H1 can't open. Report **BUG** (P2) with the landing.
- Most links open a list, not the booking. Report one **MISSED-OPPORTUNITY** for the bell as a whole if so.

## DB-26 — The back office finds a booking from any id

**Steps:** as ST, take one QA booking and look it up by appointment id, payment id, buyer email and Razorpay-style order id (mock) in `/dashboard/staff/trace`, `/dashboard/staff/appointments`, `/dashboard/staff/users/[userId]`, `/dashboard/staff/payments/[paymentId]`. Then open `/dashboard/staff/stuck-work` with a parked booking present (CO-87).

**Expect:** each lookup reaches the same booking; the stuck-work list shows the parked booking with its age and the action that resolves it.

**Probe further:** times on staff pages: which zone, labelled? (TZ-13.) Do staff see the customer-facing status label and the raw enum, and are they consistent?

## DB-27 — Maintenance controls on a non-production deploy

**Why it matters:** maintenance state is shared with production; a preview must never flip it.

**Steps:**

1. As AD, open `/dashboard/admin/maintenance`. Read the current status card ("All systems operational" / "Degraded mode active" / "Offline — site unreachable").
2. Start a degraded window with a reason `qa-DB-27` and an estimated end. Read the toast.
3. `GET /api/admin/maintenance` from the page.

**Expect:** step 2 refused: 409 `MAINTENANCE_PRODUCTION_ONLY`, "Maintenance changes run only on the production deploy." The phase stays OFF. The page says why the action failed.

**Probe further:** the page's generic failure toasts are "Failed to start maintenance" / "Request failed. Please try again." and "Maintenance request failed" / "Refresh the current status, then retry the action." A retry can never work on this deploy. If the server's sentence isn't shown, report **ERROR-HANDLING** (P2). Does the page say up front that it is read-only off production? **MISSED-OPPORTUNITY** if not.

## DB-28 — What users would see during maintenance (owner drill)

Salvaged from old `e2e-booking-agent-008` (the UI parts; 09 owns the money invariants). **NEEDS-OWNER-RUN**: only production can enter maintenance, and the suite never runs on production. If a production window is live while you test (the banner reads from shared state), record what you see; never start one.

**What to verify in the drill (give the owner this list):**

1. DEGRADED: banner "Scheduled maintenance: <reason or 'Some features may be temporarily unavailable.'> Expected completion: <ETA>"; the dismiss button; the banner returns on reload or not.
2. Checkout: the pay button is disabled with "Bookings are temporarily paused during maintenance." (`PlanCheckoutShell` reads `useMaintenanceGuard`).
3. Allocate, reschedule, cancel, request, re-time: the page stays enabled; the write returns 503 `{ "error": "Writes are temporarily unavailable during maintenance", "phase": "DEGRADED", … }` with **no `code`**. Record each surface's toast.
4. OFFLINE: every page rewrites to `/maintenance`; APIs answer 503 "Service temporarily unavailable during maintenance".
5. Redis unreadable: fail-closed writes answer 503 `MAINTENANCE_STATE_UNREADABLE`, "Bookings and payments are briefly unavailable. Please retry." with `Retry-After: 30`.

**Expect (static review now):** read the five code paths above and record, per booking surface, whether it disables its action during maintenance or only fails on submit.

**Probe further:** the banner says "Scheduled maintenance" even for an unplanned window. `formatEta` uses `toLocaleString(undefined, …)` (browser zone and locale, no zone label). Only checkout reads the maintenance guard; every other booking surface fails late. Report each as **MISSED-OPPORTUNITY** or **COPY** with the file.

## DB-29 — System jobs on a non-production deploy

**Steps:** as AD, open `/dashboard/admin/system-jobs`. Read the job list (last run, next run). **On a deploy preview only**, trigger one booking job (`expire-stale-requests`) from the page. On local `next dev`, don't trigger anything: read the page only.

**Expect:** on a preview, 409 `JOB_RUN_PRODUCTION_ONLY` with a sentence that says jobs run only on production; the page shows it.

**Probe further:** `jobsMayRunHere()` (`lib/cron/dispatch-refusal.ts`) returns true for a local `development` process not on Netlify, so a local run would act on the shared database. Report this to the coordinator as an open question for 12; don't test it. Are "last run" times labelled with a zone? Does the page say why a job can't run here before you click?

## DB-30 — A suspended or deactivated org on its members' dashboards

**Steps:** read-only unless an org in that state already exists in seed data (`SELECT id, name, status FROM "Organization" WHERE status <> 'ACTIVE';`). If one exists with a QA-safe member, sign in as that member and open the org dashboard and an old booking.

**Expect:** members of a DEACTIVATED org get 403 `ORG_DEACTIVATED` ("Organization has been deactivated") on scoped lists; their personal bookings still show on the consultee dashboard.

**Probe further:** if no such org exists, mark BLOCKED (no fixture) and don't create one. Note whether the copy would tell a learner what happens to their sponsored sessions.
