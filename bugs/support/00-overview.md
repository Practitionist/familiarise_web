# Support — Overview

## Context

In-app `SupportTicket` with responses, attachments, internal notes, and Swiggy-style links to consultation/subscription/payment/refund entities. User and staff APIs; Novu for create/update/response. Mobile API notes in `docs/api/support-tickets-mobile.md`.

## Known gaps / bugs

- No SLA / escalation / CSAT automation.
- No email-to-ticket ingestion or Zendesk bridge.
- `refundId` link exists; auto-refund-from-ticket unclear.
- No ticket merge/dedup when user opens three tickets for one failed payment.
- Priority auto-escalation not evident in code.
- Concurrent staff status updates are last-write-wins (no version).

## Unhappy paths & user psychology

- User pays twice, opens two tickets + Razorpay dispute — three teams, no single owner.
- HIGH priority ticket sits over weekend — no paging.
- Attachment upload fails on flaky mobile network — no resumable upload.
- Staff internal note accidentally non-internal — user sees raw ops language.

## Questions (handled?)

1. **Support channel strategy?**  
   - A) In-app only  
   - B) Email intake + in-app  
   - C) External helpdesk as system of record  

2. **On-call for URGENT tickets?**  
   - A) PagerDuty  
   - B) Slack business hours  
   - C) Next-business-day only  

3. **One payment one ticket rule?**  
   - A) Dedup by paymentId  
   - B) Allow multiples  
   - C) Auto-merge  

## High concurrency / multi-device

User replies from phone while staff closes on desktop — need clear status CAS. Attachments from multiple devices should remain ticket-scoped.

## Suggested directions

Dedup by linked payment/refund. Define SLA timers even if manual at first. Keep mobile API doc current.
