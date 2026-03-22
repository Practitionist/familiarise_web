# Cross-Country GST/Tax Compliance for International Operations

> **Research Date:** March 2026
> **Critical Update:** Finance Bill 2026 fundamentally changed intermediary service taxation

---

## 1. The Intermediary Question: Are You an Intermediary or Exporter?

This is the **single most important GST classification** for Familiarise's international operations.

### Definitions

**Intermediary (Section 2(13) IGST Act):**
> A person who arranges or facilitates the supply of goods and/or services or securities, between two persons, but does NOT include a person who supplies such goods and/or services on their own account.

**Export of Services (Section 2(6) IGST Act):**
> Supply of services where supplier is in India, recipient is outside India, payment in convertible foreign exchange, supplier and recipient are not establishments of the same person.

### How Courts Distinguish Them

| Factor                     | Intermediary                    | Export of Services              |
| -------------------------- | ------------------------------- | ------------------------------- |
| Contractual relationship   | Tripartite (3 parties)          | Bipartite (2 parties)           |
| Nature of supply           | Facilitates between others      | Supplies on own account         |
| Revenue model              | Commission-based                | Service fee / subscription      |
| Value addition             | Arranging/connecting            | Providing the actual service    |
| Control over delivery      | Limited                         | Full control                    |

### Where Does Familiarise Fall?

**Strong arguments for Export of Services:**
- Familiarise provides the **actual platform service** (video, chat, booking, payments)
- Consultants are **service providers on the platform**, not Familiarise's principals
- Familiarise charges a **commission on transactions it processes**
- The service (platform access) is consumed by the international user

**Risk factors for Intermediary classification:**
- Familiarise **connects** consultants with consultees (facilitating role)
- Revenue is commission-based (percentage of transaction)
- Familiarise doesn't provide the **consulting service itself**

**Key precedent (Rajasthan HC 2025):** Services rendered under a bipartite agreement (platform-to-user, without contractual relationship with third party) do NOT qualify as intermediary services. Platform services qualify as export of services.

### Practical Recommendation

Structure contracts carefully:
1. **Consultee agreement:** Familiarise provides platform services (video, booking, payment processing) to consultee
2. **Consultant agreement:** Familiarise provides marketplace access and tools to consultant
3. **Avoid:** Positioning Familiarise as "connecting" or "facilitating" between two parties in contractual language

---

## 2. Finance Bill 2026: Game-Changing Reform

### What Changed

**Section 13(8)(b) of IGST Act -- DELETED**

Previously, this section deemed the place of supply for intermediary services as the **location of the supplier** (India), meaning:
- Indian intermediaries paid 18% GST on services to foreign clients
- Could NOT claim zero-rating as exports
- Could NOT get ITC refunds
- Created Rs 3,300 crore in pending litigation

### New Rule (Effective 2026)

Place of supply for intermediary services now follows **Section 13(2) -- location of the recipient**:
- Services to foreign clients = **export of services** (zero-rated)
- Services to Indian clients = taxable at 18%
- ITC refunds now available on export-related inputs
- Resolves massive pending litigation

### Impact on Familiarise

| Scenario                           | Before Finance Bill 2026 | After Finance Bill 2026        |
| ---------------------------------- | ------------------------ | ------------------------------ |
| International consultee pays       | 18% GST (if intermediary)| Zero-rated (export)            |
| ITC on SaaS costs for exports      | Blocked                  | Refundable                     |
| Platform commission (intl)         | GST applicable           | Zero-rated                     |
| Platform commission (domestic)     | 18% GST                 | 18% GST (unchanged)           |

**Bottom line:** Even if Familiarise is classified as an intermediary, international services are now zero-rated. This dramatically reduces the risk.

---

## 3. E-Commerce Operator TCS Obligations

### GSTR-8: Tax Collected at Source

| Provision                    | Rate                     | Notes                          |
| ---------------------------- | ------------------------ | ------------------------------ |
| TCS on net value of supplies | 0.5% (reduced from 1%)  | Effective from July 2024       |
| Split                        | 0.25% CGST + 0.25% SGST | Interstate = 0.5% IGST         |
| Filing                       | Monthly GSTR-8           | Due by 10th of next month      |
| Registration                 | Mandatory regardless of turnover | Section 24 CGST Act   |

### When Does TCS Apply?

TCS applies when you are an **e-commerce operator** who:
1. **Collects payment** on behalf of suppliers (consultants)
2. **Owns or manages** the electronic platform
3. Facilitates supplies through your platform

### TCS Calculation Example

```
Consultee pays: Rs 1,000 for a session
Platform commission (10%): Rs 100
Consultant share: Rs 900

TCS @ 0.5% on net value (Rs 1,000): Rs 5
  - CGST TCS: Rs 2.50
  - SGST TCS: Rs 2.50 (or IGST Rs 5 for interstate)

Consultant receives: Rs 900 - Rs 5 (TCS) = Rs 895
(Consultant claims TCS credit in their GST return)
```

