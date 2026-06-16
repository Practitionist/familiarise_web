## Summary

The 2026-05-02 enterprise-readiness audit (`ENTERPRISE_PRODUCTION_GRADE_CHECKLIST_2026_05_02.md`, `ENTERPRISE_READINESS.md`) covered the B2B / org-sponsored side comprehensively. **B2C compliance — the consumer marketplace side — was not audited at the same depth.** This issue is the equivalent audit for consumer-side payments, payouts, refunds, disputes, invoices, subscriptions, and DPDP for the Consultee-pays-Consultant flow.

It surfaces **two production bugs** (wrong TDS section + stale TDS rate), several **structural compliance gaps** (no Section 52 GST TCS, no GSTR-8, no Form 26Q automation, no Grievance Officer disclosure, no DPDP consent at signup, no DSAR/erasure), and the **2025–2027 DPDP Rules phased deadlines** that bind us by **13 May 2027**.

> Sister issues: #677 (payments-subsystem master tracker), #716 (refunds/payouts/pricing epic), #715 (overage charging), #703 (Enterprise Phase 2 deferred work). This issue scopes the **B2C** layer that those don't cover.

---

## Risk Matrix

| # | Area | Severity | Type | Notes |
|---|------|----------|------|-------|
| 1 | **TDS section + rate are wrong** | 🔴 CRITICAL | Bug | Live code uses Sec 194J at 10%; correct is Sec 194O at **0.10%** (Finance Act 2024, w.e.f. 1 Oct 2024). Two files disagree. |
| 2 | **No GST TCS Section 52** | 🔴 CRITICAL | Missing | E-commerce operator MUST collect 1% TCS (0.5% CGST + 0.5% SGST or 1% IGST) on net taxable supplies of registered consultants and file GSTR-8 monthly. Not implemented. |
| 3 | **No DPDP consent at signup** | 🔴 CRITICAL | Missing | DPDP Rules 2025 (notified 13 Nov 2025) — granular purpose-limited consent required by **13 May 2027**. Currently nothing at consumer signup. |
| 4 | **No DSAR / data export / erasure for consumers** | 🔴 CRITICAL | Missing | DPDP Section 11–13 rights — access, correction, erasure, grievance, nomination. No endpoints exist. |
| 5 | **No Grievance Officer / Nodal Officer disclosure** | 🟠 HIGH | Missing | Consumer Protection (E-Commerce) Rules 2020 Rule 4(5) — name, designation, contact prominently displayed. Not present. |
| 6 | **No 48-hour acknowledgement / 30-day resolution SLA on grievances** | 🟠 HIGH | Missing | E-Commerce Rules Rule 4(5) — both timelines mandatory. No SLA tracking. |
| 7 | **No place-of-supply state capture at B2C checkout** | 🟠 HIGH | Bug | CBIC Notification 02/2023-IT + Circular 209/3/2024-GST mandates recording recipient's State for B2C inter-state services to determine IGST vs CGST/SGST. Currently relies on org context which is null for B2C. |
| 8 | **Form 26Q automation missing** | 🟠 HIGH | Missing | Schema has `TDSRecord.reportedInForm26Q` flag but no e-filing / NSDL FVU export. Quarterly returns are mandatory; Q4 FY25-26 due **31 May 2026**. Penalty ₹200/day under Sec 234E. |
| 9 | **No subscription cancellation flow + UPI AutoPay mandate consent** | 🟠 HIGH | Missing | Auto-renewal disclosure required; UPI AutoPay AFA-exempt cap is ₹15,000 for non-exempt categories (education NOT exempt); 24h pre-debit notice required (RBI 5 May 2021). |
| 10 | **RBI PA Master Direction Sep 2025: pass-through prohibition** | 🟠 HIGH | Architectural | New Master Direction removes the merchant-directed split-settlement carve-out. Must onboard each consultant as a Razorpay Route sub-merchant **OR** maintain a nodal/escrow account. Current architecture assumes the old model. |
| 11 | **No refund SLA enforcement** | 🟡 MEDIUM | Missing | Refunds work but no 7–14 day SLA tracker; E-Commerce Rules 4(11) requires "reasonable period" per RBI norms. |
| 12 | **Chargeback evidence-submission UI** | 🟡 MEDIUM | Missing | Razorpay 7-day evidence window; admin dashboard shows disputes but no upload/evidence form. |
| 13 | **HSN code: 999293 vs 999299 selection logic** | 🟡 MEDIUM | Bug | Code defaults to 999293 (consulting) but should pick 999299 for educational webinars/classes. Currently invoice renderer picks one or the other; logic appears static. |
| 14 | **Consultant GST registration enforcement** | 🟡 MEDIUM | Policy | Per Sec 24(ix), services suppliers via ECO need GST registration regardless of turnover (no goods-style waiver under Notif 34/2023-CT). Currently no GSTIN gate at consultant onboarding. |
| 15 | **Stale comment in `lib/compliance/tds.ts`** | 🟢 LOW | Doc | Says `"194O": 0.01` — comment looks like 1% but with the rate change should be 0.001 (0.10%). |
| 16 | **Equalisation Levy / 206AB / 206C(1H) cleanup** | 🟢 LOW | Hygiene | All three abolished by Finance Act 2024/2025. Verify no residual code paths reference them. |

