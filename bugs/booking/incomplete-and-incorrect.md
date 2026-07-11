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

**Recommendation: A.** Fix #448 with session-level status so one reschedule does not flip the whole subscription to PENDING before marketing scale.
- Not B: Hiding plan PENDING in UI papers over wrong domain state consultants still see elsewhere.
- Not C: A new `rescheduleQueue` entity is speculative redesign ahead of the known bug fix.

2. **Ship IST-only and block non-IST timezones in UI until #872?**  
   - A) Hard block  
   - B) Soft warn  
   - C) Allow with disclaimer  

**Recommendation: A.** Hard-block non-IST timezones until DST columns are written — India/IST is the settlement and availability reality today.
- Not B: Soft warns still let international hours drift silently after DST (#872 deferred).
- Not C: Disclaimers do not prevent wrong confirmed slots when offsets freeze incorrectly.

3. **Wire `allocationIdempotencyKey` now or after allocate API redesign?**  
   - A) Wire immediately on PATCH allocate  
   - B) Redesign request contract first  
   - C) Rely on Redis locks only  

**Recommendation: A.** Wire `#837` immediately on PATCH allocate so double-submit allocate is covered before flash-event traffic.
- Not B: Redesigning the request contract first delays a known schema-ready bug fix.
- Not C: Redis locks alone are not enough when serverless freeze or multi-device retries remint requests.

## High concurrency / multi-device

Incomplete idempotency hurts most under double-submit and flaky networks — classic mobile behavior.

## Suggested directions

Prioritize #448 and #837 before flash sales. Keep Lemon/XFlow stubs from receiving real traffic.
