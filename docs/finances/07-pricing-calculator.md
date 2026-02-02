# Pricing Calculator Guide

## Overview

This document provides calculators and formulas for determining minimum viable prices to ensure platform profitability. Use these to set minimum price thresholds for consultants.

---

## Quick Reference: Minimum Prices

### Recommended Minimums by Event Type (Updated December 2025)

| Event Type    | Duration  | Minimum Price | Platform Earns | Consultant Earns | Per-Minute Rate |
| ------------- | --------- | ------------- | -------------- | ---------------- | --------------- |
| Consultation  | 15 min    | ₹299          | ₹58            | ₹183             | ₹20/min         |
| Consultation  | 30 min    | ₹499          | ₹97            | ₹305             | ₹17/min         |
| Consultation  | 60 min    | ₹999          | ₹194           | ₹610             | ₹17/min         |
| Webinar       | Any       | ₹199          | ₹39            | ₹122             | -               |
| Subscription  | Monthly   | ₹999          | ₹194           | ₹610             | ~₹250/session   |
| Class Session | Per class | ₹399          | ₹77            | ₹244             | -               |

_Assumes 20% platform commission, 3% gateway fee (2.36% effective with GST)_

### Why These Minimums?

| Rationale                   | Explanation                                      |
| --------------------------- | ------------------------------------------------ |
| **Video infrastructure**    | Real-time video costs ~₹15-50 per 30-min session |
| **Market positioning**      | Premium marketplace, not budget platform         |
| **Consultant value**        | Professionals deserve fair compensation          |
| **Platform sustainability** | Cover operational costs + growth margin          |

### Previous Minimums (Deprecated)

| Event Type          | OLD Minimum | NEW Minimum | Change |
| ------------------- | ----------- | ----------- | ------ |
| 15-min Consultation | ₹149        | ₹299        | +100%  |
| 30-min Consultation | ₹249        | ₹499        | +100%  |
| 60-min Consultation | ₹499        | ₹999        | +100%  |
| Webinar             | ₹99         | ₹199        | +100%  |
| Subscription        | ₹499        | ₹999        | +100%  |
| Class Session       | ₹199        | ₹399        | +100%  |

---

## Calculator Formulas

### Formula 1: Minimum Price from Fixed Costs

**Use When:** You know your fixed costs and need to calculate minimum price to break even.

```
Minimum Price = Fixed Cost Per Transaction / (1 - Commission% - Gateway%)
```

**Example:**

```
Fixed Cost: ₹30 per transaction
Commission: 20%
Gateway: 3%

Minimum Price = ₹30 / (1 - 0.20 - 0.03)
              = ₹30 / 0.77
              = ₹39
```

**Recommendation:** Round up to ₹50 for margin

---

### Formula 2: Break-Even Price from Target Margin

**Use When:** You want a specific profit margin per transaction.

```
Price = (Fixed Cost + Target Profit) / (1 - Commission% - Gateway%)
```

**Example:**

```
Fixed Cost: ₹30
Target Profit: ₹20 per transaction
Commission: 20%
Gateway: 3%

Price = (₹30 + ₹20) / 0.77
      = ₹50 / 0.77
      = ₹65
```

---

### Formula 3: Consultant's Desired Take-Home

**Use When:** Consultant wants to earn a specific amount per session.

```
Listing Price = Desired Earnings / (1 - Gateway%) / (1 - Commission%)
```

**Example:**

```
Consultant wants: ₹800 per hour
Gateway: 3%
Commission: 20%

Net after gateway: ₹800 / 0.80 = ₹1,000
Listing Price: ₹1,000 / 0.97 = ₹1,031

Verification:
₹1,031 - 3% gateway = ₹1,000
₹1,000 - 20% commission = ₹800 ✓
```

**Quick Multiplier:** To earn X, charge X × 1.29 (at 20% commission + 3% gateway)

---

### Formula 4: Platform Revenue at Volume

**Use When:** Projecting revenue from multiple transactions.

```
Platform Revenue = GMV × (1 - Gateway%) × Commission%
```

**Example (100 transactions at ₹500 average):**