---

## Detailed Findings

### 1. TDS — Section + Rate Are Wrong (🔴 CRITICAL BUG)

**File:** `lib/payments/tax/tds-service.ts:1–28`

```typescript
/**
 * TDS (Tax Deducted at Source) Service — Section 194J
 *
 * Rules:
 * - Threshold: ₹50,000/financial year (April–March)
 * - Rate: 10% with verified PAN, 20% without PAN
 * - Applies to professional/technical services (Section 194J)
 */
export const TDS_THRESHOLD_PAISE = 5_000_000;  // ₹50,000
export const TDS_RATE_WITH_PAN = 10;
export const TDS_RATE_WITHOUT_PAN = 20;
```

**What's wrong:**
- **Section 194J** applies to direct B2B professional-services contracts (e.g., a CA invoicing a corporate client). The platform is an **e-commerce operator** under Sec 194O Explanation, and consultants are **e-commerce participants**. The correct section is **194O**.
- **Rate**: 194O dropped from 1% to **0.10%** w.e.f. 1 Oct 2024 (Finance (No. 2) Act 2024). Live code uses 10% which over-withholds **100×**.
- **Threshold**: For 194O, the threshold of ₹5,00,000/FY applies only to resident **individuals/HUF** with valid PAN. Live code uses ₹50,000 (the 194J threshold).
- **No-PAN fallback**: 194O has a **special 5% override** under 206AA (not the usual 20%). Live code uses 20%.

