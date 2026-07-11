# Concurrency & Double-Booking

## Context

Three layers: (1) Redis locks (`utils/appointmentlock.ts`) with documented lock order, (2) re-validation inside transactions, (3) DB GiST `slot_no_confirmed_overlap` for confirmed 1:1 slots. Events (webinar/class) use event locks + Serializable participant recount (no exclusion constraint). Payment confirmation re-checks overlaps before flipping `isTentative=false` (#827).

## Known gaps / bugs

- Both users can still **pay**; loser stays tentative — refund may be manual (Sentry `CONFIRMATION_BLOCKED_DOUBLE_BOOKING`).
- `allocationIdempotencyKey` unwired — double PATCH allocate can still surprise.
- Reconcile script double-booking detector focuses on SUCCEEDED-payment slots; misses some unpaid overlaps.
- Class/webinar CRUD booking-existence guards run outside transaction (TOCTOU window).
- Legacy rows missing `consultantProfileId` excluded from GiST until backfilled.

## Unhappy paths & user psychology

- Two consultees refresh the last green slot; both start Razorpay; both succeed; one gets meeting, one gets silence.
- Consultant manually allocates the same slot the consultee just paid for via another path.
- Waitlisted user notified while another checkout still holds a tentative seat.

## Questions (handled?)

1. **Loser of paid double-booking — auto-refund inside webhook?**  
   - A) Auto-refund on confirmation block  
   - B) Ops runbook + alert only  
   - C) Authorize-only until confirm; capture after GiST  

2. **Should validate-then-allocate UI freeze slots client-side?**  
   - A) Soft hold token for N seconds  
   - B) No UI hold; always recheck at submit  
   - C) Optimistic UI with instant 409 recovery UX  

3. **Event last-seat: prefer 503 (Redis down) or risk unlocked recount?**  
   - A) Keep fail-closed 503  
   - B) Continue on Serializable only  
   - C) External capacity semaphore (documented but not in prod)  

## High concurrency / multi-device

20-user storm scenarios exist in tests. Under spike, expect 409/P2034 retries — clients must retry with backoff and clear “slot taken” copy. Multi-window same user: consultee lock serializes; different users contend on slot/event locks.

## Suggested directions

Make confirmation-blocked payments an automated refund path. Extend reconcile to use canonical `buildOccupiedAppointmentFilter`.