```
GMV = 100 × ₹500 = ₹50,000
Net after gateway = ₹50,000 × 0.97 = ₹48,500
Platform Revenue = ₹48,500 × 0.20 = ₹9,700
```

---

## Cost Structure Breakdown

### Bootstrapped Reality Check (February 2026)

> **IMPORTANT**: The fixed costs table and break-even calculator below assume a
> funded-company scenario (₹4,50,000/month with a 4-person team). The actual
> current fixed costs are significantly lower:
>
> | Item | Assumed (Below) | Actual (Feb 2026) |
> |------|----------------|-------------------|
> | Servers (Vercel, Supabase) | ₹50,000 | ₹0 (free tiers) |
> | Team | ₹3,00,000 (4 people) | ₹10,000 (1 part-time tech intern) |
> | Tools & SaaS | ₹20,000 | ₹9,325 (Claude Max ₹8,500 + Apple Dev ₹825) |
> | Marketing | ₹50,000 | ₹0 (organic/founder-driven) |
> | Office/Misc | ₹30,000 | ₹0 |
> | **Total Fixed** | **₹4,50,000** | **~₹19,325** |
>
> **Bootstrapped break-even:**
> - Variable cost per transaction: ~₹24 (gateway fee only; video and DB are free tier)
> - Per-transaction profit: ₹194 - ₹24 = **₹170**
> - Break-even transactions: ₹19,325 / ₹170 = **~114/month**
> - At 10 transactions per consultant: **~12 active consultants**
>
> The pricing formulas, tier system, and minimum price recommendations below
> are all correct regardless of cost scenario.

### Variable Costs Per Transaction

| Cost Component     | Amount     | % of ₹500 Transaction |
| ------------------ | ---------- | --------------------- |
| Payment Gateway    | 2-3% + ₹3  | ~3.6%                 |
| Server/Database    | ~₹2        | 0.4%                  |
| Email/SMS          | ~₹1        | 0.2%                  |
| Video Minutes      | ~₹10-50    | 2-10%                 |
| Support Overhead   | ~₹5        | 1%                    |
| **Total Variable** | **₹20-60** | **4-15%**             |

### Fixed Costs (Monthly) - Funded Company Scenario

| Cost Component             | Amount        | Notes                  |
| -------------------------- | ------------- | ---------------------- |
| Servers (Vercel, Supabase) | ₹50,000       | Scales with users      |
| Team (4 people)            | ₹3,00,000     | Early stage            |
| Tools & SaaS               | ₹20,000       | Analytics, email, etc. |
| Marketing                  | ₹50,000       | Variable               |
| Office/Misc                | ₹30,000       |                        |
| **Total Fixed**            | **₹4,50,000** | Monthly                |

---

## Profitability Calculator

### Per-Transaction Profitability

```
Input:
- Listing Price: ₹1,000
- Commission: 20%
- Gateway Fee: 3%
- Variable Costs: ₹30

Calculation:
Net After Gateway = ₹1,000 × 0.97 = ₹970
Platform Commission = ₹970 × 0.20 = ₹194
Consultant Share = ₹970 × 0.80 = ₹776
Platform Variable Costs = ₹30
Platform Net Profit = ₹194 - ₹30 = ₹164

Result:
- Per Transaction Profit: ₹164
- Profit Margin: 16.4%
```

### Break-Even Volume Calculator - Funded Company Scenario

```
Monthly Fixed Costs = ₹4,50,000
Average Transaction = ₹1,000
Per-Transaction Profit = ₹164

Break-Even Transactions = ₹4,50,000 / ₹164 = 2,744 transactions

At 10 transactions per consultant:
Break-Even Consultants = 2,744 / 10 = ~275 active consultants
```

---

## Pricing Tiers Analysis

### Consultation Pricing Matrix

