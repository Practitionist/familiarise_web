# 03-g · Consultations: parked bookings, free rebook after an outage, booking again

**Needs:** 03-e (reschedule fixtures), local mock pay, owner-approved SQL; sweeps are `[sweep]`.
**Personas:** H1 (IST), B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), ST.
**Docs under test:** `.claude/skills/booking/SKILL.md` doctrine §1 (`restoreRescheduledBooking`, `parkParentForUnrestoredEnding`), `lib/booking/parked-consultation-sweep.ts`, `lib/booking/incident-rebook.ts`, `app/dashboard/consultee/[consulteeId]/(features)/appointments/[appointmentId]/rebook/page.tsx`.

A **parked** consultation: a paid booking whose released session couldn't go back to its original time when a proposal was declined or expired. It sits `APPROVED` (or `SCHEDULED`) with only a released row and no open proposal. If nobody places a time within **7 days** of the park, or by **48 h after the original start** (whichever comes first), the parked sweep cancels it with a full refund under the marker `parked-consultation:<consultationId>:<paymentId>`; an expert who started the move takes a strike.

## CO-87 — A decline that can't restore parks the booking `[local]`

**Why it matters:** a decline must commit even when the original time is gone, and leave the booking in a state someone can fix.

**Setup:** B3 books S-08 at Wed D+9 10:00 IST (**P-1**). B3 proposes an out-of-hours time (CO-47 shape). Owner-approved: move another QA occurrence of H1 onto Wed D+9 04:30Z–05:30Z (the released original) to simulate the time being taken; record it.

**Steps:** as H1 click **Keep the original time** → **Decline proposal**.

**Expect:**

- The decline commits: `RescheduleRequest` `DECLINED`, `restoredAt` NULL (nothing restored).
- P-1: parent `APPROVED` (or `SCHEDULED`), one occurrence `RESCHEDULED`/tentative, no live confirmed session, no open proposal: parked.
- B3's card copy: "Your original session times go back on your calendar. If one has been booked by somebody else in the meantime, your consultant places that session at a new time instead." Then the detail must say the session needs a new time (quote it).
- H1's Requests row: "You released this session · pick a new time" or "Sessions need new times" with **Pick a new time**.
- Payment untouched.

**Probe further:** as B3, try **Withdraw request** on the (now closed) proposal: nothing open. Before the decline, B3's withdraw would have been 409 `ORIGINAL_TIME_TAKEN` (CO-56). R-05 must still be zero rows (the released row doesn't conflict with the moved occurrence as a live session; record if the overlap invariant query flags it because `RESCHEDULED` rows occupy).

## CO-88 — The expert resolves a parked booking by placing a time

**Steps:** as H1 click **Pick a new time** on P-1 and place Thu D+10 10:00 IST. Save.

**Expect:** a confirmed occurrence at 04:30Z on Thu D+10; the released row closed; parent back to its scheduled status; history token `schedule:reschedule`; B3 notified with the new time in Los Angeles time. The parked sweep no longer matches it.

