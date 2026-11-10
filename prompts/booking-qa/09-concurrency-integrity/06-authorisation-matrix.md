# 09-f · Integrity: authorisation by URL and by API, every persona pairing

**Needs:** bookings from 03–08 (record ids first). No writes except where a step says so. Preview OK.
**Personas:** B1, B2, B3, B4, DR, H1, H2, H3, OX, OS (Wipro owner), OH (LearnPro owner), ST, AD, and signed out.
**Docs under test:** `lib/auth/personal-dashboard-access.ts` (page guard redirects), `lib/auth-helpers.ts` (`resolveEventHostActor`), `lib/api/scope/parse.ts`, `app/api/appointments/[appointmentId]/cancel/route.ts`.

Rule for every case: a refusal must not reveal the other party's data (name, price, time, notes) in the body, the page or the title. A `200` that returns someone else's data is SECURITY P0. A refusal that differs between "exists" and "doesn't exist" in a way that leaks existence is SECURITY P2 (record status and body for both).

## CC-54 — Another buyer's booking pages, by URL

**Why it matters:** the consultee pages are personal; the URL is guessable once shared.

**Setup:** B1's ids: consultee profile id, an appointment id (MO-01), a payment id.

**Steps:** signed in as B2, open B1's `/dashboard/consultee/[B1 cid]/home`, `/appointments`, `/appointments/[aid]`, `/appointments/[aid]/reschedule`, `/payments`, `/payments/[pid]`; then B2's own `/dashboard/consultee/[B2 cid]/appointments/[B1 aid]` and `/payments/[B1 pid]`.

**Expect:** the first set redirects to `/dashboard` before any data renders (page guard); the second set (own profile, foreign ids) shows not-found, never B1's booking or payment. Check page `<title>` and the network responses too.

**Probe further:** repeat signed out: redirect to `/auth/signin` with a return URL? After signing in as B1, does the return URL land on the right page?

## CC-55 — Another buyer's booking, by API

**Why it matters:** a guard only in the page is not a guard.

**Steps:** as B2, call for B1's booking: `GET /api/appointments/[aid]`, `GET …/cancel/preview`, `POST …/cancel`, `POST …/reschedule`, `POST …/reschedule/respond`, `POST …/occurrences/[oid]/return` (on B1's subscription), `GET /api/checkout/pending/[pid]` style reads you find in the network panel, `DELETE /api/checkout/pending/[B1 pid]`.

**Expect:** each `403` or `404` with no B1 data; the cancel's 403 says "You are not authorized to cancel this appointment". No write (R-03 unchanged).

**Probe further:** a random uuid on each door: compare status and body with the 403 case.

**Also (salvaged from old 004 Phase 5):** as B2, `POST /api/checkout` for H1's S-08 with a valid H1 time but **H3's** `availabilityWindowWeeklyId` (R-02 for H3). Expect a typed `4xx` (the window must belong to the plan's expert), no payment, no occurrence for either host. Then H1's own window id: works (`[local]`).

## CC-56 — Another host's requests and allocate doors

**Why it matters:** a host must not place, approve or decline another host's bookings.

**Steps:** as H3, open H1's `/dashboard/consultant/[H1 cid]/requests`, `…/requests/[rid]/allocate`, `…/appointments/[aid]/timings`, `…/earnings`, `…/availability`. Then by API: `PATCH /api/bookings/consultations/[H1 request]/allocate`, `PATCH /api/bookings/consultations/[H1 request]` `{ "status": "REJECTED" }`, `POST …/withdraw-approval`, `POST …/remind`.

**Expect:** pages redirect or 404 without H1's data; the allocate PATCH `403` (`authorizeEventAccess` refuses non-participants; if it passes, `ALLOCATE_FORBIDDEN` "Only the expert or their organisation can set times for this booking."); the others `403`. No writes.

**Probe further:** H3 as a **co-host** of an H2 webinar: can H3 open H2's webinar allocate or re-time doors? Record what a co-host may do.

**Also (salvaged from old 004 Phases 2–4):** as H3, then as B1, send `PUT /api/user/consultants/[H1 cid]` with H1's current settings body (copy it from H1's own Save in the network panel, changing nothing), and call the per-row availability doors HM-07 uses with H1's row ids (update and delete). Expect `403` each, H1's rows unchanged (R-02 before and after). Signed out: `401`.

