# Billing, Seats & SSO

## Context

Programs: LICENSED_SEAT and CREDIT_POOL. Seats aggregate into billing subscriptions; wallet prepaid with conditional debit; INVOICE accrual + dunning; LICENSE utilization metering. Unverified orgs capped (5 seats, invoice limits). SSO: domain claims, enforceSSO, JIT join, SCIM Users API. Verification loop: PENDING_VERIFICATION → admin verify.

## Known gaps / bugs

- Wallet auto-top-up: schema + notify-only cron — **no money moves** (#777).
- `ENABLE_DUNNING_SUSPEND` off — orgs may linger unpaid while still booking.
- Host economics / 3-way split behind `ENABLE_HOST_ORGS`.
- SCIM docs drift vs live `/scim/v2/**`.
- PERSONAL funding reimbursement nuances (#714) incomplete product story.

## Unhappy paths & user psychology

- Finance expects auto-recharge like AWS; gets Slack/email only; bookings fail mid-workshop.
- Employee SSO login creates LEARNER; they expected EXPERT access — defaultRole misconfigured.
- Seat count hits cap during HR bulk onboard — partial success confusion (bulk 405).

## Questions (handled?)

1. **Razorpay mandate auto-top-up timeline (#777)?**  
   - A) Build before enterprise GA  
   - B) Manual top-up OK for design partners  
   - C) Invoice-only customers; wallet secondary  

2. **Dunning auto-suspend default on for enterprise tier?**  
   - A) On after 3 reminders  
   - B) Manual suspend only  
   - C) Soft-block new bookings; keep existing  

3. **SCIM — beta allowlist or public?**  
   - A) Update docs; allowlist customers  
   - B) Feature flag off by default  
   - C) Keep 405 for write until certified  

## High concurrency / multi-device

Wallet debit and seat adjust are race-safe. SSO JIT + invite accept concurrently for same email need membership uniqueness. Multi-device SSO login bumps session expectations.

## Suggested directions

Honest UI for auto-top-up (“notify only”). Decide SCIM status and fix docs.