### International Transactions and TCS

**Open question:** Does TCS apply when the supplier (consultant) is outside India?

- TCS is meant for supplies made **through** the e-commerce operator
- If consultant is non-resident, they may not have Indian GST registration
- Practical approach: Apply TCS only for Indian consultants; for international, treat as export/import

---

## 4. GST on International Buyers

### When Charging International Customers

| Scenario                              | GST Treatment              |
| ------------------------------------- | -------------------------- |
| International buyer, payment in forex | Zero-rated (export)        |
| International buyer, payment in INR   | May need GST (not export)  |
| NRI with Indian address               | Domestic GST applies       |
| Indian buyer, consultant abroad       | Domestic GST applies       |

### Export Conditions (All Must Be Met)

1. Supplier located in India (Familiarise = yes)
2. Recipient located outside India (verified by address/IP)
3. Payment in convertible foreign exchange (not INR)
4. Supplier and recipient are NOT establishments of same person
5. Place of supply is outside India

### Practical Implementation

```typescript
// Simplified logic for GST determination
function shouldChargeGST(buyer: BuyerInfo): boolean {
  if (buyer.country !== 'IN' && buyer.paymentCurrency !== 'INR') {
    return false; // Export - zero rated
  }
  return true; // Domestic - charge GST @ 18%
}
```

**Enhancement needed:** Verify buyer location via billing address, not just currency.

---

## 5. GST Filing Requirements Summary

### Monthly Filing (If E-Commerce Operator)

| Return   | Due Date    | Purpose                              |
| -------- | ----------- | ------------------------------------ |
| GSTR-1   | 11th        | Outward supply details               |
| GSTR-3B  | 20th        | Summary return + tax payment         |
| GSTR-8   | 10th        | TCS details (e-commerce operator)    |

### Annual Filing

| Return   | Due Date    | Purpose                              |
| -------- | ----------- | ------------------------------------ |
| GSTR-9   | Dec 31      | Annual return                        |
| GSTR-9C  | Dec 31      | Reconciliation (if turnover > Rs 5Cr)|

### RCM on Foreign SaaS (When GST-Registered)

Must self-assess and pay 18% IGST on all imported services:
- Pay under RCM in GSTR-3B Section 3.1(d)
- Claim ITC in Section 4 (net zero if collecting GST)
- File details in GSTR-1

---

## 6. Equalization Levy Considerations

| Aspect              | Details                                          |
| ------------------- | ------------------------------------------------ |
| Rate                | 2% on consideration received from non-resident   |
| Applies to          | E-commerce supply/services to non-resident       |
| Threshold           | Rs 2 crore per FY                                |
| Status (2026)       | Under review -- may be repealed or modified      |

**Note:** Equalization Levy is being reconsidered as India negotiates OECD Pillar One. For a pre-launch startup, this is unlikely to apply (Rs 2Cr threshold).

---

## Sources

- [EY Alert: GST Council Recommends Export Status for Intermediary Services](https://www.ey.com/en_in/technical/alerts-hub/2025/09/gst-council-recommends-export-status-for-intermediary-services)
- [KPMG: Budget 2026-27 Changes Tax Landscape for Intermediary Services](https://kpmg.com/in/en/blogs/2026/02/budget-2026-27-changes-the-tax-landscape-for-intermediary-services.html)
- [Section 13(8)(b) Deleted by Budget 2026 (Winvesta)](https://www.winvesta.in/blog/businesses/budget-2026-killed-section-138b-gst-on-exports)
- [Finance Bill 2026 GST Reforms (CounselVise)](https://counselvise.com/blogs/finance-bill-2026-key-gst-amendments-post-sale-discounts-refunds)
- [CAClubIndia: Critical Analysis of GST Budget 2026-27](https://www.caclubindia.com/articles/critical-analysis-of-the-amendments-to-the-gst-act-as-per-the-budget-2026-27-54911.asp)
- [A2Z TaxCorp: Export of Services vs Intermediary (Court Ruling)](https://a2ztaxcorp.net/export-of-services-vs-intermediary-under-gst-principal-to-principal-service-contracts-qualify-as-export-of-services/)
- [Intermediary and Export of Services (HNA LLP)](https://hnallp.com/a/intermediary-and-export-of-services-under-gst)
- [GST on E-Commerce Operators (MyFinanceGyan)](https://www.myfinancegyan.com/gst-on-e-commerce-operators-complete-compliance-guide-for-online-marketplaces/)
- [GSTR-8 Guide (DisyTax)](https://www.disytax.com/gstr-8-return-filing-ecommerce-tcs/)
- [GST on E-Commerce Sellers (DMI Finance)](https://www.dmifinance.in/business-loan/gst-for-e-commerce-sellers-in-india/)