## CC-57 — The buyer can't use host doors on their own booking

**Why it matters:** allocation and approval are host acts.

**Steps:** as B1 on B1's own pending request: `PATCH …/allocate` (`isAuto: true`), `PATCH /api/bookings/consultations/[id]` `{ "status": "APPROVED" }`, `POST …/remind`, `POST …/withdraw-approval`, and open H1's allocate URL for it.

**Expect:** allocate `403` `ALLOCATE_FORBIDDEN`; approve `403` "Only the consultant can approve a request."; remind and withdraw `403`; the page redirects. CO-09 covers the allocate refusal in the UI.

## CC-58 — Staff on the buyer's and host's doors

**Why it matters:** staff can read and act, but money actions must go through audited back-office doors.

**Steps:** as ST: open B1's consultee dashboard URLs (inspect mode?), H1's consultant dashboard URLs; call `GET …/cancel/preview` and `POST …/cancel` on B1's booking; `PATCH …/allocate` on a pending H1 request; `POST /api/admin/refunds`.

**Expect:** record each. From code: ST passes the allocate host check (`staff` actor); the personal dashboards may open in an inspecting mode (record banner/copy); `POST …/cancel` answers `403` `PLATFORM_CANCEL_DOOR_REQUIRED` "Cancel this booking from the back office so the refund is audited."; the admin refund door needs ADMIN with step-up (ST refused or routed to a proposal; record). The back-office cancel door (Money → booking ops "Platform cancel") works for ST and writes an ops log row.

**Probe further:** an inspecting staff view must not let ST pay, cancel or reschedule as the buyer; try the buttons and record.

## CC-59 — Org owners see only their own org

**Why it matters:** org dashboards hold other companies' spend and people.

**Steps:** as OH (LearnPro), open `/dashboard/organization/[Wipro]/home`, `/my-program`, `/compensation` and `/dashboard/org-workspace/[Wipro workspace]/billing`. As OS (Wipro), open LearnPro's and IIT's equivalents. Then by API, as OS, `GET /api/appointments?orgScope=<LearnPro id>`.

**Expect:** every page redirects or 404s without the other org's data; the API `403` `ORG_MEMBERSHIP_REQUIRED`.

**Probe further:** org ids appear in URLs: are they guessable? Do the refusals differ between a real org id and a random one?

## CC-60 — An org member who is a plain learner

**Why it matters:** a learner in Wipro must not see colleagues' bookings or the org's spend.

**Steps:** as B4 (Wipro learner) open Wipro's org dashboard routes and `GET /api/appointments?orgScope=<Wipro id>`.

**Expect:** dashboards refused; the API answers `200` but downgraded to B4's own rows in that org (`orgMember` scope): every returned id has `organizationId = Wipro` **and** involves B4 (verify with SQL). Salvaged from old 010 Phase 5.

**Probe further:** DR (also Wipro learner): same result?

## CC-61 — Host-org operators act only inside their org's plans

**Why it matters:** a LearnPro operator must not allocate H1's (independent) bookings.

**Steps:** as OH, `PATCH …/allocate` on an H1 request; on an OX (LearnPro-hosted) request (CO-18 covers the allowed path and its hours limit).

**Expect:** H1's: `403`. OX's: allowed (host-org actor), but without the expert's overrides (CO-18).

## CC-62 — Signed-out callers get 401, not data or 500

**Why it matters:** public APIs sometimes leak by accident.

