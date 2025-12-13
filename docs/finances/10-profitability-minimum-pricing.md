# Familiarise SaaS Profitability & Minimum Pricing Plan

## Executive Summary

This document analyzes the profitability of Familiarise, a B2B/B2C marketplace for learning and consulting services. We'll calculate minimum pricing for each service type (Consultation, Subscription, Webinar, Class) to ensure per-transaction profitability across different business stages.

---

## Part 1: Current Architecture Overview

### Service Types & Parameters

| Service | Key Parameters | Pricing Dimensions |
|---------|---------------|-------------------|
| **Consultation** | Duration (1-4 hrs), language, level | Per-session, duration-based |
| **Subscription** | Duration (1-12 months), calls/week (1-4), email support tier | Monthly recurring |
| **Webinar** | Duration (hrs), max participants, certificate | Per-event, group pricing |
| **Class** | Duration (months), calls/week, max participants, modules | Course-based, multi-session |

### Current Payment Flow
- Payment gateways: Stripe (international), Razorpay (India)
- Gateway fees: ~3% (varies by method)
- Commission model: 15-20% tiered by consultant tier
- Minimum pricing: Documented but NOT enforced in code

---

## Part 2: SaaS Cost Analysis

### Monthly SaaS Subscriptions (Your Stack)

| Service | Free Tier | Pro Tier | Team/Scale Tier |
|---------|-----------|----------|-----------------|
| **Supabase** | $0 | $25/mo | $599/mo |
| **Vercel** | $0 | $20/mo | $150/mo (Team) |
| **Stream SDK** | $0 (trial) | ~$99-299/mo | Usage-based |
| **Razorpay** | 2% per txn | 2% per txn | Volume discounts |
| **Stripe** | 2.9%+30c (US) | 2.9%+30c | Volume discounts |
| **Resend** | $0 (3k/mo) | $20/mo | Usage-based |
| **Sentry** | $0 (5k events) | $26/mo | $80/mo |
| **ClickUp** | $0 | $7/user/mo | $12/user/mo |
| **PostHog** | $0 (1M events) | Usage-based | ~$450/mo at scale |

### Total Monthly SaaS by Stage

| Stage | Monthly SaaS Cost |
|-------|------------------|
| **MVP (Free tiers)** | ~₹5,000-10,000 |
| **Early Growth** | ~₹20,000-40,000 |
| **Scale** | ~₹80,000-1,50,000 |
| **Enterprise** | ~₹2,00,000+ |

---

## Part 3: Variable Costs Per Transaction

### Cost Breakdown Per Transaction

| Cost Component | Consultation (1hr) | Subscription (1mo) | Webinar | Class |
|----------------|-------------------|-------------------|---------|-------|
| **Video/Call Infrastructure** | ₹30-50 | ₹120-200 (4 calls) | ₹50-100 | ₹200-400 |
| **Server/Database** | ₹2 | ₹5 | ₹5 | ₹10 |
| **Email/SMS Notifications** | ₹2 | ₹5 | ₹3 | ₹10 |
| **Payment Gateway (3%)** | Variable | Variable | Variable | Variable |
| **Support Overhead** | ₹5 | ₹15 | ₹10 | ₹20 |
| **Base Variable Cost** | **₹40-60** | **₹145-225** | **₹70-120** | **₹240-440** |

---

## Part 4: Fixed Costs by Business Stage

### Scenario A: Solo Founder (MVP Stage)
| Item | Monthly Cost |
|------|--------------|
| SaaS tools | ₹10,000 |
| CEO stipend | ₹50,000 |
| Office/WFH | ₹0 |
| Taxes (GST reserve) | ₹10,000 |
| **Total Fixed** | **₹70,000** |

### Scenario B: Small Team (Early Growth)
| Item | Monthly Cost |
|------|--------------|
| SaaS tools | ₹40,000 |
| CEO salary | ₹1,00,000 |
| 2 employees | ₹1,00,000 |
| Office/infra | ₹20,000 |
| Taxes | ₹40,000 |
| **Total Fixed** | **₹3,00,000** |

