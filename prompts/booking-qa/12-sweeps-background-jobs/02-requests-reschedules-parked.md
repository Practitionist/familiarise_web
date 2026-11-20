# 12-b · Sweeps: requests, released sessions, parked bookings and proposals

**Needs:** read [README.md](README.md) "How a sweep case runs". Fixtures from 03 and 04 (each case names one), or fresh ones made through the product.
**Personas:** B1 (IST), B2 (London), B3 (Los Angeles), H1, H2, ST.
**Docs under test:** `scripts/appointments/expire-stale-requests.ts`, `lib/booking/parked-consultation-sweep.ts`, `scripts/appointments/expire-reschedule-proposals.ts`, `lib/booking/week-nudge.ts`, `docs/booking/07-rescheduling-flow.md`.

Cut-offs from code (`expire-stale-requests`): a `PENDING` consultation 48 h after `requestedAt` (never with an open reschedule or an unplaced released slot); a `PENDING` subscription 30 days; `APPROVED_PENDING_PAYMENT` 7 days (backstop behind the pay link's own expiry); a paid plan with no session times: consultant nudges at 12, 24 and 36 h after capture, full refund at 48 h (`UNALLOCATED_48H`); an `APPROVED` plan that never started 30 days; a subscription session released for a reschedule and never re-placed 30 days (`STALE_RESCHEDULE_RETURNED`); a parked consultation 7 days after the park or 48 h after the released session's original start, whichever is first.

## SW-09 — A request expires at 48 hours, not 47 `[sweep]`

**Why it matters:** CO-40 asserts the outcome; the edge decides whether a slow expert still gets to answer.

**Setup:** H1 in request mode (03's switch). Three fresh B2 requests (CO-20 body, different windows). Owner-approved: set `requestedAt` to `now() - interval '49 hours'` (A), `'47 hours'` (B), and A' = 49 h but with an open consultee proposal on it (C; create the proposal through the product first if the shape is reachable, else skip C).

**Steps:** before any run, as B1 read H1's grid for A's and B's requested times. Then NEEDS-OWNER-RUN `expire-stale-requests`; run again.

**Expect:** before the run, A's time already reads free and can be booked (a request past 48 hours stops holding the expert's time by the clock, swept or not), B's still reads taken, and C's still reads taken (a booking being moved keeps its hold). After the run: A `EXPIRED`, its tentative slot released in the same pass (not waiting for `tentative-occurrences`), one notice to B2 (and record whether H1 is told). B and C untouched. Run 2: nothing new, no second notice.

**Aftermath:** B2 sees "expired" with a next step (request again / pick another expert); H1's requests list drops A.

## SW-10 — The slow backstops: 30-day pending plans and 7-day unpaid approvals `[sweep]`

**Why it matters:** these catch rows the fast paths missed; they must not catch rows still alive.

**Setup (owner-approved shifts on QA rows):** a `PENDING` subscription request (B1) with `requestedAt` 31 days ago; an `APPROVED_PENDING_PAYMENT` consultation (B3) with the request's `updatedAt` 8 days ago (the 7-day cohort reads `updatedAt`) and its `Payment` still `PENDING`; controls at 29 days and 6 days.

**Steps:** NEEDS-OWNER-RUN `expire-stale-requests`.

**Expect:** both old rows `EXPIRED` with reason "Auto-expired: PENDING for more than 30 days" (subscription) and the unpaid-approval reason (record); their payments (if any) `EXPIRED`, never `SUCCEEDED` rows touched (the CAS carries the money predicate); controls untouched.

**Probe further:** if `abandoned-payments` already expired the B3 link (SW-05), this arm should find nothing: record which job got there first.

## SW-11 — A paid plan nobody schedules: three nudges, then a full refund `[sweep]` `[local]`

**Why it matters:** SU-81 asserts the refund; the nudges must arrive once each and stop when the expert acts.

**Setup:** two fresh paid plans (B1 and B2, H1's weeks plan, Mock Pay). Owner-approved: move B1's `Payment.capturedAt` (and the subscription's age the cohort reads) to 13 h ago; B2's to 49 h ago.

**Steps:** NEEDS-OWNER-RUN `expire-stale-requests`. Then shift B1 to 25 h, run; 37 h, run. Then H1 places week 1 for B1 and shift to 49 h, run.

**Expect:** B1: one hour-12 nudge, one hour-24, one hour-36 (a run that missed a stage sends only the latest reached, never two at once); after H1 places sessions, no refund at 49 h. B2: `EXPIRED` with history reason `UNALLOCATED_48H`, a full-refund owed marker, the refund driven (record key), one bell to B2 ("Subscription was not scheduled within 48 hours of payment and is being refunded in full.") and one to H1.

**Aftermath:** H1's home "Needs you" showed B1's plan with urgency before each nudge? B2's Payments shows the full refund.

## SW-12 — The 30-day "approved but unallocated" refund at its edge `[sweep]`

**Why it matters:** SU-82 tests never-started vs started; this tests the clock and the "nothing open" rule.

**Setup:** the SU-82 shape (an `APPROVED` plan that never had a confirmed session), three copies: A with `updatedAt` 31 days ago, B 29 days, C 31 days with an open reschedule request (the cohort reads `Subscription.updatedAt`, so any later write to the plan restarts the clock: record that as a design question).

**Steps:** NEEDS-OWNER-RUN `expire-stale-requests`; run again.

**Expect:** A `EXPIRED` with reason "Auto-expired: APPROVED and never scheduled for more than 30 days" and a full refund marker; B and C untouched. Run 2: no second refund (the marker key is per payment).

## SW-13 — A released subscription session nobody re-places goes back to the plan `[sweep]`

**Why it matters:** a released session must not sit as a ghost hold forever.

**Setup:** B1's weeks plan: B1 releases a session with "Any time works" (SU-62) and H1 doesn't place it. Owner-approved: set the released row's `updatedAt` to 31 days ago; a second released row at 29 days as control. The cohort (from code): `isTentative = true`, `completionStatus = RESCHEDULED`, not deleted, `updatedAt` older than 30 days, on a subscription whose status is `APPROVED`. A live subscription stays `APPROVED` from approval to completion (it never enters `SCHEDULED`, `lib/booking/transitions.ts`), so a live plan qualifies.

**Steps:** NEEDS-OWNER-RUN `expire-stale-requests`.

**Expect:** the old row's hold released; the session returned to the plan (entitlement offers it again; `sessionsReturned` or the plan math reflects it; record which column moves); history reason `STALE_RESCHEDULE_RETURNED`; one bell to each party in the same commit; the control untouched. If the plan end passes without placing it, plan-end settlement refunds it (SU-79).

**Aftermath:** H1's allocate tray "Plan total" shows the session as placeable again; B1's view explains it was returned.

## SW-14 — Parked consultation deadlines: whichever comes first `[sweep]`

**Why it matters:** CO-89/CO-90 assert the cancel and the strike; the two clocks must each trigger on their own.

**Setup:** two parked consultations (CO-87 shape). P-A: park 7 days + 1 h ago, original session 5 days in the future. P-B: park 2 days ago, original session start 49 h in the past. Control P-C: park 6 days ago, original start 47 h ago. Owner-approved shifts (the declined proposal's `resolvedAt` for the park time; the released row's original start).

**Steps:** NEEDS-OWNER-RUN `expire-stale-requests`; run again.

**Expect:** P-A and P-B `CANCELLED` with a full refund under `parked-consultation:<consultationId>:<paymentId>`, the released rows closed and tombstoned (`deletedAt` set, as the cancel door does), every participant `CANCELLED`, the booking's chat access revoked after the commit, the buyer told "Your payment is being refunded in full."; P-C untouched. A strike only where the expert started the move (CO-90). Run 2: nothing new.

**Probe further:** a parked booking whose payment already owes another door's partial refund waits (the code throws `ParkedRefundHeldError`); if you can build that shape, record that it's skipped and reported, not cancelled.

## SW-15 — An unanswered proposal lapses and restores, or reports when it can't `[sweep]`

**Why it matters:** CO-55 / TR-26 assert the restore; this case covers the branch where the original time was taken meanwhile.

**Setup:** two consultee proposals waiting on H1 (CO-47 shape). For proposal B, book the original time for another buyer (B3, Mock Pay) while it's open, so the restore would overlap. Owner-approved: both proposals' `expiresAt` to 1 minute ago.

**Steps:** NEEDS-OWNER-RUN `reschedule-proposals`; run again.

**Expect:** A `EXPIRED` with reason "Proposal lapsed without an answer"; original time restored; both parties told. B `EXPIRED` **without** restore: its slots stay released for H1 to re-place, and the miss is reported (record where: SystemEvent, ops queue). No overlap (R-05 zero rows). Run 2: no change. Expiry was set at creation as `min(created + 72 h, earliest released session − 24 h)`; record both proposals' original `expiresAt` to confirm.

**Aftermath:** B's booking now has no time: what do B's buyer and H1 see? This is the parked shape (CO-87): the next sweep owner is SW-14.

## SW-16 — Waitlists and backup interest lapse once their event or window passes `[sweep]`

**Why it matters:** stale "notify me" entries send notices for seats or times that no longer exist.

**Setup:** B4 on a sold-out webinar's waitlist (WE-22) and any QA backup-interest entry on a busy window (if the product offers "notify me if this frees up" on the booking page; record). Owner-approved: move the webinar's start into the past (or wait until it passes) and age the backup interest past its window.

**Steps:** NEEDS-OWNER-RUN `expire-stale-requests`.

**Expect:** both entries lapse (record status columns); no "a seat opened" or "a time opened" notice after the lapse. Record what B4 sees on the webinar page afterwards.

## SW-17 — Plan-week nudges reach the expert once per open week `[sweep]`

**Why it matters:** SU-52 asserts a nudge exists; it must not repeat every tick.

**Setup:** B1's weeks plan with week 1 full and week 2 now open with sessions left to place (shift `schedulingPeriodStartsAt` back 7 days, owner-approved, keeping H1's existing sessions valid).

**Steps:** NEEDS-OWNER-RUN `expire-stale-requests` twice.

**Expect:** one bell + one email to H1 naming the open week (the dedupe key covers the plan and week) linking to `…/requests?type=subscription`; run 2 sends nothing. The reminder goes out on the week's first day (from 09:00 in H1's zone), the next day and the third, for every plan, including one whose first week was placed with Auto: no plan skips the first day. A plan with a move in flight (a tentative row) gets no nudge. A plan never scheduled is the 48-h cohort's (SW-11), not this one's.

**Probe further:** the nudge's week summary is in H1's zone (`formatInTimeZone(now, zone, …)`)? Does it say how many sessions are left and by when?
