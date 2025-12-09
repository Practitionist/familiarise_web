# SaaS Metrics - Monthly Tracking Guide

## Overview

This document provides a month-by-month framework for tracking key SaaS metrics for Familiarise. Track these metrics consistently to measure growth, identify issues early, and make data-driven decisions.

---

## Key Metrics Dashboard Template

### Monthly Snapshot

| Metric                  | Month 1 | Month 2 | Month 3 | Month 4 | Month 5 | Month 6 |
| ----------------------- | ------- | ------- | ------- | ------- | ------- | ------- |
| **Revenue Metrics**     |
| GMV                     |         |         |         |         |         |         |
| Platform Revenue        |         |         |         |         |         |         |
| MRR                     |         |         |         |         |         |         |
| ARR                     |         |         |         |         |         |         |
| **User Metrics**        |
| Active Consultants      |         |         |         |         |         |         |
| Active Consultees       |         |         |         |         |         |         |
| New Users               |         |         |         |         |         |         |
| Churned Users           |         |         |         |         |         |         |
| **Transaction Metrics** |
| Total Transactions      |         |         |         |         |         |         |
| Avg Transaction Value   |         |         |         |         |         |         |
| **Health Metrics**      |
| Customer Churn %        |         |         |         |         |         |         |
| Revenue Churn %         |         |         |         |         |         |         |
| NRR                     |         |         |         |         |         |         |
| LTV:CAC                 |         |         |         |         |         |         |

---

## Metric Definitions & Formulas

### 1. MRR (Monthly Recurring Revenue)

**Definition:** Predictable revenue earned each month from subscriptions and recurring services.

```
MRR = Sum of all active subscription revenue
    + Recurring consultation packages
    + Class enrollments (monthly)
```

**Components:**

| Component       | Description                | Example |
| --------------- | -------------------------- | ------- |
| New MRR         | Revenue from new customers | ₹50,000 |
| Expansion MRR   | Upgrades, add-ons          | ₹10,000 |
| Contraction MRR | Downgrades                 | -₹5,000 |
| Churned MRR     | Lost subscriptions         | -₹8,000 |
| **Net New MRR** | Total change               | ₹47,000 |

**Monthly Tracking:**

| Month | Starting MRR | New     | Expansion | Contraction | Churn   | Ending MRR |
| ----- | ------------ | ------- | --------- | ----------- | ------- | ---------- |
| Jan   | ₹0           | ₹50,000 | ₹0        | ₹0          | ₹0      | ₹50,000    |
| Feb   | ₹50,000      | ₹40,000 | ₹5,000    | -₹2,000     | -₹3,000 | ₹90,000    |
| Mar   | ₹90,000      | ₹60,000 | ₹10,000   | -₹5,000     | -₹5,000 | ₹1,50,000  |

---

### 2. ARR (Annual Recurring Revenue)

**Formula:**

```
ARR = MRR × 12
```

**Example:**

- MRR: ₹1,50,000
- ARR: ₹18,00,000 (₹18 Lakhs)

---

### 3. GMV (Gross Merchandise Value)

**Definition:** Total transaction volume processed through the platform.

**Formula:**

```
GMV = Sum of all payments (before fees)
```

**Monthly Tracking:**

| Month | Consultations | Subscriptions | Webinars  | Classes   | Total GMV |
| ----- | ------------- | ------------- | --------- | --------- | --------- |
| Jan   | ₹2,00,000     | ₹1,00,000     | ₹50,000   | ₹50,000   | ₹4,00,000 |
| Feb   | ₹3,00,000     | ₹1,50,000     | ₹75,000   | ₹75,000   | ₹6,00,000 |
| Mar   | ₹4,50,000     | ₹2,00,000     | ₹1,00,000 | ₹1,00,000 | ₹8,50,000 |

---

### 4. Customer Churn Rate

**Definition:** Percentage of customers who stop using the platform in a given period.

**Formula:**

```
Customer Churn Rate = (Lost Customers in Period / Customers at Start of Period) × 100
```

**Target:** < 5% monthly (< 50% annually)

**Monthly Tracking:**

| Month | Start Customers | New | Churned | End Customers | Churn Rate |
| ----- | --------------- | --- | ------- | ------------- | ---------- |
| Jan   | 100             | 30  | 5       | 125           | 5.0%       |
| Feb   | 125             | 40  | 4       | 161           | 3.2%       |
| Mar   | 161             | 50  | 6       | 205           | 3.7%       |