| Consultant Rate | Gateway (3%) | Net    | Platform (20%) | Consultant | Effective Rate |
| --------------- | ------------ | ------ | -------------- | ---------- | -------------- |
| ₹200            | ₹6           | ₹194   | ₹39            | ₹155       | 77.5%          |
| ₹500            | ₹15          | ₹485   | ₹97            | ₹388       | 77.6%          |
| ₹1,000          | ₹30          | ₹970   | ₹194           | ₹776       | 77.6%          |
| ₹2,500          | ₹75          | ₹2,425 | ₹485           | ₹1,940     | 77.6%          |
| ₹5,000          | ₹150         | ₹4,850 | ₹970           | ₹3,880     | 77.6%          |
| ₹10,000         | ₹300         | ₹9,700 | ₹1,940         | ₹7,760     | 77.6%          |

**Consultant Effective Rate:** ~77.6% (after all fees)

---

### Subscription Pricing Analysis

For monthly subscriptions with multiple sessions:

| Monthly Fee | Sessions | Per-Session Value | Consultant/Session |
| ----------- | -------- | ----------------- | ------------------ |
| ₹999        | 4        | ₹250              | ₹194               |
| ₹1,999      | 4        | ₹500              | ₹388               |
| ₹2,999      | 4        | ₹750              | ₹582               |
| ₹4,999      | 4        | ₹1,250            | ₹970               |
| ₹9,999      | 4        | ₹2,500            | ₹1,940             |

**Subscription Benefits:**

- Predictable revenue
- Higher retention
- Lower per-transaction cost ratio

---

### Webinar Pricing Strategy

| Webinar Price | Attendees | GMV     | Platform Revenue | Per-Attendee Cost |
| ------------- | --------- | ------- | ---------------- | ----------------- |
| ₹49           | 50        | ₹2,450  | ₹476             | ₹9.52             |
| ₹99           | 50        | ₹4,950  | ₹961             | ₹19.22            |
| ₹199          | 50        | ₹9,950  | ₹1,932           | ₹38.64            |
| ₹499          | 50        | ₹24,950 | ₹4,845           | ₹96.90            |

**Webinar Considerations:**

- Higher video infrastructure costs
- Platform value-add is higher (hosting, streaming)
- Consider 25% commission for webinars

---

## Consultant Tier System

Familiarise accommodates consultants across all price points - from budget-friendly to ultra-luxury. This tier system helps position consultants appropriately and set user expectations.

### Tier Overview

| Tier         | Price Range (Hourly) | Target Audience                   | Commission | Badge    |
| ------------ | -------------------- | --------------------------------- | ---------- | -------- |
| **Budget**   | ₹299 - ₹999          | Students, early-career seekers    | 20%        | None     |
| **Everyday** | ₹1,000 - ₹2,999      | Working professionals             | 20%        | Verified |
| **Premium**  | ₹3,000 - ₹9,999      | Senior professionals, managers    | 18%        | Premium  |
| **Luxury**   | ₹10,000 - ₹50,000+   | C-suite, celebrities, top experts | 15%        | Elite    |

### Tier 1: Budget Consultants

**Profile:**

- Students offering peer mentoring
- Fresh graduates (0-2 years experience)
- Hobbyists and skill-sharers
- Early-career professionals building a client base

| Event Type   | Duration | Min Price | Max Recommended | Consultant Earns |
| ------------ | -------- | --------- | --------------- | ---------------- |
| Consultation | 15 min   | ₹299      | ₹499            | ₹183 - ₹305      |
| Consultation | 30 min   | ₹499      | ₹799            | ₹305 - ₹489      |
| Consultation | 60 min   | ₹999      | ₹999            | ₹610             |
| Webinar      | Any      | ₹99       | ₹299            | ₹61 - ₹183       |
| Subscription | Monthly  | ₹999      | ₹1,999          | ₹610 - ₹1,222    |

**Platform Strategy:**

- Low barrier to entry for consultees
- High volume, lower margins
- Build reviews and ratings
- Gateway to higher tiers

---

### Tier 2: Everyday Consultants

**Profile:**

- Working professionals with 3-10 years experience
- Subject matter experts in their field
- Career coaches, fitness trainers, tutors
- Freelancers with established client base

