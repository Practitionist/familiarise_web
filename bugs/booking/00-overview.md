# Booking — Overview

## Context

Familiarise books consultations, subscriptions, webinars, classes, and trials as 30-minute `SlotOfAppointment` atoms. Paid flows use tentative→confirmed via checkout/webhooks; request flows allocate after consultant approval. Defense in depth: Redis distributed locks, in-transaction revalidation, Postgres GiST exclusion for 1:1 confirmed overlaps, Serializable capacity recount for events.

Canonical engineering: `docs/booking/`, `utils/slotAllocation/`, `lib/payments/operations/checkout.ts`, race suite under `tests/typescript/race-conditions/`.

## Known gaps / bugs

- Happy path is mature; residual gaps: unwired `allocationIdempotencyKey`, no-show automation (#471), partial subscription reschedule status bug (#448), DST deferred (#872), incomplete reconcile detector scope, Lemon/XFlow appointment stubs.
- Docs vs code drift on cancel auth (code is stricter).
- Enterprise dunning does not yet cascade to booking suspend (#779).

## Unhappy paths & user psychology

- Calendar showed green; at pay time slot is gone — “bait and switch” feeling if messaging is weak.
- Both parties pay for same 1:1; loser charged until refund — panic and chargebacks.
- Consultant juggles phone allocate while consultee reschedules on laptop — confusing PENDING states.

## Questions (handled?)

1. **Is Redis required for correctness or optimization?**  
   - A) Treat Redis as optimization; DB is law (true for 1:1 GiST)  
   - B) Fail closed without Redis for all paid booking  
   - C) Hybrid: events fail closed, 1:1 degrade  

2. **What is the product SLA for tentative slot holds (24h + 2h cron)?**  
   - A) Shorten hold to 30–60 minutes for paid checkout  
   - B) Keep 24h; improve early release UX  
   - C) Dynamic hold by plan type  

## High concurrency / multi-device

See sibling files. Same-user multi-device booking is partially serialized via `lockConsulteeBooking`. Cross-user same-slot races are the core design problem — largely handled, refund-of-loser still soft.

## Suggested directions

Verify loser-refund automation after `#827` blocks. Wire allocation idempotency before marketing flash events.
