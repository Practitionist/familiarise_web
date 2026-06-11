## Refinement of #737

This issue refines the B2C compliance audit from **#737** after a discussion that surfaced two problems with the original list:

1. **Some items don't apply** to this app's actual product model. Most importantly, "Subscription" in this codebase is a *prepaid block of N sessions over a fixed period* (`Subscription.schedulingPeriodStartsAt/EndsAt` + `cancelledAt`), not a recurring auto-debit. UPI AutoPay / e-mandate / 24-hour pre-debit / auto-renewal disclosure rules require a recurring debit and therefore **don't apply**. Including them was pattern-matching to "SaaS subscription" instead of validating against the schema.
2. **Some items were missing** that are bigger than the irrelevant ones. The biggest is **refund / chargeback tax adjustments** — when we refund or lose a chargeback, the 194O TDS already deposited and the GST TCS already collected need adjustment in the next quarter / month return. Without that, every refund silently corrupts the next filing period.

This issue (#738) is the corrected scope. **#737 stays open as the original audit record**; a banner there points here.

---

## What's Dropped from #737

| #737 Phase | Item | Why dropped |
|---|---|---|
| Phase 5 PR 5.1 | Subscription cancellation pro-ration logic | "Cancellation" in this app means "refund unused sessions of a prepaid block." That falls under the refund SLA flow (Phase 3 PR 3.2), not a separate subscription state machine. Keep a small UI item: "Request a refund mid-period" — but it routes to the refund flow. |
| Phase 5 PR 5.2 | UPI AutoPay mandate consent + 24h pre-debit cron | Requires a recurring UPI debit, which this app does not have. AFA-exemption ₹15K threshold is irrelevant. |
| Phase 5 PR 5.3 | Auto-renewal disclosure + reminder before charge | No auto-renewal in the product. |

Phase 5 in the original implementation plan therefore collapses to **one** small item: surface a "Cancel + refund" button on subscription detail page that initiates the refund flow.

---

## What's Added (Missed in #737)

### A. Refund tax adjustments (🔴 CRITICAL)

When a B2C refund executes (`lib/payments/operations/refund.ts`), three statutory adjustments are required and currently missing:

1. **194O TDS already deposited** — must be adjusted in the next quarterly Form 26Q. Per CBDT, an excess TDS deposit can be adjusted against a future deduction in the same FY (and only the same FY); cross-FY adjustments require an income-tax refund claim by the deductee. Implementation: tag the refund with the original `TDSRecord.id` and the next-quarter cron picks it up as a negative adjustment line.
2. **GST TCS already collected** (Sec 52) — must be adjusted in the next monthly GSTR-8. Per Sec 52(6), a refund issued in a month where the original supply was reported in a prior month requires a GSTR-8 amendment, not a same-month offset.
3. **GST credit note** — per CGST Sec 34, when a tax invoice was already issued and the supply is later reduced or returned, the supplier must issue a credit note that references the original invoice. The platform's invoice generator currently has no credit-note path; current refund flow only writes a negative `PaymentLeg`, which doesn't satisfy GST.

**Concrete code work:**
- `Refund` model: add `tdsAdjustmentRecordId` + `gstTcsAdjustmentBatchId` + `creditNoteId` fields
- New `CreditNote` model with sequential numbering separate from invoice numbering, FK to original `Invoice`
- Refund cascade: emit credit note + queue TDS adjustment + queue TCS adjustment in the same Prisma transaction as the negative leg
- Quarterly 26Q export: include negative-adjustment rows for refunded payments
- Monthly GSTR-8 export: include refund lines

Sources: [CBDT — TDS adjustment guidance](https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1), [CGST Sec 34 + Sec 52(6)](https://www.cbic.gov.in/htdocs-cbec/gst/cgst-act-2017-amend-finance-act-2024.pdf)

---

### B. Chargeback tax adjustments (🔴 CRITICAL)

Same as A but triggered by the gateway, not us. When Razorpay or Stripe debits us for a lost chargeback:
- The original sale's 194O TDS / GST TCS / GST output liability all need reversal
- The customer never received a "refund" via our refund flow — the money just left our account
- Code path lives in `app/api/webhooks/utils.ts:955–1104` (dispute auto-hold) but doesn't currently emit any tax adjustment

**Concrete code work:** When the dispute resolves with `LOST` status, run the same tax-adjustment cascade as a refund.

---

### C. Multi-attendee webinar / class billing (🟠 HIGH)

For 1 webinar with N attendees, each attendee is a **separate ECO transaction** with its own:
- 194O TDS calculation (cumulative against the consultant's per-FY threshold)
- GST TCS line (if consultant is GST-registered)
- Tax invoice with the attendee's name + state
- Place-of-supply derivation per attendee

The consultant gets one **aggregated payout** for the session, but the underlying tax events are per-attendee.

**Status to verify:**
- Does `Payment` get one row per attendee? (likely yes — each booking is a Payment)
- Does each Payment generate its own invoice? (likely yes via the Invoice model)
- Does TDS aggregation in `tds-service.ts` correctly sum per-consultant across all attendee payments?
- Does GSTR-8 export emit one TCS line per Payment, not per session?

Action: trace the data path for one webinar with 50 attendees and confirm the per-attendee fan-out.

---

### D. Non-resident consumer flows (🟠 HIGH)

When a consumer outside India books:
1. **Razorpay PG → PA-CB requirement.** If the consumer's card is issued outside India, this is a cross-border collection. Razorpay PG has PA-CB approval but the platform must enable cross-border merchant settings + maintain FEMA documentation per RBI Oct-2023 PA-CB circular.
2. **Zero-rated export under IGST Sec 16.** No GST collected. Invoice template must show the export marker and not split CGST/SGST. `lib/compliance/gst.ts:78–90` (the `ZERO_RATED_EXPORT` branch) handles this server-side, but check that the upstream `buyerCountry` is captured reliably from the checkout.
3. **LUT (Letter of Undertaking)** required if exporting under bond without IGST. Schema field `lutNumber` exists but no enforcement.
4. **FX rate snapshot** — Payment must record the FX rate used for INR-equivalent reporting.
5. **Invoice in foreign currency** — `OrganizationInvoice` already has `displayCurrency` + `inrEquivalentPaise`; `Invoice` (consumer) doesn't. Add the same fields.

---

### E. Non-resident consultant payouts (🟠 HIGH)

When a consultant is non-resident:
1. **Section 195 applies, NOT 194O.** Different rate, different deduction logic, different return form (27Q instead of 26Q).
2. **DTAA rate lookup** — need a treaty-rate table (already exists in `lib/compliance/dtaa-rates.json` per the org-side TDS work).
3. **Form 15CA / 15CB** required before any cross-border remittance per FEMA + Sec 195.
4. **FIRC / outward-remittance documentation.**

`lib/compliance/tds.ts` (the org-side helper) already handles non-resident derivation with DTAA. The B2C `lib/payments/tax/tds-service.ts` does not — it explicitly comments "Non-resident guard: Section 194J does not apply to non-residents" (line ~155) and just *skips* the deduction. That's wrong: it should pivot to Sec 195 + DTAA, not skip.

---

### F. Per-FY 194O cumulative tracking with the right threshold (🟠 HIGH)

The ₹5,00,000 threshold under 194O(1A) **only applies to resident individuals/HUF** with a valid PAN/Aadhaar. For:
- Partnerships
- Companies
- LLPs
- Non-residents (covered separately under Sec 195 — see E)

…there is **no threshold**. TDS withholds from rupee 1.

Current `tds-service.ts:176` applies a single threshold to all consultants regardless of entity type. Need:
- A `ConsultantProfile.taxEntityType` enum (`INDIVIDUAL` / `HUF` / `PARTNERSHIP` / `COMPANY` / `LLP` / `NON_RESIDENT`)
- Threshold-applies-yes/no logic keyed off entity type
- Migration: default existing consultants to `INDIVIDUAL` and ask them to confirm at next login (with PAN format inference as a hint)

---

### G. Razorpay payout architecture clarification (🟡 MEDIUM)

Verified during the discussion: the platform uses **RazorpayX Payouts API** (the Bulk Payouts product) — NOT Razorpay Route, NOT a nodal account. Confirmed at `lib/payments/payouts/razorpay-payouts.ts`. Flow is:

```
Consumer → Razorpay PG → platform operating account
                                   ↓
        Cron → RazorpayX Payouts API → consultant bank/UPI
```

This is two separate RBI-licensed flows (PA license for collection + RazorpayX FAA for payouts). The Sep 2025 PA Master Direction "pass-through prohibition" is specifically about **PA-side split-settlement** (where the PA sends money directly to a non-merchant). The current architecture does not do that — the PA settles to the platform (which IS the merchant), and the platform then makes a separate, regulated payout.

**Likely conclusion: the architecture is permitted under the new direction.** But this needs a CA / RBI-compliance opinion before declaring it final, because the line between "marketplace pass-through" and "merchant + separate payout" is fact-specific.

**Action:** add a one-page memo to `docs/payments/` summarizing the architecture + sourcing the PA Master Direction language + the legal opinion. Don't migrate to Route or nodal until the opinion comes back.

This **demotes #737 item #10** from "Architectural decision required" 🟠 to "Verify + document, don't migrate" 🟡.

---

### H. Refund-of-refund / partial refund tax math (🟡 MEDIUM)

When a partial refund happens:
- The 194O withholding for the original payment was on the full amount
- The refund reduces the net consultant earnings
- The TDS adjustment for the refund must be the **proportional** amount, not the full original TDS
- Same for GST TCS

`refund.ts` handles the negative-leg math correctly, but the tax-adjustment hooks (added in A above) need proportional logic, not full-reversal.

This is an edge case but real. Add unit tests covering: 50% refund → 50% of original TDS adjusted, 100% refund → full reversal.

---

## Updated Risk Matrix (Replaces #737's Matrix)

| # | Area | Severity | Source |
|---|------|----------|--------|
| 1 | TDS section + rate are wrong (live code uses 194J at 10%; correct is 194O at 0.10%) | 🔴 | #737 §1 |
| 2 | No GST TCS Sec 52 + GSTR-8 monthly | 🔴 | #737 §2 |
| 3 | DPDP consumer consent + DSAR + erasure + retention | 🔴 | #737 §3 |
| **A** | **Refund tax adjustments (194O TDS + GST TCS + credit notes)** | **🔴** | **NEW** |
| **B** | **Chargeback tax adjustments** | **🔴** | **NEW** |
| 5 | Grievance Officer + 48h/30-day SLA | 🟠 | #737 §4 |
| 6 | Place-of-supply state capture at B2C checkout | 🟠 | #737 §5 |
| 7 | Form 26Q automation | 🟠 | #737 §6 |
| **C** | **Multi-attendee webinar/class billing semantics** | **🟠** | **NEW** |
| **D** | **Non-resident consumer flows (PA-CB, IGST Sec 16, LUT, FX)** | **🟠** | **NEW** |
| **E** | **Non-resident consultant payouts (Sec 195 + DTAA + 15CA/CB + 27Q)** | **🟠** | **NEW** |
| **F** | **Per-FY 194O cumulative with right threshold by entity type** | **🟠** | **NEW** |
| 11 | Refund SLA (7-14 days) | 🟡 | #737 §9 |
| 12 | Chargeback evidence-submission UI | 🟡 | #737 §10 |
| **G** | **Razorpay PA architecture: verify + document, don't migrate** | **🟡** | **NEW (demoted from #737 §10)** |
| **H** | **Partial refund proportional tax math** | **🟡** | **NEW** |
| 13 | HSN code selection (999293 vs 999299) | 🟡 | #737 §11 |
| 14 | Consultant GST registration enforcement | 🟡 | #737 §12 |
| 16 | EL / 206AB / 206C(1H) cleanup | 🟢 | #737 §13 |
| ~~9~~ | ~~Subscription pro-ration~~ | ~~🟠~~ | **DROPPED — N/A to prepaid model** |
| ~~9.2~~ | ~~UPI AutoPay mandate consent~~ | ~~🟠~~ | **DROPPED — no recurring debit** |
| ~~9.3~~ | ~~Auto-renewal disclosure~~ | ~~🟠~~ | **DROPPED — no auto-renewal** |

---

## Updated Implementation Plan

Phases re-ordered so refund/chargeback tax adjustments (the largest discovered gap) land alongside the TDS/TCS work, since they share the same plumbing.

### Phase 1 — Production bug fixes (1 week)
*Same as #737 Phase 1*
- [ ] PR 1.1 — Reconcile TDS section to 194O at 0.10%; threshold ₹5L for resident individuals/HUF only; 5% no-PAN fallback
- [ ] PR 1.2 — `consumerStateCode` capture at B2C checkout
- [ ] PR 1.3 — HSN per appointment type (999293 / 999299)
- [ ] **PR 1.4 (new)** — Per-FY 194O entity-type threshold logic (Item F). Tied to PR 1.1.

### Phase 2 — Statutory filings + tax adjustments (3 weeks, was 2)
- [ ] PR 2.1 — GST TCS Sec 52 collection + monthly GSTR-8 CSV export
- [ ] PR 2.2 — Form 26Q FVU export + Form 16A PDF + email
- [ ] **PR 2.3 (new, was 2.3 architecture spike)** — Refund tax-adjustment cascade (Item A): `Refund` adjustment hooks + `CreditNote` model + GSTR-8 amendment lines + 26Q negative-adjustment lines + proportional math (Item H)
- [ ] **PR 2.4 (new)** — Chargeback tax-adjustment hook on dispute LOST (Item B)
- [ ] **PR 2.5 (new, was 2.3 architecture spike, demoted)** — Razorpay PA architecture memo (Item G) — *no migration, just CA/legal opinion + doc*

### Phase 3 — Consumer Protection (1 week)
*Same as #737 Phase 3*
- [ ] PR 3.1 — Grievance Officer page + `Grievance` model + 48h/30-day SLA
- [ ] PR 3.2 — Refund SLA `targetCompletionDate` + cron
- [ ] PR 3.3 — Chargeback evidence-submission UI

### Phase 4 — DPDP consumer layer (3 weeks)
*Same as #737 Phase 4*

### Phase 5 — Subscriptions (collapsed to 0.5 days)
- [ ] PR 5.1 — UI button on subscription detail page: "Cancel & request refund" → routes to refund flow with pro-rata of unused sessions. **No** mandate logic, **no** auto-renewal disclosure.

### Phase 6 — Cross-border (was Phase 6 in #737, expanded)
- [ ] PR 6.1 — Non-resident consumer flow (Item D): `Payment.buyerCountry` + IGST zero-rating verification + LUT enforcement + FX-rate snapshot + foreign-currency invoice template
- [ ] PR 6.2 — Non-resident consultant payouts (Item E): pivot from 194O to Sec 195 + DTAA + Form 15CA/CB linkage + 27Q export
- [ ] PR 6.3 — Multi-attendee webinar/class verification (Item C): trace data path + add per-attendee tax tests

### Phase 7 — Consultant onboarding (1 week)
*Same as #737 Phase 6*

### Phase 8 — Cleanup (0.5 days)
*Same as #737 Phase 7*

**Total estimate: ~10 weeks** (up from #737's 9 weeks; the dropped subscription phase is offset by the larger refund-tax + non-resident phases).

---

## Open Questions for the Discussion

1. **Consultant GST registration policy** (Item 14 from #737, kept): does the platform onboard unregistered consultants and absorb the operational complexity (no TCS collection on their supplies, but Sec 24(x) still mandates platform GST registration), or block them at onboarding? This is a product decision, not just a code change.
2. **Cross-border consumer roadmap**: Phase 6 PR 6.1 work is wasted if the platform won't accept non-IN consumers in v1. Worth scoping the answer before building.
3. **Consultant entity-type self-declaration UX** (Item F): force at next login, or progressive disclosure?

---

## Acceptance Criteria

A B2C transaction can be onboarded, completed, refunded, OR charged-back without:
- Over-withholding TDS (correct section + rate + threshold per entity type)
- Missing GST TCS that the consultant later finds absent from their GSTR-2B
- The platform's next 26Q / GSTR-8 silently corrupted by an un-adjusted refund or lost chargeback
- A multi-attendee webinar mis-aggregating per-attendee tax events
- A non-resident consumer being mis-charged GST or a non-resident consultant being mis-withheld
- A consumer being unable to find the Grievance Officer
- A consumer being unable to delete their account / export their data

---

## Out of Scope

Same as #737:
- Live RazorpayX / Stripe Connect payouts (PR-3 epic)
- Live ClearTax IRP (#681)
- Multi-leg refunds for B2B legs (#716)
- Stream.io org-scoping (#674)
- Enterprise overage redesign (#715)

---

*Refines #737 after applicability discussion 2026-05-02. References same regulatory sources as #737 (Section 194O, GST Sec 52, DPDP Rules 2025, Consumer Protection E-Commerce Rules 2020, RBI PA Master Direction Sep 2025) — see #737 References section.*