### Scenario C: Growing Team (Scale)
| Item | Monthly Cost |
|------|--------------|
| SaaS tools | ₹1,50,000 |
| CEO salary | ₹2,00,000 |
| 5 employees | ₹4,00,000 |
| Office/infra | ₹50,000 |
| Taxes | ₹1,00,000 |
| Legal/Compliance | ₹30,000 |
| **Total Fixed** | **₹9,30,000** |

### Scenario D: Established (Enterprise)
| Item | Monthly Cost |
|------|--------------|
| SaaS tools | ₹3,00,000 |
| CEO salary | ₹4,00,000 |
| 15 employees | ₹15,00,000 |
| Office/infra | ₹1,50,000 |
| Taxes | ₹3,00,000 |
| Legal/Compliance | ₹50,000 |
| **Total Fixed** | **₹27,00,000** |

---

## Part 5: Minimum Pricing for Per-Transaction Profitability

### Formula
```
Minimum Price = (Variable Cost + Fixed Cost Allocation) / (1 - Commission% - Gateway%)
```

Where:
- Commission: 15-20%
- Gateway: 3%
- Gross Margin to Platform: Commission% of (Price - Gateway Fee)

### Per-Transaction Profit Requirement

For **per-transaction profitability**, each transaction must cover:
1. Variable costs (video, server, notifications)
2. Proportional fixed cost allocation
3. Platform margin (profit)

---

## Part 6: Minimum Pricing by Service Type & Volume

### CONSULTATION PLANS

| Duration | Variable Cost | Min Price (100 txn/mo) | Min Price (500 txn/mo) | Min Price (2000 txn/mo) |
|----------|--------------|----------------------|----------------------|------------------------|
| **15 min** | ₹25 | ₹499 | ₹299 | ₹199 |
| **30 min** | ₹35 | ₹799 | ₹499 | ₹349 |
| **1 hour** | ₹50 | ₹1,499 | ₹999 | ₹699 |
| **2 hours** | ₹90 | ₹2,499 | ₹1,799 | ₹1,299 |
| **4 hours** | ₹170 | ₹4,999 | ₹3,499 | ₹2,499 |

**Recommended Absolute Minimums (Regardless of Volume):**
- 15 min: ₹299
- 30 min: ₹499
- 1 hour: ₹999
- 2 hours: ₹1,999
- 4 hours: ₹3,999

### SUBSCRIPTION PLANS

| Duration | Calls/Week | Variable Cost | Min Price (100 txn/mo) | Min Price (500 txn/mo) |
|----------|-----------|--------------|----------------------|----------------------|
| **1 month** | 1 | ₹150 | ₹2,999 | ₹1,999 |
| **1 month** | 2 | ₹280 | ₹4,999 | ₹3,499 |
| **3 months** | 1 | ₹450 | ₹7,999 | ₹5,999 |
| **3 months** | 2 | ₹840 | ₹12,999 | ₹9,999 |
| **6 months** | 1 | ₹900 | ₹14,999 | ₹11,999 |
| **6 months** | 2 | ₹1,680 | ₹24,999 | ₹19,999 |
| **12 months** | 1 | ₹1,800 | ₹29,999 | ₹24,999 |
| **12 months** | 2 | ₹3,360 | ₹49,999 | ₹39,999 |

**Recommended Absolute Minimums:**
- 1 month (1 call/wk): ₹1,999
- 1 month (2 calls/wk): ₹3,499
- 3 months (1 call/wk): ₹4,999
- 6 months (1 call/wk): ₹9,999
- 12 months (1 call/wk): ₹19,999

### WEBINAR PLANS

