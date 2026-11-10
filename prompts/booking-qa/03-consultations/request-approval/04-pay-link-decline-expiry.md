# 03-d · Consultations: pay link, remind, withdraw, decline, expiry

**Needs:** 03-c (H1 in REQUEST mode; CO-25's approved-unpaid booking). Paying a pay link needs Razorpay test mode (`/checkout/pay/[paymentId]` has no Mock Pay); sweeps are `[sweep]`.
**Personas:** H1 (IST), B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles).
**Docs under test:** `.claude/skills/booking/SKILL.md` doctrine §5, `scripts/payments/cleanup-abandoned-payments.ts`, `scripts/appointments/expire-stale-requests.ts`, `lib/booking/remind-payment.ts`, `lib/booking/request-route-guards.ts`.

Outcome words matter here. Doctrine: an approved request nobody paid ends **EXPIRED** (never REJECTED, never CANCELLED); a buyer who walks away ends **CANCELLED**; an expert who says no ends **REJECTED**. Check the word on every surface, not only in the DB.

## CO-32 — B1 pays the approval link

**Why it matters:** the capture turns an approved request into a confirmed booking without moving the session.

**Setup:** CO-25's booking `APPROVED_PENDING_PAYMENT`. Razorpay test mode on local; otherwise BLOCKED (no gateway). Owner can replay a signed capture webhook instead (`.claude/skills/finance/references/verification.md`, "Replaying a webhook"): NEEDS-OWNER-RUN.

**Steps:** as B1 open the pay CTA (`pendingPaymentUrl` → `/checkout/pay/[paymentId]`). Pay with the gateway's test method.

**Expect:**

- `Payment` → `SUCCEEDED` (same row as the pre-mint, not a second payment); `Consultation` → `SCHEDULED` or `APPROVED` (record) and `pendingPaymentUrl` cleared; the **same** occurrence id, now non-tentative; earnings created.
- H1's row loses "Remind"/"Withdraw approval"; B1's widget disappears.

**Cross-check:** standard list (03-a). R-05 zero rows.

**Probe further:** pay twice (open the link again after success): a typed refusal ("already paid"), not a second charge.

## CO-33 — Remind, and the remind rate limit

**Why it matters:** a manual nudge must reach a live link only, and not spam.