**Probe further:** could B3 have placed it themselves? (Allocation is host-side; record what B3's page offers.)

## CO-89 — A parked booking nobody fixes is cancelled with a full refund `[sweep]`

**Why it matters:** the money doesn't sit forever on a booking with no time.

**Setup:** park a second booking (**P-2**, B2, Thu D+10 17:00 IST) exactly as CO-87, with the client (B2) as initiator. Owner-approved: age the park (the declined proposal's `resolvedAt` to 8 days ago), or move the released row's original start to 49 h ago.

**Steps:** NEEDS-OWNER-RUN `expire-stale-requests` (runs `cancelAgedParkedConsultations`), or wait for a tick.

**Expect (verification SQL):**

```sql
SELECT c."requestStatus" FROM "Consultation" c JOIN "Appointment" a ON a."consultationId" = c.id WHERE a.id = :aid;   -- CANCELLED
SELECT "completionStatus", "deletedAt" FROM "AppointmentOccurrence" WHERE "appointmentId" = :aid;              -- released row closed
SELECT "refundOwedKey", "refundOwedPaise", "refundOwedReason" FROM "Payment" WHERE "appointmentId" = :aid;    -- parked-consultation:<cid>:<pid>, full amount, then cleared
SELECT "dedupeKey", "amountPaise", status FROM "Refund" r JOIN "Payment" p ON p.id = r."paymentId" WHERE p."appointmentId" = :aid;
```

- Reason shown to both: "No new time was placed after this session was moved, so the booking was cancelled." and "Your payment is being refunded in full."
- No strike (the client started the move).

**Probe further:** run twice: one refund, one notice each. If the refund fails, `retry-auto-refunds` re-drives (12).

## CO-90 — A parked booking the expert started earns the expert a strike `[sweep]`

**Setup:** park **P-3** where H1 initiated: H1 proposes (CO-60 shape) on a B1 booking, take the original time (owner SQL), B1 declines → parked. Age it as CO-89.

**Expect:** same cancel and full refund as CO-89, plus one strike for H1 (`SystemEvent` with the parked cause; record the `strike` value).

## CO-91 — What a parked booking looks like on every surface before the sweep

**Why it matters:** parked is a confusing state; each side must know what's happening and the deadline.

**Steps:** for P-2 before aging, read B2's home, appointments, detail; H1's home ("Needs you"), Requests, appointments; staff stuck-work (`/dashboard/staff/stuck-work`).

**Expect:** B2 sees that a new time is pending and the date it will be cancelled and refunded if none is placed (MISSED-OPPORTUNITY if the deadline isn't stated). H1 sees an action with urgency. Staff stuck-work lists it (parked for ops more than 7 days is escalated; record whether a fresh park appears). No page shows it as a normal upcoming session.

## CO-92 — Free rebook of an outage-voided session

**Why it matters:** "Rebook" is the outage remedy, not a new purchase. The original payment pays for the new time; no money moves.

**Setup:** an open `IncidentRemedy` (`kind = 'REFUND_AT_DUE'`, `doneAt` NULL, `dueAt` in the future) on a persona's voided consultation occurrence. Find one with HM-46's query; otherwise ask the owner whether to seed a `PlatformIncident` + `IncidentRemedy` on a QA booking. Without one, BLOCKED.

**Steps:**

1. As the learner open the booking detail: look for the rebook offer and the "bring the refund forward" option.
2. Open `/dashboard/consultee/[uid]/appointments/[aid]/rebook`. Pick a free time ≥ 15 min ahead within 30 days. Submit **Rebook free**.
3. On a second remedy (or before step 2 on another booking), choose the refund instead.

**Expect:**

- 2: a new confirmed occurrence with the same ordinal and length; `IncidentRemedy.doneAt` set and `rebookedOccurrenceId` = the new row; no new `Payment`, no `Refund`; the voided row stays voided; both notified as a reschedule.
- 3: a 100 % refund now instead of at `dueAt` (`bringIncidentRefundForward`), and the remedy closed. Exactly one of {rebook, refund} per remedy: after one, the rebook page shows "There is nothing to rebook here" / "This session was already rebooked or refunded, or its refund is now on its way."

**Probe further:** the doc (PR #2701 QA prompt C-14) calls this "rebook a completed consultation"; it isn't. Report the DOC-DRIFT. What does the learner see if they do nothing (the automatic refund date)?

## CO-93 — Booking the same expert again after a completed consultation

**Why it matters:** the natural next step after a good session; the PR's "rebook" wording suggests a flow that may not exist.

**Setup:** a completed consultation: shift a QA booking (CO-01's or a free one) to have ended yesterday, and set its occurrence `completionStatus = 'COMPLETED'` and the consultation `COMPLETED` with owner approval (or wait for `auto-complete-appointments`, 12).

**Steps:** as the consultee open the completed booking's detail and the consultee home.

**Expect:** a clear way to book again (a "Book again" link to the expert's page or a review prompt). Record exactly what exists. If there's none, MISSED-OPPORTUNITY (P2). Booking again goes through the normal expert page and checkout (CO-01).

**Probe further:** does the completed page show the review prompt, the recording (if any) and the receipt? Any "Reschedule" or "Cancel" button on a completed booking is a BUG.