**Steps:** signed out (fresh isolated page), call: `GET /api/appointments`, `GET …/cancel/preview`, `POST /api/checkout`, `GET /api/scheduling/availability-with-allocation/[H1 cid]?…` (public grid; record whether it's public by design), `GET` the subscription feasibility endpoint (SU-19), `POST /api/trials`, `POST /api/admin/refunds`.

**Expect:** `401` for each private door with a JSON body (no HTML error page, no stack); public doors return only public data (the grid: free/busy, never buyer names).

## CC-63 — `?orgScope=` on the appointments list

**Why it matters:** salvaged from old 010 Phase 5; the scoped list must never leak another tenant's rows.

**Steps:** as B1 (no org): `GET /api/appointments`, `?orgScope=mine`, `?orgScope=personal` (legacy), `?orgScope=<Wipro id>`, `?orgScope=all`, and `?appointmentType=NOPE`. As OS (Wipro owner with operations read): `?orgScope=<Wipro id>`.

**Expect:**

| Caller / request | Status | Body |
| --- | --- | --- |
| B1 bare / `mine` / `personal` | 200 | identical personal rows; every `organizationId` null |
| B1 `<Wipro id>` | 403 | `ORG_MEMBERSHIP_REQUIRED` |
| B1 `all` | 403 | `ALL_REQUIRES_PRIVILEGED_ROLE` |
| B1 bad `appointmentType` | 400 | `{ error: "Invalid query", detail: … }` |
| OS `<Wipro id>` | 200 | only rows Wipro owns: tagged Wipro **and** (no payment yet, or a WALLET/INVOICE/LICENSE payment for Wipro, or a Wipro-owned plan) |

For OS, prove two exclusions with SQL: CO-14's booking (B4 paid personally on H1's plan: `PERSONAL` rail) is absent, and a session Wipro merely funded inside another org's event (if one exists) is absent.

## CC-64 — Admin-only and production-only doors

**Why it matters:** job runs and maintenance flip shared state; they must refuse off production and for the wrong role.

**Steps:** as ST and as AD on a preview: open `/dashboard/staff/system-jobs` (or `/dashboard/admin/system-jobs`) and press **Run** on `abandoned-payments`; `POST /api/admin/maintenance` `{ "phase": "DEGRADED", "reason": "qa-CC-64" }`; open Money tabs ST lacks.

**Expect:** job run: `409` `JOB_RUN_PRODUCTION_ONLY` (AD) or `403` (ST lacks `systemJobs.manage`; record). Maintenance: `409` `MAINTENANCE_PRODUCTION_ONLY` "Maintenance changes run only on the production deploy." (AD) or `403` (ST). Missing tabs redirect to the first allowed tab. The UI explains the refusal in words (not "Error 409").

**Probe further:** does the system jobs page warn before Run that it only works on production? MISSED-OPPORTUNITY if not.

## CC-65 — Suspended and banned users

**Why it matters:** a suspended learner keeps join, not cancel, on an org-funded booking (decision recorded in the cancel route).

**Setup:** needs a suspended Wipro membership for B4 or DR. Don't suspend a shared persona without owner approval; if declined, BLOCKED.

**Steps:** as the suspended learner, preview and cancel their Wipro-funded booking; try to book a new sponsored session.

**Expect:** the preview and cancel refuse with the same typed answer (record code and copy); joining still works; new sponsored booking refused without billing the learner.

## CC-66 — The trial, webinar and class doors respect parties

**Why it matters:** each event type has its own route family.

**Steps:** as B2: `PATCH /api/trials/[B1 trial]`, `POST …/reschedule` on B1's trial appointment; `POST /api/appointments/[H2 webinar aid]/retime`; the class make-up and series-move doors on H2's class. As H3: the same webinar/class doors.

**Expect:** `403`/`404` everywhere, no writes. TR-27 covers trial parties in the UI.
