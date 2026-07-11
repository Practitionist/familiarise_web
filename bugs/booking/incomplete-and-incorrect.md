# Incomplete & Incorrect Booking Implementations

## Context

Several schema fields and docs describe intent that application code never fully wires. Others are known product bugs with issue numbers.

## Known gaps / bugs

| Item | Issue | Nature |
|------|-------|--------|
| `allocationIdempotencyKey` | #837 | Schema only — double-submit allocate |
| DST availability columns | #872 | Nullable/unwritten; frozen IST offset |
| No-show automation | #471 | UNVERIFIED proxy only; support ticket type exists |
| Partial subscription reschedule | #448 | Whole subscription → PENDING for one session |
| Reschedule API `slotIds[]` | Partial | Fragile vs session-based mental model |
| `sessionsAwaitingReschedule` | Planned | No DB counter |
| Paid trial fields | Partial | `pendingPaymentUrl` / payment wiring follow-up |
| Lemon/XFlow webhooks | Stub | No appointment creation |
| `acquireEventSlot` semaphore | Docs only | Not in prod code |
| Program allowlist / exclusiveEngagement | Written unread | B2B boundary stubs |
| Reconcile detector scope | Incomplete | Misses non-SUCCEEDED overlaps |
| Class/webinar CRUD guards | TOCTOU | Outside transaction |
| Dunning → booking suspend | #779 | TODO |
| Calendar external sync | Roadmap | Internal calendar only |

## Unhappy paths & user psychology

- Subscription with 47 fine sessions flips to PENDING after one reschedule — consultant thinks the whole plan broke.
- International consultant sets local hours; DST shift silently wrong after #872 still deferred.
- Trial user thinks they paid; paid-trial path incomplete — support confusion.

## Questions (handled?)

1. **Fix #448 (subscription PENDING on partial reschedule) before scale marketing?**  
   - A) Session-level status only  
   - B) Keep plan PENDING but hide noise in UI  
   - C) Separate `rescheduleQueue` entity  

2. **Ship IST-only and block non-IST timezones in UI until #872?**  
   - A) Hard block  
   - B) Soft warn  
   - C) Allow with disclaimer  

3. **Wire `allocationIdempotencyKey` now or after allocate API redesign?**  
   - A) Wire immediately on PATCH allocate  
   - B) Redesign request contract first  
   - C) Rely on Redis locks only  

## High concurrency / multi-device

Incomplete idempotency hurts most under double-submit and flaky networks — classic mobile behavior.

## Suggested directions

Prioritize #448 and #837 before flash sales. Keep Lemon/XFlow stubs from receiving real traffic.