**Setup:** an `APPROVED_PENDING_PAYMENT` booking with a live link (approve a fresh B2 request as in CO-25 if CO-25's was paid).

**Steps:**

1. As H1 click **Remind** on the row. Read the toast and the row ("Remind sent · next in N h").
2. Click Remind again (or `POST /api/bookings/consultations/[id]/remind`).
3. R-07 for the consultation.

**Expect:** 1: 2xx; one outbox mail "Reminder: payment due - Consultation with <H1 name>" to B2. 2: 4xx `REMIND_RATE_LIMITED` with `nextAllowedAt`; the UI states when Remind is available again in IST.

**Probe further:** B2's mail subject in London time? Does B2's dashboard show the reminder (bell)?

## CO-34 — Remind disappears when the link lapses

**Why it matters:** Remind is offered only under the live-link predicate; an expired link can't be resent.

**Steps:**

1. Owner-approved: `UPDATE "Payment" SET "expiresAt" = now() - interval '1 minute' WHERE id = :pendingPaymentId;`
2. Reload H1's Requests.
3. `POST …/remind` anyway.

**Expect:** 2: Remind hidden. 3: 409 `NOT_AWAITING_PAYMENT` "There is no open payment link to remind about. It may have expired or already been paid." The booking stays `APPROVED_PENDING_PAYMENT` until the sweep (CO-36).

**Probe further:** what do H1 and B2 see now: does any surface still say "waiting for payment" with a dead link? That's the window before the sweep; judge whether the copy is honest.

## CO-35 — The expert withdraws an unpaid approval

**Why it matters:** an expert who changes their mind before payment must free the time and kill the link.

**Setup:** a fresh `APPROVED_PENDING_PAYMENT` booking (B3 request, Approve).

**Steps:** as H1 click **Withdraw approval** (`POST /api/bookings/consultations/[id]/withdraw-approval`). As B3 open the old pay link.

**Expect:** `Consultation` → `CANCELLED`; PENDING payment expired (CAS); hold released; B3's link refuses with words (expired/cancelled), never takes money. B3 is told by bell/outbox.

**Probe further:** what does B3 read as the reason ("withdrawn by the expert")? A capture racing the withdraw is 09.

## CO-36 — An approved link nobody pays ends EXPIRED, with one notice `[sweep]`

**Why it matters:** doctrine §5: one terminal word for approved-but-unpaid, one notice, no money.

**Setup:** CO-34's booking (link lapsed by clock).

**Steps:** this needs the `abandoned-payments` job (`cleanupAbandonedPayments` / `cleanupExpiredApprovalPendingPayments`, shared `expireLapsedPayLink`). Off production it can't be triggered: mark NEEDS-OWNER-RUN with the job name and the SQL below, or wait for a scheduled tick if the environment runs one.

**Expect (verification SQL):**

```sql
SELECT c.id, c.status, c."pendingPaymentUrl" FROM "Consultation" c WHERE c.id = :cid;          -- EXPIRED
SELECT id, "paymentStatus" FROM "Payment" WHERE "appointmentId" = :aid;                          -- EXPIRED (from PENDING only)
SELECT "completionStatus", "deletedAt" FROM "AppointmentOccurrence" WHERE "appointmentId" = :aid; -- hold released
SELECT kind, recipients, "createdAt" FROM "NotificationOutbox" WHERE "entityRef" LIKE '%' || :cid || '%'; -- exactly one lapse notice
```

- Surfaces say "expired" (or "payment window closed"), never "declined"/"rejected"/"cancelled by expert".
- Separately, `expire-stale-requests` expires `APPROVED_PENDING_PAYMENT` older than 7 days (`expirePaymentPendingRequests`); same word, same guards.

**Probe further:** run the job twice: still one notice. A capture that lands just before the sweep keeps `SUCCEEDED` and the booking is not expired (race depth: 09/12).

## CO-37 — The buyer cancels an approved, unpaid booking

**Why it matters:** the buyer's walk-away is CANCELLED (they decided), distinct from EXPIRED.

**Setup:** a fresh `APPROVED_PENDING_PAYMENT` booking for B2.

**Steps:** as B2 on the pending-payments widget click **Cancel booking**, confirm ("Keep booking" / "Cancel booking").

**Expect:** `POST /api/bookings/[bookingId]/abandon` → 2xx; `CANCELLED`; payment expired; hold released; no refund row (nothing paid). If a capture committed first: 409 `ALREADY_PAID` and the UI routes B2 to the normal cancel quote.

**Probe further:** H1's Requests: the row disappears or shows "cancelled by client" (quote).

## CO-38 — The expert declines a fresh request

**Why it matters:** REJECTED is the expert's no; it must free the time and tell the client kindly.

**Setup:** B3 requests S-10 at Fri D+11 17:00 IST.

**Steps:** as H1 click **Decline** on the row (button may read "Decline request" with "Declining…"). Add a reason if asked.

**Expect:**

- `PATCH /api/bookings/consultations/[id]` `{ status: "REJECTED" }` → 2xx; `REJECTED`; history reason "Request declined by consultant" (or H1's text); hold released; no money (none was taken).
- B3 sees "declined" wording and a next step (book another time / another expert).
- The time is offered again on H1's page.

**Probe further:** B3's reason text: does H1's free text reach B3 verbatim? Any raw `REJECTED` on B3's page is a COPY finding.

## CO-39 — Decline is refused where it would corrupt a booking

**Why it matters:** decline is for requests; a paid or moving booking ends through cancel or the reschedule loop.

**Steps (`evaluate_script` as H1):**

1. `PATCH … { status: "REJECTED" }` on CO-32's paid booking.
2. Same on a booking with an open reschedule (from 03-e).
3. As B1, `PATCH … { status: "REJECTED" }` on B1's own pending request.
4. As B1, `PATCH … { status: "CANCELLED" }`.

**Expect:** 1: 409 "This booking was already confirmed. Place a new time, or cancel it to refund the client." 2: 409 `USE_RESCHEDULE_RESPOND`. 3: 403 "Only the consultant can decline a request. Cancel it instead." 4: 4xx "Cancelling bookings via status PATCH is not supported. Use POST /api/appointments/{appointmentId}/cancel instead." (that last message is developer text: COPY finding if a user can ever see it).

## CO-40 — A request nobody answers expires after 48 hours `[sweep]`

**Why it matters:** a pending request holds the expert's time; it can't hold it forever.

**Setup:** a fresh B2 request. Owner-approved: `UPDATE "Consultation" SET "requestedAt" = now() - interval '49 hours' WHERE id = :cid;`

**Steps:** before the sweep, reload H1's page and B2's expert page view: a request past its hold window no longer holds anything (`holdingSince`), so the time may already be offered. Then NEEDS-OWNER-RUN `expire-stale-requests` (`PENDING_CONSULTATION_EXPIRATION_HOURS = 48`).

**Expect:** `EXPIRED`; hold released; one notice to B2 ("request expired", not "declined"); H1's row gone. B2's 3-request cap no longer counts it.

**Probe further:** does H1's row show the countdown hitting zero before the sweep, and what does it say then?

## CO-41 — A request whose time passes before anyone answers

**Why it matters:** approving a time in the past must be impossible.

**Setup:** a B3 request for a time at least 3 h ahead. Owner-approved: move its requested window/occurrence to 1 h ago (UTC half hour).

**Steps:** as H1 open Requests and the allocate page; try **Approve** (use requested).

**Expect:** refused with a typed 409 (`TOO_CLOSE_TO_START`, a past-slot refusal or `SLOT_TOO_SOON`; record); the row tells H1 the time has passed and offers another time or decline. Never a confirmed booking in the past.

**Probe further:** B3's view: does it still say "waiting for approval" for a time already gone? FALSE-INFO if so.

## CO-42 — What the consultee sees across the whole request journey

**Why it matters:** one pass that reads every state from the buyer's side, in their zone.

**Steps:** as B2 (London), for one request taken through PENDING → APPROVED_PENDING_PAYMENT → (lapse) or (paid), read home, appointments list, detail and payments at each step. Screenshot each.

**Expect:** each state has its own plain wording, a time in London time, the amount, the deadline where one exists, and one clear next action (wait / pay / book again). No raw enums. The amount is the same everywhere (plan price + tax).

**Probe further:** list each piece of copy in the copy log; mark slop and missing explanations.

## CO-43 — Approval history and audit

**Why it matters:** every transition writes one history row; staff need it to answer tickets.

**Steps:** for CO-25 (approved → paid) and CO-38 (declined), read `BookingStatusHistory` (R-03) and the staff booking page.

**Expect:** one row per transition with sane from/to (`CREATED` → `PENDING` → `APPROVED_PENDING_PAYMENT` → `SCHEDULED`; `PENDING` → `REJECTED`), actor ids set, no illegal jumps. Staff page shows the same timeline in words.

## CO-44 — Money summary for the approval path

**Why it matters:** the pre-mint row, the capture and any expiry must reconcile.

**Steps:** for every booking created in 03-c/03-d, run R-04.

**Expect:** at most one `SUCCEEDED` payment per booking; PENDING rows of expired bookings are `EXPIRED`; no refund rows (nothing paid was cancelled here); earnings exist only for paid bookings.

## CO-45 — Restore H1 to Instant booking

**Steps:** as H1 Settings → Booking → "Instant booking"; "Limit open requests to" empty; "Taking new 1:1 bookings and trials" on. SQL S-01's settings query.

**Expect:** `bookingMode = 'INSTANT'`, `acceptingRequests = true`, `maxOpenRequests` NULL. List every request still open from this folder and cancel or leave it (ledger).