Sources:
- [TDSMan — Section 194O TDS on E-Commerce Participants (Sep 2025)](https://blog.tdsman.com/2025/09/section-194o-tds-on-payments-by-e-commerce-operators-to-participants/)
- [ClearTax — TDS Rate Chart FY 2025-26](https://cleartax.in/s/tds-rate-chart)
- [ClearTax — TDS/TCS Changes from 1 Apr 2025](https://cleartax.in/s/tds-and-tcs-changes-from-april-2025)

**Second TDS file disagrees:** `lib/compliance/tds.ts:45` correctly identifies 194O as the default but uses the **stale 1% rate** (`"194O": 0.01`). Should be `0.001`.

```typescript
// lib/compliance/tds.ts (current)
const TDS_RATES = {
  "194O": 0.01,  // ← STALE: should be 0.001 since Oct 2024
  "194J": 0.1,
  ...
};
export const DEFAULT_SECTION = "194O";
```

**Fix:**
1. Reconcile the two TDS files. The B2C path (`lib/payments/tax/tds-service.ts`) should pivot to 194O.
2. Update rate to 0.10% (`0.001`).
3. Update threshold to ₹5,00,000 for resident individuals/HUF; flag others as 5% (no-PAN) or DTAA-rate (non-resident).
4. Migrate existing `TDSRecord` rows: their applied section was wrong. Decide whether to back-correct (refund excess withholding) or grandfather pre-fix records.

---

### 2. GST TCS Section 52 — Completely Missing (🔴 CRITICAL)

**Status:** No code references `Section 52`, `TCS`, `GSTR-8`, or `tcsCollected`.

**What's required (CGST Sec 52):** Every e-commerce operator must collect **1% TCS** on the net taxable value of consultant supplies (0.5% CGST + 0.5% SGST for intra-state, or 1% IGST for inter-state) and file **GSTR-8** by the 10th of the following month. Net = gross supplies through ECO − returns.

**Distinction from 194O:** 194O is income-tax TDS on the consultant; Section 52 is GST TCS that the platform deposits to government. **Both apply concurrently.**

**Why it matters:** Non-collection is a breach of Sec 52 + Rule 67(1) CGST Rules. Penalty: equal to the TCS not collected (Sec 122(1)(viii) CGST). Plus interest at 18% p.a. under Sec 50(3). Plus the consultant can't claim the TCS credit in their GST return — direct revenue impact for the consultant.

**Implementation:**
- Add `gstTcsCollected` field to `Payment` and `ConsultantEarnings`.
- Calculate at payment-success time: 1% of net taxable supply.
- Aggregate monthly into a `GstTcsBatch` model.
- Add GSTR-8 export (CSV in GSTN-required format).
- File via GSTN portal or auto-submit via GSP partner (ClearTax/IRIS).

Sources:
- [CBIC Rule 67 + Sec 52 CGST Act](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter11/rule67_v1.00.html)
- [ClearTax — GSTR-8 Filing](https://cleartax.in/s/gstr-8)

---

### 3. DPDP Consent + DSAR — Nothing at B2C Layer (🔴 CRITICAL)

**File checked:** `app/auth/signup/page.tsx` — no consent checkbox, no granular purpose disclosure.

**Required by 13 May 2027** (DPDP Rules 2025, MeitY G.S.R. 846(E) of 13 Nov 2025):

| Sub-requirement | What we need |
|---|---|
| Granular consent at signup | Itemised purposes (booking, payment, recordings, marketing, analytics) — each toggleable |
| Withdrawal | One-click revocation; cascade to revoke downstream processing |
| Data principal rights | Endpoints for access, correction, erasure, grievance, nomination |
| Parental consent for minors | Age gate at signup; verified parental consent for users < 18 |
| Notice in 22 scheduled languages | Beyond English — at minimum Hindi, Bengali, Tamil for our key markets |
| Retention engine | Auto-erasure per Rule 8 (3-yr inactivity for e-commerce > 2 cr users) |
| Breach notice | "Without delay" to DPB + affected users; we already have a partial 72h alert cron from Round 2 (#701 still open) |
| DPO if Significant Data Fiduciary | Designate when criteria are met |

**Phased rollout:**
- Phase 1 (immediate, done): Data Protection Board operational
- Phase 2 (by 13 Nov 2026): Consent Manager framework live
- Phase 3 (by **13 May 2027**): Substantive obligations enforceable

**Current state:** Privacy policy page exists at `app/(pages)/privacy/page.tsx` but no granular consent or rights endpoints. Org-side has `ConsentArtifact` schema (#701) but no consumer equivalent.

Sources:
- [PIB — DPDP Rules 2025 Notification](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf)
- [MeitY — DPDP Rules 2025](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa)
- [Deloitte — DPDP Rules 2025 Implementation](https://www.deloitte.com/in/en/services/consulting/about/indias-dpdp-rules-2025-leading-digital-privacy-compliance.html)

---

### 4. Consumer Protection — Grievance Officer + SLAs (🟠 HIGH)

**Status:** Mentioned in `docs/payments/international-research/04-international-refunds-disputes.md:112` and `docs/hiring/contractor-research-report.md:160` but **not implemented anywhere in `app/`**.

**Required by Consumer Protection (E-Commerce) Rules 2020:**
- **Rule 4(5)**: Appoint a Grievance Officer; display name, designation, contact details prominently. Acknowledge complaints **within 48 hours**, resolve **within 1 month**.
- **Rule 4(11)**: Refunds in "a reasonable period" (RBI norms: 7–14 days for cards, 5–7 for UPI).
- **Rule 5**: As a marketplace ECO, display seller (consultant) details — legal name, principal address, GSTIN, customer-care.

**Implementation:**
- Add `/grievance` public page with officer name + email + 48hr/30-day SLA disclosure.
- Add `app/api/grievances/route.ts` — POST creates a `Grievance` record; sends acknowledgement email within 48h via Novu.
- SLA dashboard at `/dashboard/admin/grievances` with breach alerting.
- Consultant detail page must show: legal name (or trading name), address summary, GSTIN (when registered), customer-care channel.

Source: [Consumer Protection (E-Commerce) Rules 2020 — full text](https://thc.nic.in/Central%20Governmental%20Rules/Consumer%20Protection%20(E-Commerce)%20Rules,%202020.pdf)

---

### 5. Place-of-Supply State Capture at B2C Checkout (🟠 HIGH)

**File:** `lib/payments/operations/checkout.ts` non-org path — Payment.organizationId is null and we have no consumer-state field.

**Required:** CBIC Notification 02/2023-IT + Circular 209/3/2024-GST require recording the recipient's State on every B2C invoice for inter-state online services. That State becomes the deemed place of supply, determining IGST vs CGST+SGST split.

**Implementation:**
- Add `Payment.consumerStateCode` (2-char) — captured from billing address at checkout.
- Update `lib/compliance/gst.ts:deriveGstBreakdown` call site for B2C invoices to use `consumerStateCode` instead of org's GST state.
- Update `Invoice` model + PDF renderer to display place of supply.
- Block checkout in production if state code is missing on India-resident purchases.

Source: [VJM Global — Place of Supply for Online Services to Unregistered Recipients](https://www.vjmglobal.com/blog/clarification-on-place-supply-online-services-supplied-by-suppliers-services-to-unregistered-recipients)

---

### 6. Form 26Q Quarterly Filing Automation (🟠 HIGH)

**File:** `lib/payments/tax/tds-service.ts:268, 298–312` has a `markAsReported` function that flips `reportedInForm26Q` but no FVU/NSDL export.

**Required:**
- Quarterly Form 26Q covers all non-salary TDS (194O, 194C, 194J, etc.).
- Q4 FY25-26 due **31 May 2026** (i.e. ~4 weeks from now per the conversation date).
- Penalties: ₹200/day (Sec 234E) capped at TDS amount; ₹10,000–₹1,00,000 (Sec 271H) for non-filing > 1 year.
- Form 16A within 15 days of return due date.

**Implementation:**
- Generate FVU file from `TDSRecord` rows for the quarter.
- Either submit via NSDL TIN-FC or auto-submit via GSP partner.
- Auto-generate Form 16A PDFs and email each consultant.
- Add `/dashboard/admin/tds/quarterly-returns` dashboard.

Sources: [ClearTax — Form 26Q TDS Return Filing](https://cleartax.in/s/tds-return-non-salary), [SAG Infotech — TDS Return Due Dates FY 2025-26](https://blog.saginfotech.com/due-date-filing-tds-tcs-return)

---

### 7. Subscription Cancellation + UPI AutoPay Consent (🟠 HIGH)

**Status:** `Subscription` model exists; `UpdateSubscriptionSchema` allows status updates; no cancellation flow code found, no pro-ration on cancellation, no UPI mandate consent UI.

**Required:**
- Pro-ration logic on cancellation (refund unused portion, or honour until end of billing cycle).
- Auto-renewal disclosure at signup (E-Commerce Rules + DPDP).
- UPI AutoPay: AFA-exempt limit is ₹15,000 per transaction for non-exempt categories. **Education / consulting subscriptions are NOT in the exempt category** (the ₹1,00,000 enhanced limit applies only to mutual fund SIPs / insurance / credit card). For subscriptions > ₹15,000/mo we cannot rely on UPI AutoPay; route to card e-mandate or invoice billing.
- 24-hour pre-debit notice via SMS/email/push (RBI 5 May 2021 framework).

Source: [TaxGuru — RBI Enhancement of UPI AutoPay Limits](https://taxguru.in/rbi/enhancement-limits-upi-autopay.html), [Paytm — UPI AutoPay Limit Guide 2025](https://paytm.com/blog/bill-payments/upi-autopay/upi-autopay-maximum-limit-complete-guide-2025/)

---

### 8. RBI PA Master Direction Sep 2025 — Architectural Decision (🟠 HIGH)

**Status:** Sep 15, 2025 RBI Master Direction consolidates PA-O / PA-P / PA-CB and **removes the previous "split settlement on merchant directions" carve-out**. PAs cannot directly settle into consultant accounts unless those consultants are themselves onboarded as sub-merchants.

**Two paths forward:**

**Path A (recommended, lighter):** Use **Razorpay Route** sub-merchant onboarding. Each consultant uploads PAN, Aadhaar, bank proof, business proof; Razorpay does V-CIP. Razorpay handles split settlement. **Pros**: no nodal account, no escrow license. **Cons**: per-consultant onboarding friction; Route has higher MDR.

**Path B (heavier):** Maintain a **nodal/escrow account** with an SPD bank. Receive funds, pay consultants. **Pros**: full control. **Cons**: nodal-account governance, SPD-bank relationship, treasury operations team.

**Cross-border (PA-CB):** If we onboard non-resident consultees or non-resident consultants → need PA-CB partner. Pre-funding NOT permitted.

**Decision needed before any further consultant payout work** since the architecture for Path A vs B branches differently.

Source: [RBI PA Master Direction 15 Sep 2025 (FIDC mirror)](https://www.fidcindia.org.in/wp-content/uploads/2025/09/RBI-PAYMENT-AGGREGATORS-DIRECTIONS-15-09-25.pdf), [Khaitan & Co — PA Master Directions analysis](https://www.khaitanco.com/sites/default/files/2025-10/ERGO%20-%20PA%20Master%20Directions%20-%203%20Oct%202025_0.pdf)

---

### 9. Refund SLA Enforcement (🟡 MEDIUM)

**File:** `lib/payments/operations/refund.ts` — refund creates `Refund` row with `PENDING → SUCCEEDED/FAILED` states; no timeline enforcement.

**Required:** RBI norms: 7 working days for cards, 5–7 for UPI. E-Commerce Rules 4(11): "reasonable period."

**Implementation:**
- Add `Refund.targetCompletionDate` (initiatedAt + 7 days).
- Cron sweeps `WHERE status='PENDING' AND targetCompletionDate < now` and alerts admin.
- Customer-facing page shows expected refund date.
- Razorpay/Stripe webhook closes the loop on completion.

---

### 10. Chargeback Evidence Submission (🟡 MEDIUM)

**Status:** Dispute auto-hold + admin detail page exist. No evidence-submission UI.

**Required:** Razorpay's 7-day evidence window. Currently admins would need to submit evidence directly via Razorpay dashboard, bypassing our system.

**Implementation:**
- File-upload field on `app/dashboard/admin/disputes/[disputeId]/page.tsx`.
- POST to Razorpay evidence API.
- Persist evidence URLs on `Dispute` record.

---

### 11. HSN Code Selection (🟡 MEDIUM)

**File:** `lib/pdf/invoice-renderer.tsx:179–184` — defaults to 999293 (consulting) or 999299 (education).

**Status:** Selection appears static. Should pivot on appointment type:
- 999293 (Other professional services) for CONSULTATION
- 999299 (Other education and training services NEC) for WEBINAR / CLASS / SUBSCRIPTION on educational content

Source: [GSTN HSN/SAC Code List — CBIC](https://cbic-gst.gov.in/sac-code.html)

---

### 12. Consultant GST Registration Enforcement (🟡 MEDIUM, Policy)

**Required:** Per CGST Sec 24(ix), services suppliers via ECO need GST registration regardless of turnover (unlike goods suppliers who got the Notif 34/2023-CT exception under turnover thresholds).

**Implementation:**
- GSTIN field at consultant onboarding (currently optional).
- Block plan publication if GSTIN missing (or fall-back gate to a hard cap on monthly earnings until GSTIN provided).
- Validate GSTIN format (15-char regex; later, GSTIN registry API).

This has user-experience and growth implications — flag for product review before enforcement.

---

### 13. Equalisation Levy / 206AB / 206C(1H) Cleanup (🟢 LOW)

**Status:** All three abolished:
- 2% e-commerce EL: removed by Finance (No. 2) Act 2024 w.e.f. **1 Aug 2024**.
- 6% advertisement EL: removed by Finance Act 2025 w.e.f. **1 Apr 2025**.
- Sec 206AB / 206CCA (higher TDS for non-filers): omitted w.e.f. **1 Apr 2025**.
- Sec 206C(1H) (TCS on sale of goods > ₹50L): omitted w.e.f. **1 Apr 2025**.

**Action:** grep for any residual code paths and remove. Already noted in `lib/compliance/tds.ts` header docblock as "Removed provisions (DO NOT implement)" so likely no live drift, but verify.

---

## Implementation Plan

Phased so the biggest compliance bugs land first; structural work follows; nice-to-haves last.

### Phase 1 — Production bug fixes (1 week, 1 PR per item)

- [ ] **PR 1.1**: Reconcile TDS section + rate. `lib/payments/tax/tds-service.ts` and `lib/compliance/tds.ts` agree on:
  - Default section: 194O at 0.10%
  - Threshold: ₹5,00,000/FY (residents only)
  - No-PAN fallback: 5% (NOT 20%)
  - Tests for boundary conditions; back-correct or grandfather existing records
- [ ] **PR 1.2**: Add `consumerStateCode` to Payment + checkout form; thread to GST breakdown; block checkout if missing on IN purchases. Schema migration via Supabase MCP.
- [ ] **PR 1.3**: Fix HSN code selection per appointment type (999293 / 999299).

### Phase 2 — Statutory filings (2 weeks, can parallelise PRs)

- [ ] **PR 2.1**: GST TCS Section 52 — `gstTcsCollected` fields on Payment + ConsultantEarnings; per-payment calculation; monthly aggregation; GSTR-8 CSV export.
- [ ] **PR 2.2**: Form 26Q FVU export; Form 16A PDF + email; quarterly cron runs by 7th of month following quarter end.
- [ ] **PR 2.3**: Razorpay PA architecture decision (Path A: Route sub-merchants; Path B: nodal account). Spike + RFC before code.

### Phase 3 — Consumer Protection (1 week, can land before DPDP)

- [ ] **PR 3.1**: Grievance Officer page + `Grievance` model + 48hr ack cron + 30-day SLA dashboard.
- [ ] **PR 3.2**: Refund SLA — `targetCompletionDate` field, cron alerts, customer-facing expected-refund page.
- [ ] **PR 3.3**: Chargeback evidence-submission UI on admin dispute detail page.

### Phase 4 — DPDP consumer layer (3 weeks)

- [ ] **PR 4.1**: Consent at signup — granular purpose toggles, persisted as `ConsumerConsentArtifact`, version-tagged.
- [ ] **PR 4.2**: DSAR endpoints — access (data export), correction, erasure, grievance, nomination. Account-deletion flow with cascade.
- [ ] **PR 4.3**: Retention engine — periodic purge per Rule 8; per-purpose retention windows.
- [ ] **PR 4.4**: Multilingual notices — Hindi + Bengali + Tamil at minimum (others on demand).
- [ ] **PR 4.5**: Age gate + parental consent for minors at signup.
- [ ] **PR 4.6**: DPO designation if Significant Data Fiduciary criteria met (likely once we cross 2 cr users; not urgent today).

### Phase 5 — Subscriptions + UPI AutoPay (1 week)

- [ ] **PR 5.1**: Cancellation flow + pro-ration logic + customer-facing cancellation UI.
- [ ] **PR 5.2**: UPI AutoPay mandate consent UI; 24h pre-debit notification cron (SMS/email/push).
- [ ] **PR 5.3**: Auto-renewal disclosure + reminder before charge.

### Phase 6 — Consultant onboarding compliance (1 week)

- [ ] **PR 6.1**: GSTIN field at consultant onboarding (optional initially); validation + format regex.
- [ ] **PR 6.2**: Razorpay Route sub-merchant V-CIP if Path A chosen in PR 2.3.
- [ ] **PR 6.3**: Consultant detail page displays legal name + GSTIN (when present) per E-Commerce Rules Rule 5.

### Phase 7 — Cleanup (0.5 days)

- [ ] **PR 7.1**: grep + remove residual references to Equalisation Levy / 206AB / 206C(1H).
- [ ] **PR 7.2**: Update `docs/finances/` and `docs/payments/` to reflect FY25-26 + DPDP Rules 2025 + Sep 2025 PA Master Direction.

---

## Acceptance Criteria

A B2C transaction can be onboarded and completed without:
- Over-withholding TDS (correct section + rate + threshold)
- Missing GST TCS that the consultant later finds absent from their GSTR
- The platform missing its 26Q / GSTR-8 deadlines
- A consumer being unable to find the Grievance Officer
- A consumer being unable to delete their account / export their data
- A consumer being charged for a subscription without explicit auto-renewal consent
- A B2C invoice missing place-of-supply

Each phase ships with:
- Unit tests for the new code (raise the 875-test count proportionally)
- `tsc --noEmit` clean
- DB migrations applied via Supabase MCP
- Doc updates in `docs/finances/`, `docs/payments/`, `docs/compliance/`
- Audit-log entries for every consumer-rights action

---

## Out of Scope (Linked Elsewhere)

- **Live RazorpayX / Stripe Connect payouts**: PR-3 epic
- **Live ClearTax IRP integration / accountant signoff**: PR-2 epic + #681
- **Multi-leg refunds / payout clawback**: #716
- **Stream.io org-scoping for recordings**: #674
- **Enterprise overage redesign**: #715

---

## References

| Topic | Source |
|---|---|
| Section 194O current rate | https://blog.tdsman.com/2025/09/section-194o-tds-on-payments-by-e-commerce-operators-to-participants/ |
| TDS Rate Chart FY 2025-26 | https://cleartax.in/s/tds-rate-chart |
| TDS/TCS Changes from 1 Apr 2025 | https://cleartax.in/s/tds-and-tcs-changes-from-april-2025 |
| Rule 46 — Tax Invoice | https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html |
| HSN Code Requirement | https://a2ztaxcorp.net/cbic-issued-clarification-on-gstns-tweet-hsn-code-requirement-in-gstr-1-mandatory-for-b2b-optional-for-b2c-below-%E2%82%B95-crore-turnover/ |
| Place of Supply for Online Services | https://www.vjmglobal.com/blog/clarification-on-place-supply-online-services-supplied-by-suppliers-services-to-unregistered-recipients |
| GST Sec 9(5) | https://cleartax.in/s/gst-on-notified-services-ecommerce-operators-95 |
| CBIC Circular 240/34/2024-GST | https://gstcouncil.gov.in/sites/default/files/2025-01/circular-no-240-2024.pdf |
| DPDP Rules 2025 — PIB | https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf |
| DPDP Rules 2025 — MeitY | https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa |
| DPDP Rules — Deloitte analysis | https://www.deloitte.com/in/en/services/consulting/about/indias-dpdp-rules-2025-leading-digital-privacy-compliance.html |
| Consumer Protection E-Commerce Rules 2020 | https://thc.nic.in/Central%20Governmental%20Rules/Consumer%20Protection%20(E-Commerce)%20Rules,%202020.pdf |
| RBI PA Master Direction 15 Sep 2025 | https://www.fidcindia.org.in/wp-content/uploads/2025/09/RBI-PAYMENT-AGGREGATORS-DIRECTIONS-15-09-25.pdf |
| PA Master Directions — Khaitan & Co | https://www.khaitanco.com/sites/default/files/2025-10/ERGO%20-%20PA%20Master%20Directions%20-%203%20Oct%202025_0.pdf |
| UPI AutoPay Limits | https://taxguru.in/rbi/enhancement-limits-upi-autopay.html |
| Equalisation Levy Abolition | https://www.indiafilings.com/income-tax/equalisation-levy-abolished |
| TCS 206C(1H) Removal | https://taxguru.in/income-tax/tcs-sale-goods-removed-april-1-2025-faqs.html |
| Form 26Q TDS Return | https://cleartax.in/s/tds-return-non-salary |
| TDS Return Due Dates | https://blog.saginfotech.com/due-date-filing-tds-tcs-return |
| Razorpay PA Compliance 2026 | https://razorpay.com/blog/payment-gateway-compliance/ |

---

*Generated 2026-05-02 by Claude Code via parallel codebase audit + 2025-2026 regulatory research. Cross-verified against Prisma schema, `lib/payments/`, `lib/compliance/`, `app/api/webhooks/`, and current CBDT/CBIC/RBI/MeitY publications.*
