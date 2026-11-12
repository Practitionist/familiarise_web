# 09-e · Integrity: illegal transitions, validation and the audit trail

**Needs:** bookings left by 03–08; owner-approved SQL for the state shifts named. Run after 01–04 of this folder.
**Personas:** B1, B2, B3, DR (dual role), H1, H2, AD.
**Docs under test:** `lib/booking/transitions.ts`, `lib/booking/request-route-guards.ts`, `schemas/slotAllocation/validationSchemas.ts`, `.claude/skills/booking/references/*` (error codes).

Already covered elsewhere (don't repeat): status PATCH to `CANCELLED` → `USE_CANCEL_ENDPOINT` (CO-79), webinar/class `PUT status` → `USE_CANCEL_ROUTE` (WE-44, CL-11), trial PATCH (TR-11, TR-35), decline guards (CO-39), approving a handled request (CO-31), answering your own proposal (CO-66).

## CC-45 — A completed booking can't be cancelled

**Why it matters:** cancelling after delivery would refund a delivered session.

**Setup:** a paid B1 booking whose session has ended and was completed (`auto-complete-appointments`, or owner-approved: move the occurrence 3 h into the past and set `completionStatus = 'COMPLETED'` and the consultation `COMPLETED`).

**Steps:** as B1 open the booking (is Cancel offered?); then `POST …/cancel` and `GET …/cancel/preview`. Repeat as H1.

**Expect:** no Cancel control in the UI; the POST answers `409` `NOT_CANCELLABLE` with human copy; no `Refund`. Record the preview's answer (a 100 % quote on a delivered booking would be FALSE-INFO).

**Probe further:** what does B1 see instead: "Report a problem" / support? A completed booking with no next step is a MISSED-OPPORTUNITY.

## CC-46 — A cancelled booking can't be rescheduled or returned

**Why it matters:** a move on a dead booking would recreate a live session.

**Setup:** a cancelled B2 consultation (CO-71) and a cancelled subscription (SU-72).

**Steps:** open each reschedule page by URL (`/dashboard/consultee/[id]/appointments/[aid]/reschedule`); `POST …/reschedule` with a green time; for the subscription, `POST …/occurrences/[oid]/return`.

**Expect:** the page shows a clear "this booking was cancelled" state, not a working grid; each POST is a typed `4xx` (record codes); no `RescheduleRequest`, no occurrence. R-03 unchanged.

**Probe further:** the consultant's reschedule page for the same booking?

## CC-47 — An expired or rejected request can't be allocated

**Why it matters:** placing sessions on an expired request bypasses payment.

**Setup:** CO-40's `EXPIRED` request and CO-38's `REJECTED` one (or owner-approved status writes on fresh QA requests).

**Steps:** as H1 open each allocate page by URL; send `PATCH …/allocate` with one slot.

**Expect:** the page shows the request's final state; the PATCH answers `409` with `errorCode` (record; `ILLEGAL_TRANSITION` likely) and copy; no occurrence; status history unchanged.

**Probe further:** does H1's requests list still link to these pages? Where does the link lead?

## CC-48 — Status PATCH doors accept only the decisions they own

**Why it matters:** the PATCH door is the expert's approve/decline; every other status must go through its own door.

**Setup:** a fresh pending B2 request to H1; DR with a consultant profile and a consultee profile (verify by R-01), and a DR request to DR's own plan if one can be created (CO-08 refuses self-booking; if it can't, skip that sub-step).

**Steps:**

1. As B2 `PATCH /api/bookings/consultations/[id]` with `{ "status": "APPROVED" }`, then `{ "status": "REJECTED" }`.
2. As H1 PATCH `{ "status": "SCHEDULED" }`, then `{ "status": "COMPLETED" }`.
3. As DR approve DR's own request (if it exists).