| Event Type   | Duration | Min Price | Max Recommended | Consultant Earns |
| ------------ | -------- | --------- | --------------- | ---------------- |
| Consultation | 15 min   | ₹500      | ₹999            | ₹305 - ₹610      |
| Consultation | 30 min   | ₹999      | ₹1,999          | ₹610 - ₹1,222    |
| Consultation | 60 min   | ₹1,499    | ₹2,999          | ₹916 - ₹1,833    |
| Webinar      | Any      | ₹299      | ₹999            | ₹183 - ₹610      |
| Subscription | Monthly  | ₹1,999    | ₹4,999          | ₹1,222 - ₹3,055  |

**Platform Strategy:**

- Core revenue driver
- Balance of volume and margin
- Encourage subscription packages
- Verified badge after 10+ successful sessions

---

### Tier 3: Premium Consultants

**Profile:**

- Senior professionals (10-20 years experience)
- Industry leaders and published authors
- Certified professionals (CA, Lawyer, Doctor)
- Startup founders and executives
- Popular influencers in their niche

| Event Type   | Duration | Min Price | Max Recommended | Consultant Earns |
| ------------ | -------- | --------- | --------------- | ---------------- |
| Consultation | 15 min   | ₹1,499    | ₹2,999          | ₹960 - ₹1,919    |
| Consultation | 30 min   | ₹2,499    | ₹4,999          | ₹1,599 - ₹3,199  |
| Consultation | 60 min   | ₹4,999    | ₹9,999          | ₹3,199 - ₹6,399  |
| Webinar      | Any      | ₹999      | ₹2,999          | ₹639 - ₹1,919    |
| Subscription | Monthly  | ₹9,999    | ₹24,999         | ₹6,399 - ₹15,999 |

**Platform Strategy:**

- High-value transactions
- Lower commission (18%) to attract top talent
- Premium support and priority matching
- Featured placement in search results
- Premium badge with credential verification

---

### Tier 4: Luxury Consultants

**Profile:**

- C-suite executives (CEO, CFO, CTO)
- Celebrity coaches and influencers
- Industry legends and thought leaders
- Former government officials
- Top-tier professionals with waiting lists

| Event Type   | Duration | Min Price | Max Recommended | Consultant Earns  |
| ------------ | -------- | --------- | --------------- | ----------------- |
| Consultation | 15 min   | ₹5,000    | ₹15,000         | ₹3,300 - ₹9,900   |
| Consultation | 30 min   | ₹10,000   | ₹25,000         | ₹6,600 - ₹16,500  |
| Consultation | 60 min   | ₹15,000   | ₹50,000         | ₹9,900 - ₹33,000  |
| Webinar      | Any      | ₹2,999    | ₹9,999          | ₹1,979 - ₹6,599   |
| Subscription | Monthly  | ₹24,999   | ₹99,999         | ₹16,499 - ₹65,999 |

**Platform Strategy:**

- Lowest commission (15%) to retain exclusivity
- White-glove onboarding experience
- Dedicated account manager
- Elite badge with identity verification
- Concierge booking support
- Priority dispute resolution

---

### Tier Comparison: 60-Minute Consultation

| Tier     | Listing Price | Gateway (3%) | Net     | Platform Fee | Consultant Earns | % Take-Home |
| -------- | ------------- | ------------ | ------- | ------------ | ---------------- | ----------- |
| Budget   | ₹999          | ₹30          | ₹969    | ₹194 (20%)   | ₹775             | 77.6%       |
| Everyday | ₹2,499        | ₹75          | ₹2,424  | ₹485 (20%)   | ₹1,939           | 77.6%       |
| Premium  | ₹6,999        | ₹210         | ₹6,789  | ₹1,222 (18%) | ₹5,567           | 79.5%       |
| Luxury   | ₹25,000       | ₹750         | ₹24,250 | ₹3,638 (15%) | ₹20,612          | 82.4%       |

---

### Tier Eligibility Criteria

| Criteria                    | Budget | Everyday  | Premium   | Luxury     |
| --------------------------- | ------ | --------- | --------- | ---------- |
| Min experience              | None   | 2+ years  | 10+ years | 15+ years  |
| Min rating                  | None   | 4.0+      | 4.5+      | 4.8+       |
| Completed sessions          | None   | 10+       | 50+       | 100+       |
| Credential verification     | None   | Basic     | Full      | Enhanced   |
| Identity verification       | Basic  | Full      | Full      | Enhanced   |
| Professional certifications | None   | Optional  | Required  | Required   |
| Platform tenure             | None   | 3+ months | 6+ months | 12+ months |

