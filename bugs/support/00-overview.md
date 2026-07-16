# Support — Overview

## Context

In-app `SupportTicket` with responses, attachments, internal notes, and Swiggy-style links to consultation/subscription/payment/refund entities. User and staff APIs; Novu for create/update/response. Mobile API notes in `docs/api/support-tickets-mobile.md`.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| No ticket merge/dedup for one failed payment | ✅ FIXED-BY #989 (runtime create-time reuse by `paymentId`) |
| Concurrent staff status updates last-write-wins | ✅ FIXED-BY #989 (status CAS) |
| No SLA / escalation / CSAT automation | 🟡 LEGIT-DEFERRED |
| No email-to-ticket ingestion / Zendesk bridge | 🟡 LEGIT-DEFERRED |
| Auto-refund-from-ticket unclear | 🟡 LEGIT-DEFERRED |
| Priority auto-escalation absent | 🟡 LEGIT-DEFERRED |

## Known gaps / bugs

- No SLA / escalation / CSAT automation.
- No email-to-ticket ingestion or Zendesk bridge.
- `refundId` link exists; auto-refund-from-ticket unclear.
- No ticket merge/dedup when user opens three tickets for one failed payment.
- Priority auto-escalation not evident in code.
- Concurrent staff status updates are last-write-wins (no version).

## Unhappy paths & user psychology

- User pays twice, opens two tickets + Razorpay dispute — three teams, no single owner.
- HIGH-priority ticket sits over weekend — no paging.
- Attachment upload fails on flaky mobile network — no resumable upload.
- Staff internal note accidentally non-internal — user sees raw ops language.

## Questions (handled?)

1. **Support channel strategy?**  
   - A) In-app only  
   - B) Email intake + in-app  
   - C) External helpdesk as system of record  

   **Recommendation: A.** Keep support in-app so tickets stay linked to consultation/payment entities without a second system of record.  
   - Not B: email intake adds bridge/SLA complexity before basic dedup and timers exist  
   - Not C: an external helpdesk splits ownership from Familiarise payment and booking truth  

2. **On-call for URGENT tickets?**  
   - A) PagerDuty  
   - B) Slack business hours  
   - C) Next-business-day only  

   **Recommendation: B.** Route URGENT tickets to Slack during business hours until volume and SLAs justify a paid paging stack.  
   - Not A: PagerDuty is premature before ticket volume and runbooks mature  
   - Not C: next-business-day is too slow for failed-payment panic  

3. **One payment one ticket rule?**  
   - A) Dedup by paymentId  
   - B) Allow multiples  
   - C) Auto-merge  

   **Recommendation: A.** Dedup by `paymentId` so one failed charge has one owner instead of three parallel threads.  
   - Not B: multiples recreate the pay-twice / dispute / ticket storm  
   - Not C: auto-merge is harder to get right than preventing duplicates at create  

## High concurrency / multi-device

User replies from phone while staff closes on desktop — need clear status CAS. Attachments from multiple devices should remain ticket-scoped.

## Suggested directions

Dedup by linked payment/refund. Define SLA timers even if manual at first. Keep mobile API doc current.