| Duration | Variable Cost | Min Price (100 txn/mo) | Min Price (500 txn/mo) |
|----------|--------------|----------------------|----------------------|
| **1 hour** | ₹80 | ₹999 | ₹499 |
| **2 hours** | ₹150 | ₹1,499 | ₹799 |
| **Half-day (4hr)** | ₹280 | ₹2,999 | ₹1,499 |
| **Full-day (8hr)** | ₹500 | ₹4,999 | ₹2,999 |

**Recommended Absolute Minimums:**
- 1 hour webinar: ₹499
- 2 hour webinar: ₹999
- Half-day: ₹1,999
- Full-day: ₹3,999

### CLASS PLANS

| Duration | Calls/Week | Max Participants | Variable Cost | Min Price (100 txn/mo) | Min Price (500 txn/mo) |
|----------|-----------|-----------------|--------------|----------------------|----------------------|
| **1 month** | 1 | 10 | ₹300 | ₹4,999 | ₹2,999 |
| **1 month** | 2 | 10 | ₹560 | ₹7,999 | ₹5,499 |
| **3 months** | 1 | 10 | ₹900 | ₹12,999 | ₹8,999 |
| **3 months** | 2 | 20 | ₹1,680 | ₹22,999 | ₹16,999 |
| **6 months** | 2 | 20 | ₹3,360 | ₹44,999 | ₹32,999 |

**Recommended Absolute Minimums:**
- 1 month class: ₹2,999
- 3 month class: ₹7,999
- 6 month class: ₹14,999

---

## Part 7: Break-Even Analysis by Business Stage

### Transactions Needed to Break Even

| Business Stage | Fixed Costs | Avg Platform Revenue/Txn | Txns Needed/Month |
|----------------|-------------|-------------------------|-------------------|
| **Solo Founder** | ₹70,000 | ₹150 (at ₹1000 avg) | 467 |
| **Small Team** | ₹3,00,000 | ₹300 (at ₹2000 avg) | 1,000 |
| **Growing Team** | ₹9,30,000 | ₹400 (at ₹2500 avg) | 2,325 |
| **Enterprise** | ₹27,00,000 | ₹500 (at ₹3000 avg) | 5,400 |

### Revenue Projections

| Monthly Txns | Avg Price | Platform Revenue (18%) | Net After Costs | Profitable Stage? |
|--------------|-----------|----------------------|----------------|-------------------|
| 100 | ₹1,500 | ₹27,000 | -₹43,000 | No |
| 500 | ₹1,500 | ₹1,35,000 | +₹65,000 | Solo ✓ |
| 1,000 | ₹2,000 | ₹3,60,000 | +₹60,000 | Small Team ✓ |
| 2,500 | ₹2,500 | ₹11,25,000 | +₹1,95,000 | Growing ✓ |
| 5,000 | ₹3,000 | ₹27,00,000 | Break-even | Enterprise ✓ |

---

## Part 8: Recommended Minimum Pricing Matrix

### FINAL RECOMMENDED MINIMUMS (Per-Transaction Profitable)

```
CONSULTATION:
├── 15 minutes:  ₹299    (Platform earns: ₹45)
├── 30 minutes:  ₹499    (Platform earns: ₹75)
├── 1 hour:      ₹999    (Platform earns: ₹150)
├── 2 hours:     ₹1,999  (Platform earns: ₹300)
└── 4 hours:     ₹3,999  (Platform earns: ₹600)

SUBSCRIPTION (per month equivalent):
├── Basic (1 call/wk):    ₹1,999/mo   (Platform earns: ₹300/mo)
├── Standard (2 calls/wk): ₹3,499/mo  (Platform earns: ₹525/mo)
├── Premium (4 calls/wk):  ₹6,999/mo  (Platform earns: ₹1,050/mo)
└── Dedicated:             ₹14,999/mo (Platform earns: ₹2,250/mo)

WEBINAR:
├── 1 hour:     ₹499     (Platform earns: ₹75)
├── 2 hours:    ₹999     (Platform earns: ₹150)
├── Half-day:   ₹1,999   (Platform earns: ₹300)
└── Full-day:   ₹3,999   (Platform earns: ₹600)

CLASS (per month equivalent):
├── Small group (≤10):  ₹2,999/mo  (Platform earns: ₹450/mo)
├── Medium group (≤20): ₹4,999/mo  (Platform earns: ₹750/mo)
└── Large group (≤50):  ₹9,999/mo  (Platform earns: ₹1,500/mo)
```