---

### Commission Structure by Tier

| Tier     | Base Commission | Effective Commission | Rationale                                       |
| -------- | --------------- | -------------------- | ----------------------------------------------- |
| Budget   | 20%             | 20%                  | Standard rate, high support costs               |
| Everyday | 20%             | 20%                  | Standard rate, core business                    |
| Premium  | 18%             | 18%                  | Attract top talent, higher transaction value    |
| Luxury   | 15%             | 15%                  | Retain exclusive consultants, concierge service |

**Volume Discounts (All Tiers):**

- 50+ monthly transactions: Additional 1% off
- 100+ monthly transactions: Additional 2% off
- Annual commitment: Additional 1% off

---

### Platform Revenue by Tier Mix

**Scenario: 1,000 monthly transactions**

| Tier Mix     | Avg Transaction | GMV            | Platform Revenue |
| ------------ | --------------- | -------------- | ---------------- |
| 40% Budget   | ₹800            | ₹3,20,000      | ₹62,080          |
| 35% Everyday | ₹2,000          | ₹7,00,000      | ₹1,35,800        |
| 20% Premium  | ₹6,000          | ₹12,00,000     | ₹2,09,520        |
| 5% Luxury    | ₹20,000         | ₹10,00,000     | ₹1,45,500        |
| **Total**    | **₹3,220**      | **₹32,20,000** | **₹5,52,900**    |

**Blended Platform Revenue Rate:** 17.2%

---

### Tier Migration Path

```
Budget --> Everyday --> Premium --> Luxury
   |          |            |           |
   v          v            v           v
Reviews   Verified     Credential   Elite
Built     Badge        Verified     Status
```

**Upgrade Triggers:**

- Complete required sessions threshold
- Maintain rating above tier minimum
- Pass credential/identity verification
- Request and approval by platform team

**Downgrade Triggers:**

- Rating drops below tier minimum for 3 months
- Inactivity for 6+ months
- Policy violations
- Multiple disputes lost

---

## Pricing Recommendations by Experience (Legacy)

### New Consultants (0-3 months)

```
Recommended Range: ₹299 - ₹999/hour (Budget Tier)
- Build reviews and ratings first
- Lower barrier for consultees
- Focus on volume, not margin
```

### Established Consultants (3-12 months)

```
Recommended Range: ₹1,000 - ₹2,999/hour (Everyday Tier)
- Can command premium based on reviews
- Introduce packages and subscriptions
- Higher per-session value
```

### Expert Consultants (12+ months, high ratings)

```
Recommended Range: ₹3,000 - ₹15,000/hour (Premium/Luxury Tier)
- Premium positioning
- Exclusive packages
- VIP experience
```

---

## Minimum Price Enforcement Logic

### Code Implementation