**Churn Analysis by Segment:**

| Segment                   | Churn Rate | Action             |
| ------------------------- | ---------- | ------------------ |
| Consultants (0-3 months)  | 15%        | Improve onboarding |
| Consultants (3-12 months) | 5%         | Normal             |
| Consultants (12+ months)  | 2%         | Loyal base         |
| Consultees (one-time)     | 60%        | Convert to repeat  |
| Consultees (2+ bookings)  | 10%        | Good retention     |

---

### 5. Revenue Churn Rate

**Definition:** Percentage of recurring revenue lost due to cancellations and downgrades.

**Formula:**

```
Revenue Churn = (Churned MRR + Contraction MRR) / Starting MRR × 100
```

**Target:** < 3% monthly

**Monthly Tracking:**

| Month | Starting MRR | Churned MRR | Contraction | Revenue Churn |
| ----- | ------------ | ----------- | ----------- | ------------- |
| Jan   | ₹50,000      | ₹3,000      | ₹0          | 6.0%          |
| Feb   | ₹90,000      | ₹3,000      | ₹2,000      | 5.6%          |
| Mar   | ₹1,50,000    | ₹5,000      | ₹5,000      | 6.7%          |

---

### 6. NRR (Net Revenue Retention)

**Definition:** Measures revenue retained from existing customers, including expansion.

**Formula:**

```
NRR = (Starting MRR + Expansion - Contraction - Churn) / Starting MRR × 100
```