---

## Part 9: Pricing Calculation Formulas (Per-Month Equivalent)

### Subscription Minimum Calculation
```
Minimum Total Price = Monthly Minimum × Duration in Months

Examples:
- 1 month, 1 call/wk:  ₹1,999 × 1 = ₹1,999
- 3 months, 1 call/wk: ₹1,999 × 3 = ₹5,997
- 6 months, 2 calls/wk: ₹3,499 × 6 = ₹20,994
- 12 months, 1 call/wk: ₹1,999 × 12 = ₹23,988
```

### Class Minimum Calculation
```
Minimum Total Price = (Monthly Base × Duration) + (Participant Tier Adjustment)

Examples:
- 1 month, 10 participants:  ₹2,999 × 1 = ₹2,999
- 3 months, 20 participants: ₹4,999 × 3 = ₹14,997
- 6 months, 50 participants: ₹9,999 × 6 = ₹59,994
```

### Reference Minimum Prices (in paise for code)
```typescript
// Reference values - NOT currently enforced in code
const MINIMUM_PRICES = {
  CONSULTATION: {
    0.25: 29900,  // 15 min: ₹299
    0.5: 49900,   // 30 min: ₹499
    1: 99900,     // 1 hr: ₹999
    2: 199900,    // 2 hr: ₹1,999
    4: 399900,    // 4 hr: ₹3,999
  },
  SUBSCRIPTION_PER_MONTH: 199900,  // ₹1,999/month minimum
  WEBINAR_PER_HOUR: 49900,         // ₹499/hour minimum
  CLASS_PER_MONTH: {
    10: 299900,   // ≤10 participants: ₹2,999/mo
    20: 499900,   // ≤20 participants: ₹4,999/mo
    50: 999900,   // ≤50 participants: ₹9,999/mo
  },
};
```

---

## Part 10: Key Insights

### Why Current Pricing May Not Be Profitable

1. **No enforced minimums** - Consultants can set ₹100 consultations
2. **Variable costs not considered** - Video infra costs ₹30-50/session
3. **Low commission at low prices** - 18% of ₹500 = ₹90, barely covers costs

### Profitability Levers

1. **Minimum pricing** - Ensures each transaction is profitable
2. **Volume** - Fixed costs spread across more transactions
3. **Mix shift** - Higher-priced services have better margins
4. **Commission tiering** - Higher commission on lower-tier consultants

### Risk Mitigation

- Start with documented minimums, not enforced
- A/B test enforcement with new consultants
- Grandfather existing consultants for 3-6 months
- Monitor conversion rates after enforcement

---

## Document Status

**Type:** Reference Document (No Code Changes)
**Purpose:** Profitability analysis and minimum pricing guidelines

### How to Use This Document

1. **For Business Planning:** Use break-even tables to understand transaction volumes needed at each stage
2. **For Pricing Guidance:** Share minimum price recommendations with consultants during onboarding
3. **For Future Implementation:** Reference the formulas if you decide to enforce minimums later

### Key Takeaways

- **Per-transaction profitability requires minimums:** Without ₹299+ consultations and ₹1,999+/mo subscriptions, variable costs eat into margins
- **Volume matters:** At 500+ transactions/month with ₹1,500 average, the platform becomes profitable at solo founder stage
- **Commission rate is secondary:** Raising commission from 18% to 25% matters less than enforcing minimum prices
- **Subscription/Class pricing should scale per-month:** Use monthly equivalent minimums × duration