```typescript
// lib/pricing/validation.ts
// Updated: December 2025 - Tier-based pricing system

// Consultant tier enum
export type ConsultantTier = "BUDGET" | "EVERYDAY" | "PREMIUM" | "LUXURY";

// Tier-specific configuration
export const TIER_CONFIG = {
  BUDGET: {
    commission: 0.2,
    minPrices: {
      CONSULTATION: { 15: 29900, 30: 49900, 60: 99900 },
      WEBINAR: 9900,
      SUBSCRIPTION: 99900,
      CLASS_SESSION: 29900,
    },
    maxPrices: {
      CONSULTATION: { 15: 49900, 30: 79900, 60: 99900 },
      WEBINAR: 29900,
      SUBSCRIPTION: 199900,
    },
  },
  EVERYDAY: {
    commission: 0.2,
    minPrices: {
      CONSULTATION: { 15: 50000, 30: 99900, 60: 149900 },
      WEBINAR: 29900,
      SUBSCRIPTION: 199900,
      CLASS_SESSION: 49900,
    },
    maxPrices: {
      CONSULTATION: { 15: 99900, 30: 199900, 60: 299900 },
      WEBINAR: 99900,
      SUBSCRIPTION: 499900,
    },
  },
  PREMIUM: {
    commission: 0.18,
    minPrices: {
      CONSULTATION: { 15: 149900, 30: 249900, 60: 499900 },
      WEBINAR: 99900,
      SUBSCRIPTION: 999900,
      CLASS_SESSION: 149900,
    },
    maxPrices: {
      CONSULTATION: { 15: 299900, 30: 499900, 60: 999900 },
      WEBINAR: 299900,
      SUBSCRIPTION: 2499900,
    },
  },
  LUXURY: {
    commission: 0.15,
    minPrices: {
      CONSULTATION: { 15: 500000, 30: 1000000, 60: 1500000 },
      WEBINAR: 299900,
      SUBSCRIPTION: 2499900,
      CLASS_SESSION: 500000,
    },
    maxPrices: null, // No upper limit for luxury
  },
};

// Legacy minimum prices (for backwards compatibility)
const MINIMUM_PRICES = {
  CONSULTATION: {
    15: 29900, // ₹299 in paise
    30: 49900, // ₹499
    60: 99900, // ₹999
  },
  WEBINAR: 19900, // ₹199
  SUBSCRIPTION: 99900, // ₹999/month
  CLASS_SESSION: 39900, // ₹399
};

export function validateConsultationPrice(
  durationMinutes: number,
  priceInPaise: number,
  tier: ConsultantTier = "BUDGET",
): {
  valid: boolean;
  minimumRequired?: number;
  maximumAllowed?: number;
  tier: ConsultantTier;
} {
  const config = TIER_CONFIG[tier];
  const minimumPrice =
    config.minPrices.CONSULTATION[durationMinutes] ||
    Math.round(durationMinutes * 1700); // ₹17/minute default

  if (priceInPaise < minimumPrice) {
    return {
      valid: false,
      minimumRequired: minimumPrice,
      tier,
    };
  }

  // Check max price for non-luxury tiers
  if (config.maxPrices) {
    const maxPrice = config.maxPrices.CONSULTATION[durationMinutes];
    if (maxPrice && priceInPaise > maxPrice) {
      return {
        valid: false,
        maximumAllowed: maxPrice,
        tier,
      };
    }
  }

  return { valid: true, tier };
}

export function validateEventPrice(
  eventType: "WEBINAR" | "SUBSCRIPTION" | "CLASS_SESSION",
  priceInPaise: number,
  tier: ConsultantTier = "BUDGET",
): { valid: boolean; minimumRequired?: number; tier: ConsultantTier } {
  const config = TIER_CONFIG[tier];
  const minimumPrice = config.minPrices[eventType];

  if (priceInPaise < minimumPrice) {
    return {
      valid: false,
      minimumRequired: minimumPrice,
      tier,
    };
  }

  return { valid: true, tier };
}

export function getCommissionRate(tier: ConsultantTier): number {
  return TIER_CONFIG[tier].commission;
}

export function calculateTakeHome(
  priceInPaise: number,
  tier: ConsultantTier = "BUDGET",
  gatewayRate: number = 0.03,
): number {
  const commissionRate = getCommissionRate(tier);
  const netAfterGateway = priceInPaise * (1 - gatewayRate);
  return Math.round(netAfterGateway * (1 - commissionRate));
}

// Determine appropriate tier based on price
export function suggestTierForPrice(
  priceInPaise: number,
  eventType: "CONSULTATION" | "WEBINAR" | "SUBSCRIPTION" = "CONSULTATION",
  duration: number = 60,
): ConsultantTier {
  const tiers: ConsultantTier[] = ["BUDGET", "EVERYDAY", "PREMIUM", "LUXURY"];

  for (const tier of tiers) {
    const config = TIER_CONFIG[tier];
    const minPrice =
      eventType === "CONSULTATION"
        ? config.minPrices.CONSULTATION[duration]
        : config.minPrices[eventType];

    const maxPrice = config.maxPrices
      ? eventType === "CONSULTATION"
        ? config.maxPrices.CONSULTATION[duration]
        : config.maxPrices[eventType]
      : null;

    if (priceInPaise >= minPrice && (!maxPrice || priceInPaise <= maxPrice)) {
      return tier;
    }
  }

  return priceInPaise > 1500000 ? "LUXURY" : "BUDGET";
}
```