**Target:** > 100% (means you're growing from existing customers)

**Interpretation:**

- NRR > 120%: Excellent (high expansion)
- NRR 100-120%: Good (healthy growth)
- NRR 80-100%: Warning (losing revenue)
- NRR < 80%: Critical (major churn issue)

**Monthly Tracking:**

| Month | Starting MRR | Expansion | Contraction | Churn  | NRR  |
| ----- | ------------ | --------- | ----------- | ------ | ---- |
| Jan   | ₹50,000      | ₹5,000    | ₹2,000      | ₹3,000 | 100% |
| Feb   | ₹90,000      | ₹10,000   | ₹5,000      | ₹3,000 | 102% |
| Mar   | ₹1,50,000    | ₹20,000   | ₹8,000      | ₹5,000 | 105% |

---

### 7. LTV (Customer Lifetime Value)

**Definition:** Total revenue expected from a customer over their entire relationship.

**Formula:**

```
LTV = ARPU × Customer Lifetime

Where:
- ARPU = Average Revenue Per User (monthly)
- Customer Lifetime = 1 / Monthly Churn Rate
```

**Alternative Formula:**

```
LTV = (Average Transaction Value × Transactions per Month × Gross Margin) / Churn Rate
```

**Example Calculation:**

```
ARPU = ₹500/month
Monthly Churn = 5%
Customer Lifetime = 1 / 0.05 = 20 months
LTV = ₹500 × 20 = ₹10,000
```

**LTV by Customer Segment:**

| Segment                | ARPU              | Lifetime      | LTV     |
| ---------------------- | ----------------- | ------------- | ------- |
| Consultant (Free tier) | ₹194/txn          | 24 months     | ₹4,656  |
| Consultant (Pro tier)  | ₹1,000 + ₹194/txn | 36 months     | ₹42,984 |
| Consultee (one-time)   | ₹1,000            | 1 transaction | ₹1,000  |
| Consultee (repeat)     | ₹500/month        | 12 months     | ₹6,000  |

---

### 8. CAC (Customer Acquisition Cost)

**Definition:** Cost to acquire a new customer.

**Formula:**

```
CAC = Total Marketing & Sales Spend / Number of New Customers Acquired
```

**Components:**

- Paid ads (Google, Meta, LinkedIn)
- Content marketing
- Sales team salaries
- Referral bonuses
- Onboarding costs

**Monthly Tracking:**

| Month | Marketing Spend | Sales Spend | New Customers | CAC    |
| ----- | --------------- | ----------- | ------------- | ------ |
| Jan   | ₹50,000         | ₹30,000     | 50            | ₹1,600 |
| Feb   | ₹75,000         | ₹35,000     | 80            | ₹1,375 |
| Mar   | ₹1,00,000       | ₹40,000     | 120           | ₹1,167 |

**CAC by Channel:**

| Channel     | Spend   | Customers | CAC    | Efficiency |
| ----------- | ------- | --------- | ------ | ---------- |
| Google Ads  | ₹30,000 | 25        | ₹1,200 | Good       |
| Meta Ads    | ₹20,000 | 15        | ₹1,333 | Average    |
| LinkedIn    | ₹15,000 | 5         | ₹3,000 | Poor       |
| Organic/SEO | ₹5,000  | 20        | ₹250   | Excellent  |
| Referrals   | ₹10,000 | 15        | ₹667   | Very Good  |

---

### 9. LTV:CAC Ratio

**Definition:** Measures the efficiency of customer acquisition spend.

**Formula:**

```
LTV:CAC Ratio = LTV / CAC
```

**Target:** > 3:1 (for every ₹1 spent, get ₹3+ back)

**Interpretation:**

- < 1:1: Losing money on each customer (critical)
- 1:1 - 3:1: Unprofitable or break-even
- 3:1 - 5:1: Healthy business
- > 5:1: Under-investing in growth

**Monthly Tracking:**

| Month | LTV     | CAC    | LTV:CAC | Status          |
| ----- | ------- | ------ | ------- | --------------- |
| Jan   | ₹8,000  | ₹1,600 | 5.0:1   | Under-investing |
| Feb   | ₹9,000  | ₹1,375 | 6.5:1   | Under-investing |
| Mar   | ₹10,000 | ₹1,167 | 8.6:1   | Scale marketing |

---

### 10. CAC Payback Period

**Definition:** Months to recover customer acquisition cost.

**Formula:**

```
CAC Payback = CAC / (ARPU × Gross Margin)
```

**Target:** < 12 months

**Example:**

```
CAC = ₹1,200
ARPU = ₹500/month
Gross Margin = 80%

CAC Payback = ₹1,200 / (₹500 × 0.80)
            = ₹1,200 / ₹400
            = 3 months
```

**Monthly Tracking:**

| Month | CAC    | ARPU | Gross Margin | Payback (months) |
| ----- | ------ | ---- | ------------ | ---------------- |
| Jan   | ₹1,600 | ₹400 | 75%          | 5.3              |
| Feb   | ₹1,375 | ₹450 | 78%          | 3.9              |
| Mar   | ₹1,167 | ₹500 | 80%          | 2.9              |

---

### 11. Gross Margin

**Definition:** Percentage of revenue remaining after direct costs.

**Formula:**

```
Gross Margin = (Revenue - COGS) / Revenue × 100

Where COGS includes:
- Payment gateway fees
- Server/hosting costs
- Video/meeting infrastructure
- Support costs
```

**Target:** > 70% for SaaS

**Monthly Tracking:**

| Month | Revenue   | Gateway Fees | Server | Video  | Support | Gross Margin |
| ----- | --------- | ------------ | ------ | ------ | ------- | ------------ |
| Jan   | ₹85,000   | ₹12,000      | ₹5,000 | ₹3,000 | ₹2,000  | 74%          |
| Feb   | ₹1,50,000 | ₹21,000      | ₹6,000 | ₹4,000 | ₹3,000  | 77%          |
| Mar   | ₹2,50,000 | ₹35,000      | ₹8,000 | ₹6,000 | ₹5,000  | 78%          |

---

### 12. ARPU (Average Revenue Per User)

**Definition:** Average revenue generated per active user.

**Formula:**

```
ARPU = Total Revenue / Active Users
```

**Segment ARPU Tracking:**

| Month | Consultant ARPU | Consultee ARPU | Blended ARPU |
| ----- | --------------- | -------------- | ------------ |
| Jan   | ₹2,000          | ₹800           | ₹1,200       |
| Feb   | ₹2,200          | ₹850           | ₹1,350       |
| Mar   | ₹2,500          | ₹900           | ₹1,500       |

---

## Month-by-Month Tracking Template

### Month: \***\*\_\_\*\*** (Fill in)

#### Revenue Metrics

| Metric           | Target | Actual | Variance | Notes |
| ---------------- | ------ | ------ | -------- | ----- |
| GMV              |        |        |          |       |
| Platform Revenue |        |        |          |       |
| MRR              |        |        |          |       |
| New MRR          |        |        |          |       |
| Churned MRR      |        |        |          |       |
| Net New MRR      |        |        |          |       |

#### User Metrics

| Metric               | Target | Actual | Variance | Notes |
| -------------------- | ------ | ------ | -------- | ----- |
| Active Consultants   |        |        |          |       |
| New Consultants      |        |        |          |       |
| Churned Consultants  |        |        |          |       |
| Active Consultees    |        |        |          |       |
| New Consultees       |        |        |          |       |
| Returning Consultees |        |        |          |       |

#### Health Metrics

| Metric         | Target  | Actual | Status | Action Needed |
| -------------- | ------- | ------ | ------ | ------------- |
| Customer Churn | < 5%    |        |        |               |
| Revenue Churn  | < 3%    |        |        |               |
| NRR            | > 100%  |        |        |               |
| LTV:CAC        | > 3:1   |        |        |               |
| CAC Payback    | < 12 mo |        |        |               |
| Gross Margin   | > 70%   |        |        |               |

#### Transaction Metrics

| Event Type   | Transactions | Revenue | Avg Value |
| ------------ | ------------ | ------- | --------- |
| Consultation |              |         |           |
| Subscription |              |         |           |
| Webinar      |              |         |           |
| Class        |              |         |           |
| **Total**    |              |         |           |

#### Marketing Performance

| Channel     | Spend | Leads | Conversions | CAC |
| ----------- | ----- | ----- | ----------- | --- |
| Google Ads  |       |       |             |     |
| Meta Ads    |       |       |             |     |
| LinkedIn    |       |       |             |     |
| Organic/SEO |       |       |             |     |
| Referrals   |       |       |             |     |
| **Total**   |       |       |             |     |

---

## Industry Benchmarks

### SaaS Benchmark Targets

| Metric        | Poor    | Average  | Good     | Excellent |
| ------------- | ------- | -------- | -------- | --------- |
| Monthly Churn | > 10%   | 5-10%    | 3-5%     | < 3%      |
| NRR           | < 80%   | 80-100%  | 100-120% | > 120%    |
| LTV:CAC       | < 1:1   | 1-3:1    | 3-5:1    | > 5:1     |
| CAC Payback   | > 24 mo | 12-24 mo | 6-12 mo  | < 6 mo    |
| Gross Margin  | < 50%   | 50-70%   | 70-80%   | > 80%     |
| MoM Growth    | < 5%    | 5-10%    | 10-20%   | > 20%     |

### Marketplace Benchmark Targets

| Metric       | Poor  | Average | Good   | Excellent |
| ------------ | ----- | ------- | ------ | --------- |
| Take Rate    | < 10% | 10-15%  | 15-25% | > 25%     |
| Repeat Rate  | < 20% | 20-40%  | 40-60% | > 60%     |
| Supply Churn | > 20% | 10-20%  | 5-10%  | < 5%      |
| Demand Churn | > 50% | 30-50%  | 20-30% | < 20%     |
| GMV Growth   | < 10% | 10-30%  | 30-50% | > 50%     |

---

## Reporting Cadence

| Report          | Frequency | Audience   | Key Metrics                         |
| --------------- | --------- | ---------- | ----------------------------------- |
| Daily Dashboard | Daily     | Team       | Transactions, Revenue, Active Users |
| Weekly Metrics  | Weekly    | Leadership | GMV, MRR, Churn signals             |
| Monthly Review  | Monthly   | All        | Full metrics suite, trends          |
| Quarterly Board | Quarterly | Investors  | ARR, Growth, LTV:CAC, NRR           |

---

## Alert Thresholds

### Set Alerts When:

| Metric             | Warning          | Critical         | Action               |
| ------------------ | ---------------- | ---------------- | -------------------- |
| Daily transactions | < 80% of avg     | < 50% of avg     | Check system health  |
| Churn rate         | > 7%             | > 10%            | Survey churned users |
| NRR                | < 95%            | < 85%            | Retention campaign   |
| CAC                | > 120% of target | > 150% of target | Review ad spend      |
| Gross margin       | < 70%            | < 60%            | Cost optimization    |

---

## Related Documents

- [01-business-model.md](./01-business-model.md) - Revenue model
- [04-revenue-distribution.md](./04-revenue-distribution.md) - Revenue calculations
- [07-pricing-calculator.md](./07-pricing-calculator.md) - Pricing for profitability
