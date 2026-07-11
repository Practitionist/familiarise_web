# Refunds & Disputes

## Context

Canonical refund path is `refundPayment()` + `applyRefundCascade()` in a Serializable transaction: Refund row, reverse payment legs (wallet, invoice accrual, referral credit), reverse booking utilization, proportional earnings clawback, ledger `REFUND` posting, GST credit note minting, TDS reversal, stamp `cascadedAt`. Disputes use a legal transition guard (`dispute-status.ts`); LOST triggers earnings reversal and chargeback accounting. Razorpay disputes are webhook-only (no list API).

Key paths: `lib/payments/operations/refund.ts`, `docs/payments/refunds-disputes/`.

## Known gaps / bugs

- Cascade is strong, but some tax adjustment rows (`TdsAdjustment` / `GstTcsAdjustment`) are documented as incompletely wired from refund in compliance shipping checklist.
- Overage member credit-back (#715) refuses some non-invoice reversals — certain refunds may block.
- Org payout already COMPLETED → clawback is not auto-recovered from consultant/org bank.
- Double-booking loser may hold a SUCCEEDED payment with tentative slot — refund may be ops-manual (#830).
- Chargeback evidence SLAs (documented ~7 days) may not be operationalized in admin UI timers.

## Unhappy paths & user psychology

- Consultee cancels inside policy window, expects instant UPI refund; gateway is “normal” refund (days) — support tickets spike.
- Consultant no-show (policy promises full refund) but no automation (#471) — refund depends on support judgment.
- Dispute opens while refund already PENDING — Serializable re-read helps, but UX shows conflicting statuses across devices.
- User files both support ticket and Razorpay dispute — two recovery paths fight each other.

## Questions (handled?)

1. **Should consultant no-show auto-trigger full refund?**  
   - A) Auto from MeetingAttendance / UNVERIFIED after SLA  
   - B) Support-only with scripted playbook  
   - C) Partial credit note + mandatory reschedule  

2. **Refund vs dispute race — which wins as product policy?**  
   - A) Dispute freezes refund UI; finance owns  
   - B) Refund completes; dispute maps to already-refunded  
   - C) Always escalate to human before either terminal state  

3. **Post-payout clawback — auto debit next earnings or legal invoice?**  
   - A) Net against next ConsultantPayout batch  
   - B) Manual collection only (current v1 leaning)  
   - C) Hold future bookings until clawback cleared  

## High concurrency / multi-device

Cancel API and payment webhook can race — CAS transitions ensure one wins. Refundable balance nets existing refunds + lost chargebacks. Two tabs submitting cancel+refund should hit appointment lock / status guards.

## Suggested directions

Publish customer-facing refund timing by method (UPI/card). Wire ops dashboards for `cascadedAt IS NULL` SUCCEEDED refunds (cron already backstops).
