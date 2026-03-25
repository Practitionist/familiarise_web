# Tax Compliance — Marketplace Obligations (March 2026)

> Comprehensive tax, compliance, and financial infrastructure requirements for Familiarise as an Indian services marketplace. Supplements [07-tax-compliance-india.md](./07-tax-compliance-india.md).

**Last Updated**: 2026-03-19

---

## The 3 Money Flows

### Flow 1: Consultee → Platform (Checkout)

| Question | Indian Buyer | International Buyer |
|----------|-------------|-------------------|
| What do we charge? | Plan price + 18% GST | Plan price only (0% tax) |
| Which gateway? | Razorpay (domestic) | Razorpay IBT |
| What currency? | INR | INR (Razorpay converts for us) |

**Code's job**: Detect buyer country → apply correct tax → route to gateway. ✅ Built.

### Flow 2: Platform → Consultant (Payout)

| Question | Answer |
|----------|--------|
| How much do they get? | 80% of original price (before tax) |
| Do we deduct anything? | Only if we've paid them > ₹50K total this financial year (Apr–Mar) |
| How much to deduct? | 10% if they gave us their PAN, 20% if they didn't |
| Where does the deducted money go? | We deposit it to the government (not our money, not theirs — it's prepaid tax) |

**Code's job**: Track cumulative FY payments → deduct TDS if over ₹50K → send net amount to Razorpay. ✅ Built.

### Flow 3: Platform → Government (Filing)

This is NOT code — it's CA/accountant work. Our code provides the data.

---

## GST for E-Commerce Operators

### Is GST Registration Mandatory?

**YES.** Under **Section 24(ix) of the CGST Act**, every e-commerce operator (ECO) must register under GST irrespective of turnover. The normal Rs 20 lakh threshold does NOT apply.

The definition in **Section 2(45)** is broad: "any person who owns, operates or manages digital or electronic facility or platform for electronic commerce." Familiarise qualifies.

### Consultants on the Platform

Under **Notification 65/2017-C.T.**, service providers (consultants) with turnover below Rs 20 lakh are exempt from mandatory GST registration, **unless** their services fall under **Section 9(5)**.

Consulting/professional services are **NOT** in the Section 9(5) notified list (which covers only: passenger transport, accommodation, restaurant services, housekeeping). So consultants with turnover under Rs 20L don't need GST registration.

### TCS (Tax Collected at Source) — GST

| Parameter | Value |
|-----------|-------|
| TCS Rate | **0.5%** (reduced from 1% effective July 10, 2024) |
| Intra-state split | 0.25% CGST + 0.25% SGST |
| Inter-state | 0.5% IGST |
| Calculated on | Net value of taxable supplies (minus returns/cancellations) |
| Filing | **GSTR-8** by 10th of following month |
| Annual statement | By December 31 following the FY |
| Legal basis | **Section 52 of CGST Act** |

The consultant gets credit in their electronic cash ledger.

### GST on Platform Commission

| Item | Rate | SAC Code |
|------|------|----------|
| Platform commission/fees | **18%** | 9962 (retail trade services) |
| Educational services | **18%** | 999293 |

Commission invoices to consultants should use SAC 9962 for marketplace commission.

---

## TDS Obligations

### Section 194-O (TDS by E-Commerce Operator)

| Parameter | Value |
|-----------|-------|
| TDS Rate (from Oct 1, 2024) | **0.1%** (reduced from 1%) |
| Threshold (Individual/HUF) | Rs 5 lakh gross sales/year (if PAN/Aadhaar furnished) |
| Threshold (Companies/Firms/LLP) | **No threshold** — TDS from first rupee |
| No PAN/Aadhaar rate | **5%** (per Section 206AA) |
| Calculated on | Gross amount (including GST, shipping charges) |
| Filing | Quarterly in **Form 26Q** (residents) or **27Q** (non-residents) |

### Section 194J (Professional Services TDS)

| Parameter | FY 2025-26 |
|-----------|-----------|
| Threshold | Rs 50,000/year per consultant |
| Rate (Professional services) | **10%** |
| Rate (Technical services) | **2%** |
| No PAN rate | **20%** |

### TDS Filing Calendar

| Due Date | Action | Form |
|----------|--------|------|
| 7th of each month | TDS deposit | Challan 281 |
| July 31 | Q1 return (Apr–Jun) | 26Q |
| October 31 | Q2 return (Jul–Sep) | 26Q |
| January 31 | Q3 return (Oct–Dec) | 26Q |
| May 31 | Q4 return (Jan–Mar) | 26Q |
| Within 15 days of quarterly filing due date | Issue TDS certificate | Form 16A |

Late filing penalty: Rs 200/day (capped at total TDS amount).

### Critical CA Question

**Do both 194-O (0.1% on gross e-commerce sales) AND 194J (10% on professional services above Rs 50K) apply simultaneously?** They are separate tax provisions (income tax vs e-commerce). Whether one supersedes the other for our specific marketplace model needs professional opinion.

---

## Section 44AD Risk

> **WARNING**: Commission/brokerage income may be excluded from Section 44AD presumptive taxation. Persons earning commission or brokerage income, or carrying on agency businesses, are specifically excluded from 44AD in some interpretations.

| Parameter | Detail |
|-----------|--------|
| Turnover limit | Rs 3 crore (if 95%+ digital receipts) or Rs 2 crore |
| Deemed profit | 6% (digital) or 8% (cash) of turnover |
| Lock-in | 5 consecutive years once opted |
| NOT available for | Companies, LLPs, persons earning commission/brokerage (debated) |

**Impact**: If a CA rules that marketplace commission income disqualifies us from 44AD, the "0% tax up to Rs 50L" advantage of Sole Proprietorship in the CFO Master Plan shrinks significantly. **This needs urgent CA verification before finalizing entity structure.**

---

## Cross-Border Payment Compliance

### FEMA Regulations

- All cross-border transactions must comply with **FEMA (Foreign Exchange Management Act), 1999**
- Must use RBI-authorized banks or payment aggregators (Razorpay qualifies)
- Export proceeds must be realized and repatriated within **9 months** from date of invoice
- Records must be kept for **5 years** (invoices, FIRA, contracts, bank advices)

### Export of Services — GST

- Export of services is **zero-rated** under IGST Act **Section 16**
- Conditions: supplier in India, recipient outside India, payment in convertible foreign exchange
- No GST charged on export value
- Exporter eligible to claim ITC refunds on inputs
- Current implementation (`currency !== "INR"` = zero-rated) is directionally correct but should add buyer location verification via billing address

### LRS (Liberalised Remittance Scheme) — For International Consultant Payouts

- Annual limit: **USD 250,000** per resident individual
- TCS threshold (from Budget 2025): **Rs 10 lakh** per FY (increased from Rs 7 lakh)
- LRS is for resident individuals, NOT for companies/partnerships/HUFs
- For a marketplace paying international consultants, use **business outward remittance through an AD bank** under normal FEMA guidelines, not LRS

### International Consultant Payouts

| Method | Speed | Cost | Notes |
|--------|-------|------|-------|
| Xflow | 1–2 days | ~1% flat, 0% FX markup | RBI PA-CB licensed, JP Morgan rails, auto eFIRA |
| Wise | 1–3 days | ~1.6–1.7% + $2 | Good UI, mid-market FX rate |
| PayPal | 1–3 days | Up to 4.4% + FX markup | Widest reach, highest cost |
| Payoneer | 2–5 days | 2% FX markup | Popular for freelancer payouts |
| SWIFT/Wire | 3–7 days | Rs 1,000+ per transfer | Costliest, most traditional |

For Section 195 TDS on payments to non-resident consultants, rates vary by DTAA (Double Taxation Avoidance Agreement). Requires 15CA/15CB certificates for outward remittances.

---

## Payment Aggregator License

### Does Familiarise Need One?

**Almost certainly NO**, as long as we use a licensed PA (Razorpay) rather than directly handling payment flows.

| Scenario | PA License Needed? |
|----------|-------------------|
| Use Razorpay to collect payments, they settle to our account | **No** — we are a merchant |
| Use Razorpay Route to split payments to sellers | **No** — Razorpay is the PA |
| Collect payments into our own pool/escrow and distribute | **Possibly YES** |
| Directly handle card data or bank details | **YES** |

PA license requirements (for reference): Rs 15 crore net worth at application, Rs 25 crore within 3 years, escrow account with Scheduled Commercial Bank.

---

## Mandatory Compliance Summary

### From Day 1

| Obligation | Rate | Filing |
|------------|------|--------|
| GST Registration (as ECO, no turnover threshold) | N/A | Must register before launch |
| TCS collection on net taxable supplies | 0.5% | GSTR-8 by 10th monthly |
| TDS u/s 194-O on gross e-commerce payments | 0.1% | Form 26Q quarterly |
| TDS u/s 194J on consultant payouts > Rs 50K/yr | 10% | Form 26Q quarterly |
| GST on platform commission | 18% | GSTR-1/GSTR-3B monthly |
| Export zero-rating (international buyers) | 0% | Verify buyer location |

### For International Transactions

- FEMA compliance for all cross-border payments
- Export of services = zero-rated GST (with billing address verification)
- Section 195 TDS on payments to non-resident consultants (rate per DTAA)
- 15CA/15CB certificates for outward remittances

### Annual

- GSTR-9 annual return
- Income tax return (ITR-4 if 44AD, ITR-3 otherwise)
- TDS annual statement by December 31

---

## The Jargon Decoder

| Scary Term | What It Actually Means |
|------------|----------------------|
| GST (18%) | Sales tax. We add it on top of the price for Indian buyers. |
| Zero-rated export | Fancy way of saying "no tax for international buyers" |
| TDS (Section 194J) | When we pay consultants, we hold back 10% as their prepaid income tax and send it to the government. Only kicks in after ₹50K/year. |
| PAN | Like a tax SSN. If consultant doesn't give us one, we deduct 20% instead of 10% (penalty rate). |
| eFIRC | A receipt proving we received foreign money legally. Razorpay generates this automatically. We don't write code for it. |
| LUT (Letter of Undertaking) | A form filed with GST authorities saying "we export services, don't charge us GST on those." One-time filing, not code. |
| SAC Code (999293) | Category code for "consulting services" — goes on invoices. Already hardcoded. |
| Form 26Q | Quarterly report to government: "here's all the TDS we deducted." Our admin API provides the data, CA files the form. |
| FEMA | Foreign exchange law. As long as we use Razorpay (RBI-licensed), we're compliant. Not our problem in code. |
| TCS | Tax Collected at Source — 0.5% the platform collects from supplier on behalf of government. Different from TDS. |
| Section 194-O | E-commerce specific TDS — 0.1% on gross sales. Separate from 194J. |
| PA-CB | Payment Aggregator — Cross Border license from RBI. Needed to process international payments. Razorpay has one. |

---

## Recommended Financial SaaS Stack

| Need | Recommendation | Cost | Why |
|------|---------------|------|-----|
| Accounting | Zoho Books | Rs 1,249/mo | GST-compliant, auto-reconciliation with Razorpay, TDS management, multi-currency |
| GST Filing | ClearTax or Zoho Books built-in | Varies | Auto GSTR-1/3B/8 filing, e-invoicing |
| TDS Filing | RazorpayX (auto-TDS) + ClearTax | Included/varies | RazorpayX auto-deducts/deposits TDS, generates Form 16A |
| Invoicing | Zoho Invoice (free up to 1,000/yr) or built-in | Free–low | GST-compliant invoices with SAC codes |
| Reconciliation | Razorpay Dashboard + Zoho Books sync | Included | Auto-match payments to invoices |
| International payouts | Wise Business (later) | ~1.6% per transfer | Best FX rates, API available, for paying international consultants |

### Phased Approach

1. **Pre-launch to Rs 50L revenue**: Zoho Books + RazorpayX auto-TDS + hire CA for quarterly returns
2. **Growing**: Add ClearTax for GST/TDS filing automation
3. **50+ consultants**: Consider Firmway for 26AS reconciliation

---

## Before-Launch Checklist

### ✅ Already Done

- Detect buyer country at checkout
- Charge 18% GST for India, 0% for international
- Auto-route to Razorpay for all payments
- Track buyerCountry and isInternational on Payment record
- TDS calculation (₹50K threshold, 10%/20% rates)
- TDS auto-deduction at payout time
- Consultant PAN/GSTIN collection API
- Admin TDS dashboard API
- Currency validation on discounts and referral credits
- Invoice zero-rating for international

### ⬜ Before Launch (Non-Code — You + CA)

- [ ] Get CA opinion: are we an "e-commerce operator"? (affects GST registration)
- [ ] Get CA opinion: does 44AD apply to marketplace commission income?
- [ ] Get CA opinion: do 194-O and 194J both apply simultaneously?
- [ ] File LUT with GST authorities (one-time, enables zero-rating legally)
- [ ] Activate Razorpay IBT on dashboard (KYC process with Razorpay)
- [ ] Register for GST (likely mandatory from day 1)

### ⬜ After Launch (When Volume Grows)

- [ ] EU VAT registration (only if EU sales exceed thresholds)
- [ ] Australian GST (only if AU sales > AUD 75K/year)
- [ ] International consultant payouts via Wise/Xflow
- [ ] Form 16A auto-generation for consultants (annual TDS certificate)

### 🚫 NOT Our Problem

- 1099-NEC for US consultants — we're not a US company, doesn't apply
- Withholding tax on international consultants — not required from India
- Currency conversion — Razorpay handles forex, we always deal in INR
- FEMA compliance — handled by using an RBI-licensed gateway (Razorpay)
- PA license — not needed since we use Razorpay as PA

---

## Related Documentation

- [07-tax-compliance-india.md](./07-tax-compliance-india.md) — Original tax compliance doc
- [Gateway Evaluation](../payments/gateways/gateway-evaluation-mar-2026.md) — Full gateway comparison
- [Multi-Currency Architecture](../payments/multi-currency/) — IBT, gateway auto-routing
- [11-cfo-master-plan.md](./11-cfo-master-plan.md) — Financial strategy and entity structure
