# Cross-Cutting — Deadlocks & Inconsistencies

## Context

Familiarise avoids classic DB deadlocks with documented Redis lock ordering (consultant/event → consultee → slot) and sorted ledger account updates. Residual pain is less “DB deadlock” and more **distributed inconsistency windows**, **doc/code drift**, and **asymmetric fail modes**.

## Known gaps / bugs

### Locking & ordering

- Lock order documented — regressions possible when new locks added without review.
- Consultation vs event Redis fail behavior asymmetric (events fail closed).
- Long Serializable txs + pool exhaustion → user-visible timeouts that look like deadlocks.
- Appointment lock TTL 5 min can block cancel/reschedule if a client dies holding intent (server lock, not client).

### Consistency windows

- Payment Phase-1 confirm vs Phase-2 earnings/notifications — temporary skew healed by crons.
- Razorpay `after()` ACK before complete — booking lag.
- Wallet cache vs ledger journal — nightly reconcile.
- Stream call exists before MeetingSession row — orphan window.
- Subscription status vs per-session slot state after partial reschedule (#448).
- Rating denormalization vs review rows.
- Novu vs Resend delivery split brain.
- SCIM/docs vs live implementation; payment critical-bugs task file vs fixed code; consent “stub” comments vs live checks.

### Dual sources of truth

- BetterAuth `Member` vs `Membership`.
- `User.role` vs org `MemberRole` (intentional but easy to misuse in UI).
- Display currency vs INR settlement.
- App validate-access vs Stream permissions.
- Legacy notification preferences vs Novu preferences.

## Unhappy paths & user psychology

- User sees “paid” email before calendar updates — books conflict elsewhere.
- Ops trusts outdated doc (“any user can cancel”) — security/process error.
- Finance trusts wallet balance UI during drift — overdraft attempts fail mysteriously.
- Two admins follow different runbooks because task files disagree with code.

## Questions (handled?)

1. **How to govern new distributed locks?**  
   - A) ADR + checklist in PR template  
   - B) Central lock registry module only  
   - C) Prefer DB constraints over new Redis locks  

2. **Accept eventual consistency for Phase-2 side effects?**  
   - A) Yes + status page + SLA  
   - B) Move earnings inside confirm txn  
   - C) Outbox pattern with visible pending  

3. **Doc drift process?**  
   - A) Docs CI check against flags/paths  
   - B) Quarterly audit only  
   - C) Delete stale task files when fixed  

4. **Unify dual truth pairs?**  
   - A) Hard deprecate BetterAuth Member fields in app logic  
   - B) Keep bridge forever  
   - C) Generate Membership from Member only  

## High concurrency / multi-device

Under spike, inconsistency windows lengthen (sweeper lag, pool wait, Stream breaker open). Multi-device users observe *different slices* of the window and conclude the system is random.

## Suggested directions

1. Outbox or explicit “pending side effects” for payment Phase-2.  
2. PR template: lock order + idempotency key + fail-open/closed choice.  
3. Monthly “doc drift” pass on flags, SCIM, payment bug register, compliance stubs.  
4. Prefer one user-visible status model for “money vs booking vs meeting” alignment.