### UI Display

```typescript
// components/pricing/PricingPreview.tsx

import { ConsultantTier, getCommissionRate, TIER_CONFIG } from '@/lib/pricing/validation';

interface PricingPreviewProps {
  price: number; // in paise
  tier: ConsultantTier;
  gatewayRate?: number;
}

const TIER_LABELS = {
  BUDGET: { name: 'Budget', color: 'gray' },
  EVERYDAY: { name: 'Everyday', color: 'blue' },
  PREMIUM: { name: 'Premium', color: 'purple' },
  LUXURY: { name: 'Luxury', color: 'gold' },
};

function PricingPreview({
  price,
  tier,
  gatewayRate = 0.03,
}: PricingPreviewProps) {
  const commissionRate = getCommissionRate(tier);
  const gatewayFee = price * gatewayRate;
  const netAfterGateway = price - gatewayFee;
  const platformFee = netAfterGateway * commissionRate;
  const consultantEarnings = netAfterGateway - platformFee;
  const tierLabel = TIER_LABELS[tier];

  return (
    <div className="pricing-breakdown">
      <div className="tier-badge" style={{ color: tierLabel.color }}>
        {tierLabel.name} Tier
      </div>
      <div className="row">
        <span>Your listing price</span>
        <span>₹{(price / 100).toFixed(0)}</span>
      </div>
      <div className="row text-muted">
        <span>Payment gateway (3%)</span>
        <span>-₹{(gatewayFee / 100).toFixed(0)}</span>
      </div>
      <div className="row text-muted">
        <span>Platform fee ({(commissionRate * 100).toFixed(0)}%)</span>
        <span>-₹{(platformFee / 100).toFixed(0)}</span>
      </div>
      <div className="row font-bold">
        <span>You receive</span>
        <span>₹{(consultantEarnings / 100).toFixed(0)}</span>
      </div>
      <div className="row text-xs text-muted">
        <span>Take-home rate</span>
        <span>{((consultantEarnings / price) * 100).toFixed(1)}%</span>
      </div>
    </div>
  );
}

// Tier selection component
function TierSelector({
  currentTier,
  onTierChange,
  eligibility,
}: {
  currentTier: ConsultantTier;
  onTierChange: (tier: ConsultantTier) => void;
  eligibility: Record<ConsultantTier, boolean>;
}) {
  return (
    <div className="tier-selector">
      {(['BUDGET', 'EVERYDAY', 'PREMIUM', 'LUXURY'] as ConsultantTier[]).map((tier) => (
        <button
          key={tier}
          onClick={() => eligibility[tier] && onTierChange(tier)}
          disabled={!eligibility[tier]}
          className={currentTier === tier ? 'active' : ''}
        >
          <span>{TIER_LABELS[tier].name}</span>
          <span className="commission">{(TIER_CONFIG[tier].commission * 100)}% fee</span>
          {!eligibility[tier] && <span className="locked">Locked</span>}
        </button>
      ))}
    </div>
  );
}
```

---

## Interactive Calculator Examples

### Example 1: Budget Tier - Student Mentor

```
Scenario: College student offering peer mentoring

Input:
- Tier: BUDGET
- Session: 30 minutes coding help
- Listing price: ₹499

Validation:
- Budget tier minimum (30 min): ₹499 ✓
- Budget tier maximum (30 min): ₹799 ✓

Calculate earnings:
- Listing price: ₹499
- Gateway fee (3%): ₹15
- Net: ₹484
- Platform fee (20%): ₹97
- Consultant receives: ₹387

Take-home rate: 77.6%
```

### Example 2: Everyday Tier - Career Coach

