# Finances — Overview

## Context

Familiarise’s money stack is Razorpay-primary (Stripe legacy/fallback), with integer paise amounts, a double-entry ledger (`LedgerTransaction` / `LedgerEntry`), and enterprise funding paths (wallet, invoice accrual, license). Consumer checkout creates tentative bookings; webhooks confirm payment and slots. Consultant/org payouts run through RazorpayX (Path C: PG → operating account → FAA), gated by `ENABLE_LIVE_PAYOUTS`.

Canonical engineering: `docs/payments/`, `docs/enterprise/10-money-and-ledger/`, `lib/payments/`.

## Known gaps / bugs

- Live payout disbursement is feature-flagged off by default — earnings accrue without real money movement until ops flips the flag.
- Ledger and plan pricing are **INR settlement only**; display FX fields exist for international buyers but are audit cosmetics (#783).
- Phase-2 webhook side effects (earnings, notifications) sit outside the confirmation transaction — temporary inconsistency until crons heal.
- Amount mismatch on capture marks recovery flags but does not auto-refund.
- Dual TDS engines: B2B uses `lib/compliance/tds.ts` (194-O); B2C consultant path still touches deprecated `lib/payments/tax/tds-service.ts` (194J rates) — **P0** if B2C payouts go live.
- Lemon Squeezy / XFlow checkout throw `NOT_IMPLEMENTED`; webhook routes still exist.
- Day-pass product appears in Razorpay skill docs only — no Prisma model.

## Unhappy paths & user psychology

- User pays successfully, booking stays pending for minutes because `after()` crashed — they refresh, open support, try to pay again.
- Consultant sees “earnings READY” for weeks with no bank credit — trust erodes if live payouts are off without clear UI copy.
- International buyer sees USD-ish display, is charged INR via IBT, disputes the FX gap with their bank.
- Org admin books on INVOICE funding; invoice never paid; consultant earnings sit in `PENDING_TRUST` forever.

## Questions (handled?)

1. **Is Path C (operating account + RazorpayX) signed off by a CA under RBI PA Directions 2025?**  
   - A) Written CA/RBI memo before first live payout  
   - B) Ship design partners with escrow-like hold language only  
   - C) Move to Razorpay Route sub-merchants per consultant  

2. **What is the customer SLA when payment succeeds but booking confirmation lags (async webhook gap)?**  
   - A) Confirm within N minutes via sweeper + status page  
   - B) Poll client until SUCCEEDED or timeout with auto-refund  
   - C) Accept ops tickets; document “eventual confirmation”  

3. **Who owns finance reconciliation when `LedgerReconciliationReport.ok=false`?**  
   - A) On-call eng pages nightly  
   - B) Finance ops dashboard with weekly review  
   - C) Auto-open support ticket per finding  

## High concurrency / multi-device

Checkout uses `clientIdempotencyKey`, Redis locks, Serializable transactions, and webhook `eventId` dedup. Same user on two devices double-tapping pay should replay via unique key; two *different* users racing a 1:1 slot may both pay — confirmation guard blocks the loser (see booking pack). Mobile: **web checkout only** today — no native Razorpay SDK.

## Suggested directions

1. Treat finances go-live as a checklist: live payouts sandbox UTR proof, Path C memo, TDS engine unification, IRP decision, amount-mismatch runbook.  
2. Read sibling files in this folder before changing money code.
