# B2C vs B2B Compliance Gaps

## Context

Enterprise rail: org tax info, invoices, credit notes, MSME alerts, org payout TDS, audit export. Marketplace rail: consultant verification (manual), PAN encryption, payout tax fields — but filing automation and TCS lag. Shipping checklist grades MUST vs DEFER in `docs/compliance/15-india-compliance-shipping-checklist.md`.

## Known gaps / bugs

- Dual TDS engines (#778 planned consolidation).
- No GSTR-8 aggregator job.
- Refund tax adjustment wiring gaps.
- Seller disclosure (legal name, address, GSTIN on public profiles) incomplete for e-commerce rules.
- RBI PA Path C needs legal confirmation (finance pack).
- Form 26Q/140 automation missing before quarterly deadlines.

## Unhappy paths & user psychology

- Registered consultant expects platform TCS handling; receives notice from GSTN.
- Org customer audits Familiarise; finds B2C gaps and extrapolates risk to B2B.

## Questions (handled?)

1. **Block B2C payouts until 194-O unified + TCS plan?**  
   - A) Hard block  
   - B) Soft warn + CA escrow  
   - C) Proceed with documented risk acceptance  

**Recommendation: A.** Unify TDS before B2C payouts — wrong 194-O path is not acceptable risk at scale.  
- Not B: Soft warn still pays out on the wrong engine.  
- Not C: Documented risk acceptance does not fix GSTN notices to consultants.

2. **Public seller disclosure minimum on consultant profile?**  
   - A) Legal name + address + GSTIN if registered  
   - B) Display name only  
   - C) Disclosure only at checkout  

**Recommendation: A.** E-commerce seller disclosure belongs on the public profile, not only at payment.  
- Not B: Display name alone fails consumer disclosure expectations.  
- Not C: Checkout-only disclosure is easy to miss and weak for trust/browse.

3. **Who files quarterly TDS returns?**  
   - A) In-house automation  
   - B) CA retainer  
   - C) Hybrid export + CA upload  

**Recommendation: C.** Hybrid export + CA upload is the realistic interim until Form 26Q automation is trustworthy.  
- Not A: Full in-house automation is not ready before quarterly deadlines.  
- Not B: CA-only without clean exports recreates spreadsheet chaos.

## High concurrency / multi-device

N/A beyond payout/invoice races covered in finances.

## Suggested directions

One compliance owner for the shipping checklist sign-off slots.