```
Scenario: HR professional with 5 years experience

Input:
- Tier: EVERYDAY
- Session: 60 minutes career coaching
- Listing price: ₹2,499

Validation:
- Everyday tier minimum (60 min): ₹1,499 ✓
- Everyday tier maximum (60 min): ₹2,999 ✓

Calculate earnings:
- Listing price: ₹2,499
- Gateway fee (3%): ₹75
- Net: ₹2,424
- Platform fee (20%): ₹485
- Consultant receives: ₹1,939

Take-home rate: 77.6%
Effective hourly: ₹1,939/hr
```

### Example 3: Premium Tier - Startup Founder

```
Scenario: Serial entrepreneur offering advisory

Input:
- Tier: PREMIUM
- Subscription: Monthly advisory package
- Monthly price: ₹14,999
- 4 sessions included (60 min each)

Validation:
- Premium tier subscription minimum: ₹9,999 ✓
- Premium tier subscription maximum: ₹24,999 ✓

Calculate monthly earnings:
- Listing price: ₹14,999
- Gateway fee (3%): ₹450
- Net: ₹14,549
- Platform fee (18%): ₹2,619  <- Lower commission!
- Consultant receives: ₹11,930/month

Per-session value: ₹11,930 / 4 = ₹2,983/hour
Take-home rate: 79.5%
```

### Example 4: Luxury Tier - C-Suite Executive

```
Scenario: Former Fortune 500 CEO offering leadership coaching

Input:
- Tier: LUXURY
- Session: 60 minutes executive coaching
- Listing price: ₹35,000

Validation:
- Luxury tier minimum (60 min): ₹15,000 ✓
- No maximum (luxury tier)

Calculate earnings:
- Listing price: ₹35,000
- Gateway fee (3%): ₹1,050
- Net: ₹33,950
- Platform fee (15%): ₹5,093  <- Lowest commission!
- Consultant receives: ₹28,857

Take-home rate: 82.4%
Effective hourly: ₹28,857/hr
```

### Example 5: Everyday Tier - Group Webinar

```
Scenario: Digital marketing expert hosting webinar

Input:
- Tier: EVERYDAY
- Event: 90-minute marketing workshop
- Expected attendees: 75
- Ticket price: ₹599

Validation:
- Everyday tier webinar minimum: ₹299 ✓
- Everyday tier webinar maximum: ₹999 ✓

Calculate earnings:
- Total GMV: ₹599 × 75 = ₹44,925
- Gateway fee (3%): ₹1,348
- Net: ₹43,577
- Platform fee (20%): ₹8,715
- Consultant receives: ₹34,862

Per-attendee profit: ₹465
Take-home rate: 77.6%
```

### Example 6: Tier Comparison - Same Session Price

```
Scenario: What if a ₹5,000/hr consultant is in different tiers?

60-minute consultation at ₹5,000:

| Tier | Commission | Platform Fee | Consultant Earns |
|------|------------|--------------|------------------|
| BUDGET | Ineligible (exceeds max ₹999) | - | - |
| EVERYDAY | Ineligible (exceeds max ₹2,999) | - | - |
| PREMIUM | 18% | ₹873 | ₹3,977 (79.5%) |
| LUXURY | Ineligible (below min ₹15,000) | - | - |

Result: ₹5,000/hr fits PREMIUM tier only
Consultant receives: ₹3,977 per session
```

---

## Pricing Strategy Recommendations

### Do's

1. **Set minimums above break-even** - Ensure every transaction is profitable
2. **Use psychological pricing** - ₹999 instead of ₹1,000
3. **Bundle sessions** - Subscriptions have lower effective rates but higher retention
4. **Tier by expertise** - Different minimums for verified vs new consultants
5. **Dynamic minimums** - Higher during peak times

### Don'ts

1. **Don't race to the bottom** - Quality platforms maintain price floors
2. **Don't hide fees** - Show consultants exactly what they'll earn
3. **Don't over-complicate** - Simple commission structure builds trust
4. **Don't ignore costs** - Video infrastructure is expensive at scale

---

## Related Documents

- [01-business-model.md](./01-business-model.md) - Commission models
- [04-revenue-distribution.md](./04-revenue-distribution.md) - Detailed calculations
- [05-saas-metrics-monthly.md](./05-saas-metrics-monthly.md) - Track profitability
