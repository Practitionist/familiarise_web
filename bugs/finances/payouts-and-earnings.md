# Payouts & Earnings

## Context

Successful payments create `ConsultantEarnings` / `OrganizationEarnings` (platform fee share, hold period, refund clawback fields). Weekly crons batch READY earnings into `ConsultantPayout` / `OrganizationPayout` with unique idempotency keys, then submit via RazorpayX or Stripe Connect when `ENABLE_LIVE_PAYOUTS=true`. TDS (194-O) and MSME `mustPayByDate` attach at payout time. Path C intentionally avoids Route sub-merchant splits.

Key paths: `lib/payments/payouts/`, jobs under `.github/workflows/*payout*`.

## Known gaps / bugs

- **P0/ops:** live gateway submission gated — without the flag, rows freeze PROCESSING/PENDING and consultants never get money.
- Non-resident consultants blocked — Section 195 TDS not implemented.
- Org Stripe Connect payout deferred; org clawback after COMPLETED payout is manual recovery in v1.
- GST TCS fields exist on earnings/payment; collection deferred pending CA (#780).
- Form 26Q / TRACES artifacts largely schema-only (#738).
- INVOICE-funded org bookings park earnings in `PENDING_TRUST` until org KYB/payment trust — can stall forever without policy.

## Unhappy paths & user psychology

- Consultant completes sessions, dashboard shows READY, bank empty — they churn or threaten chargeback on prior customer payments.
- Two admins approve overlapping payout batches — mitigated by batch lock + idempotency keys, but UI may not show “another batch in flight.”
- Refund arrives after payout COMPLETED — clawbackAmount grows; finance must chase consultant/org manually.
- MSME vendor expects 45-day payment; cron alerts exist but no auto-prioritization of MSME queues in product UX.

## Questions (handled?)

1. **Go-live plan for `ENABLE_LIVE_PAYOUTS`?**  
   - A) Sandbox UTR reconcile → limited cohort → full prod with kill switch  
   - B) Keep manual bank transfers until GMV threshold  
   - C) Switch architecture to Route splits before enabling FAA  

**Recommendation: A.** Prove sandbox UTRs, then design-partner cohort, then full prod with a kill switch — the only safe way to flip `ENABLE_LIVE_PAYOUTS`.
- Not B: Manual bank transfers do not exercise idempotent RazorpayX batching and hide production failure modes.
- Not C: Redesigning onto Route before FAA delays payouts and abandons Path C without a CA-driven reason.

2. **What happens when INVOICE org never pays — force clawback, write-off, or suspend booking?**  
   - A) Auto-suspend org after dunning stage 3 (`ENABLE_DUNNING_SUSPEND`)  
   - B) Earnings stay PENDING_TRUST indefinitely (ops review)  
   - C) Platform absorbs and invoices org legally  

**Recommendation: A.** After dunning stage 3, auto-suspend the org so unpaid invoice funding cannot keep creating `PENDING_TRUST` earnings forever.
- Not B: Indefinite PENDING_TRUST strands consultants and never forces org payment.
- Not C: Platform absorption turns Familiarise into the bad-debt party for unpaid B2B bookings.

3. **Non-resident / Section 195 timeline before international consultants?**  
   - A) Block non-resident until Form 15CA/CB live  
   - B) Manual CA process outside product  
   - C) Only allow INR-resident consultants at launch  

**Recommendation: C.** Launch with INR-resident consultants only until Section 195 / Form 15CA/CB is productized — India settlement first.
- Not A: “Block until 15CA/CB” still invites half-built intl onboarding UI and support exceptions.
- Not B: Manual CA outside product does not scale and will be bypassed under sales pressure.

## High concurrency / multi-device

Payout batch creation uses distributed locks; webhook status updates use CAS terminal guards. Concurrent admin clicks on “process payouts” should no-op via idempotency. Multi-device admin sessions can still race UI — server must remain source of truth.

## Suggested directions

Ship payout status copy in consultant UI that matches flag state. Require written rollback for live payouts (pause cron, reverse pending gateway calls).
