# Tax, GST, TDS & Invoicing

## Context

B2B enterprise tax is relatively mature: GST breakdown (`lib/compliance/gst.ts`), org invoices with sequential numbering, credit notes, MSME 43B(h) dates, TDS derivation for org payouts, IRP uploader gated by `ENABLE_IRP_UPLOADER`. B2C marketplace tax is weaker: wrong/legacy TDS path risk, GST TCS Sec 52 schema-only, place-of-supply state not captured at consumer checkout, legal docs still have placeholders elsewhere.

Key paths: `lib/compliance/`, `lib/payments/tax/`, `docs/compliance/15-india-compliance-shipping-checklist.md`.

## Known gaps / bugs

- **P0:** B2C consultant TDS may still use deprecated 194J@10% path vs required 194-O@0.1% for e-commerce operator style flows.
- GST TCS / GSTR-8 batching not wired (`GstTcsBatch` schema-only).
- Refund tax cascade incomplete for some adjustment models.
- Form 15CA/CB stub returns nulls — cross-border payouts blocked/deferred.
- IRN filing gated; ClearTax credentials required.
- HSN defaults static; webinar/class may need different codes.
- Consultant GSTIN verified as format only — no GSTN registry live check.

## Unhappy paths & user psychology

- Consultant receives payout net of “wrong” TDS; CA complains; platform reputation with experts collapses.
- Org finance team cannot download IRN-ready invoices before ₹5cr AATO threshold — still need process clarity.
- Consultee wants GST invoice for personal booking; B2C invoice story unclear vs org invoices.
- Dispute/refund after invoice issued — credit note not visible to customer.

## Questions (handled?)

1. **Consolidate TDS engines before any B2C live payout?**  
   - A) Hard cutover to `lib/compliance/tds.ts` only, CA-signed rates  
   - B) Keep dual until B2C GMV threshold  
   - C) Outsource all TDS calc to CA spreadsheet  

2. **When does GSTR-8 / TCS become launch-blocking?**  
   - A) Before first B2C payout  
   - B) After N consultants registered  
   - C) Defer with CA retainer filing manually  

3. **IRP — enable for all orgs or only above AATO?**  
   - A) Flag on for everyone with ClearTax  
   - B) PENDING IRN below threshold  
   - C) PDF-only until first audit  

## High concurrency / multi-device

Invoice numbering uses per-org counters — concurrent invoice generation must stay gapless (CGST Rule 46). Parallel refunds minting credit notes need unique constraints (`CreditNote.refundId`). Multi-admin tax settings edits should use optimistic versioning where present.

## Suggested directions

Treat tax go-live as a finance+legal gate separate from product feature flags. Unify TDS first; then TCS; then IRP.
