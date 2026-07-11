# Enterprise Money — Payouts, Earnings & Trust Parking

## Context

Successful org/host flows create `OrganizationEarnings` + `ConsultantEarnings`, hold, then batch into `OrganizationPayout` / `ConsultantPayout`. `PENDING_TRUST` was meant to park payables when **unverified INVOICE sponsors** ghost. Live disbursement requires `ENABLE_LIVE_PAYOUTS`. Host split requires `ENABLE_HOST_ORGS`. This file is about **whether enterprise money-out tells the truth**.

Key: [`lib/payments/payouts/earnings-service.ts`](../../lib/payments/payouts/earnings-service.ts), [`lib/payments/payouts/org-payout-service.ts`](../../lib/payments/payouts/org-payout-service.ts), ADR `docs/enterprise/70-design-decisions/12-pending-trust-earnings-parking.md`.

## Known gaps / bugs

| ID | Severity | Issue |
|----|----------|-------|
| E-01 | **P0** | `PENDING_TRUST` scopes **host** `orgSplit.organizationId`, not sponsoring `payment.organizationId` — ghost INVOICE sponsor + ACTIVE host still accrues host share |
| E-02 | **P0** | Marketplace / consultant earnings for unverified INVOICE org bookings are **not parked** — platform can owe experts for unpaid sponsor invoices |
| E-03 | **P1** | Earnings flipped to **PAID when batch is created**, before gateway wire / COMPLETED |
| E-04 | **P1** | `ENABLE_LIVE_PAYOUTS` off → batches exist, no UTR — trust erosion if UI says paid |
| E-05 | **P2** | Org clawback after COMPLETED payout is manual; TDS org-side reversal incomplete |
| E-06 | **P2** | No RazorpayX balance pre-check before batch |
| E-07 | **P2** | Poller vs webhook reverse-status edge cases on payouts |

## Unhappy paths & multi-device psychology

- Host agency dashboard (iPad) shows READY/PAID; bank (phone) empty — founder escalates publicly.
- Unverified sponsor books ₹40k; consultant sees PENDING→READY normally; invoice never paid — Familiarise pays or fights expert.
- Two admins create payout batches on two laptops — Redis lock should serialize; loser UX unclear.
- Finance exports “PAID” earnings for auditors while payout row still PENDING — audit fail.

## Questions (handled?)

1. **Fix PENDING_TRUST scope before any INVOICE sponsor GA?**  
   - A) Park consultant + correct sponsor org id; or block checkout until ACTIVE/KYB  
   - B) Keep current host-scoped park  
   - C) Rely on ₹50k cap only  

**Recommendation: A.** Mis-scoped park is an existential balance-sheet bug for enterprise respect.  
- Not B: Current behavior does not match ADR intent.  
- Not C: Cap limits size, not wrong payables.

2. **When to mark earnings PAID?**  
   - A) Only on payout COMPLETED + UTR  
   - B) At batch creation (current)  
   - C) Intermediate status `BATCHED` then `PAID`  

**Recommendation: C (or A).** Introduce `BATCHED`/`IN_FLIGHT` so UI never lies; `PAID` only after wire.  
- Not B: “Paid” before cash is how enterprise trust dies.  
- A alone may be enough if batch UI uses non-PAID labels.

3. **Live payouts go-live coupling?**  
   - A) With HOST flag + Path C CA memo + sandbox UTR  
   - B) Enable anytime for consultant-only  
   - C) Stay manual bank forever  

**Recommendation: A.** One runbook: host split + live payouts + CA Path C + UTR proof.  
- Not B: Consultant-only still needs trust parking + TDS correctness.  
- Not C: Manual does not scale past design partners.

## High concurrency / multi-device / spikes

Batch creation uses Redis org lock + Serializable + idempotency keys — solid under multi-admin. Spike risk is **semantic falsehood (PAID)** and **wrong park scope**, not double-disburse (when live). Weeklies under load should pre-check FAA balance.

## Suggested directions

1. Re-implement PENDING_TRUST against `payment.organizationId` + park `ConsultantEarnings`.  
2. Rename/split PAID vs BATCHED.  
3. Dual-flag go-live runbook before host agency sales.
