# High Traffic & Ops

## Context

Public availability APIs, checkout locks, consultant-level auto-allocate serialization, GitHub Actions crons (tentative cleanup, expire requests, auto-complete, reconcile), and a large race-test suite. Performance open items include availability caching (#309) and pool pressure (#368).

## Known gaps / bugs

- Availability caching incomplete — hot consultant pages can hammer DB.
- Auto-allocate lock is consultant-global — celebrity consultants become single-file queues.
- Cron granularity (2h tentative cleanup) leaves abandoned holds during campaigns.
- Reconcile incomplete scope — silent double-booking residue possible.
- Observability for `CONFIRMATION_BLOCKED_DOUBLE_BOOKING` may lack a first-class ops dashboard.

## Unhappy paths & user psychology

- Launch-day webinar: site “works” but 503 on event checkout when Redis blips — users blame Familiarise not Redis.
- Consultant calendar looks free while tentatives hold seats for hours — they overbook manually elsewhere.
- Ops discovers double-booking via angry tweet, not reconcile alert.

## Questions (handled?)

1. **Celebrity consultant strategy under lock contention?**  
   - A) Shard locks by day/slot  
   - B) Accept queue; show wait UX  
   - C) Pre-sell via lottery/waitlist only  

**Recommendation: A.** Shard auto-allocate locks by day/slot so celebrity consultants are not a single-file queue during spikes.
- Not B: Accepting a global queue still serializes the whole consultant and looks like “site broken” at peak.
- Not C: Lottery/waitlist-only is a growth productization detour before lock sharding fixes the bottleneck.

2. **Shorten tentative hold during campaigns?**  
   - A) Config flag per event  
   - B) Always 30–60 min for paid  
   - C) Keep 24h  

**Recommendation: B.** Always use 30–60 minute paid holds so campaign and steady-state booking share one correctness rule.
- Not A: Per-event flags invite misconfiguration exactly when flash sales need predictability.
- Not C: Keeping 24h during campaigns maximizes abandoned tentatives and false-green calendars.

3. **Ops dashboard for booking integrity?**  
   - A) First-class admin page for blocked confirms + overlaps  
   - B) Sentry-only  
   - C) Nightly email report  

**Recommendation: A.** Give ops a first-class view of `CONFIRMATION_BLOCKED_DOUBLE_BOOKING` and overlaps so loser refunds are not discovered via tweets.
- Not B: Sentry-only alerts lack the booking context support needs to act.
- Not C: Nightly email is too late for same-day paid losers still holding SUCCEEDED payments.

## High concurrency / multi-device

Traffic spikes amplify multi-device stale UI. Prefer read replicas/cache for availability; never trust cache at pay time.

## Suggested directions

Campaign runbook: raise sweeper frequency, watch Redis, pre-create webinar master slots, staff support macros for 409/503.