**Expect:** 1: `403` "Only the consultant can approve a request." and `403` "Only the consultant can decline a request. Cancel it instead.". 2: `400` (`UNSUPPORTED_STATUS_PATCH` or the detail door's equivalent; record the message). 3: `403` `SELF_APPROVAL` "You cannot approve your own request". No status change in any case.

**Probe further:** the `USE_CANCEL_ENDPOINT` message names an API path ("Use POST /api/appointments/{appointmentId}/cancel instead."); if any UI surface shows it, that's COPY (developer text to a user).

## CC-49 — Allocate body validation

**Why it matters:** salvaged from old 009 Phase 6; a malformed body must be a 400, never a write.

**Steps:** as H1 on a pending request: `PATCH …/allocate` with `{}`; with `{ "isAuto": false }`; with `{ "isAuto": false, "slots": [] }`; with a malformed event id in the URL (`not-a-uuid`).

**Expect:** `400` "'isAuto' is required"; `400` "Manual allocation requires 'slots' array with at least one time slot" (both manual cases); the malformed id: `400` before any lookup (record code, `VALIDATION_ERROR` likely). No writes.

**Probe further:** a slot off the 30-minute grid or of the wrong length: record the code and copy (CO-03 covers checkout; this is allocate).

## CC-50 — An old pay link for a cancelled or expired booking

**Why it matters:** a link in an old email must not take money for nothing.

**Setup:** the `pendingPaymentUrl` (`/checkout/pay/[paymentId]`) of CO-35 (withdrawn approval) and CO-36 (expired link).

**Steps:** as the buyer open each link; if a pay button appears, don't pay with a real method: record the page state and the request it would send.

**Expect:** a clear "this link is no longer valid" state with the reason and a next step (book again); no new gateway order minted on page load (check network and `Payment` rows).

**Probe further:** as a different buyer (B3) open B1's link: refused without showing B1's booking details.

## CC-51 — The webinar and class doors refuse illegal edits after sale

**Why it matters:** the sold-event rules are enforced on every door, not only the menu.

**Setup:** H2's sold webinar and sold class (05, 06).

**Steps:** call directly: the allocate PATCH for each (`isAuto: true`); the reschedule POST for a webinar booking; the class pattern save body (copy from CL-14) against the sold class.

**Expect:** `409` `USE_RETIME` on allocate and pattern save; the reschedule door refuses webinars (WE-33 code). Nothing changes. These doors are tested in 05/06 through the UI; this case confirms the server refuses when the UI is bypassed.

## CC-52 — Every status change left one sane history row

**Why it matters:** the history is the audit trail for disputes and support.

**Steps:** after 03–09 have run, for every QA appointment:

```sql
SELECT h."appointmentId", h.entity, h."fromStatus", h."toStatus", h.reason, h."actorUserId", h."createdAt"
FROM "BookingStatusHistory" h WHERE h."appointmentId" IN (:qaAppointments) ORDER BY h."appointmentId", h."createdAt";
```

**Expect:** each row's `fromStatus` equals the previous row's `toStatus` for the same entity; no illegal jumps (e.g. `EXPIRED → SCHEDULED`, `CANCELLED → anything`, `COMPLETED → CANCELLED`); every sweep transition has a reason (`auto-complete`, `PLAN_ENDED`, `STALE_RESCHEDULE_RETURNED`, the parked reason, "Proposal lapsed without an answer"); every user action has an `actorUserId`. A request whose current status has no history row is a DATA-INTEGRITY finding.

**Probe further:** does any UI show this history (staff booking page, the consultant's booking timeline)? Does it match?

## CC-53 — No host is double-booked anywhere after the whole run

**Why it matters:** the overlap invariant is the core promise.

**Steps:** run R-05 for every host persona (H1, H2, H3, H4, OX). Then the tentative-aware variant: the same query without the status filter but with `a."isTentative" OR b."isTentative"` to list holds overlapping confirmed sessions.

**Expect:** zero rows from R-05 for every host. Tentative overlaps: list each with its payment state; a live hold overlapping a confirmed session is DATA-INTEGRITY unless the hold's payment is dead (then `reconcile-occurrence-availability`, SW-31, should clear the flag).

**Probe further:** run the same check across co-host calendars (H3 as a webinar co-host vs H3's own 1:1s).
