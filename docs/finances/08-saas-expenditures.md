# SaaS Expenditures & Infrastructure Costs

## Overview

This document details all SaaS and infrastructure costs for Familiarise. Updated February 2026 to reflect the actual bootstrapped stack.

**Key insight:** At the bootstrapped/pre-revenue stage, the platform runs almost entirely on free tiers. The single largest SaaS cost is Claude Max ($100/mo) for AI-assisted development.

---

## Current Stack - Pre-Launch (February 2026)

### Non-Negotiable Costs (Paid)

| Service                                                          | Plan     | Monthly Cost (USD) | Monthly Cost (INR) | Annual (INR)   | Purpose                                       |
| ---------------------------------------------------------------- | -------- | ------------------ | ------------------ | -------------- | --------------------------------------------- |
| [Claude Max](https://claude.com/pricing) (Anthropic)             | Max $100 | $100               | ~₹8,500            | ~₹1,02,000     | AI coding assistant, primary development tool |
| [Apple Developer Program](https://developer.apple.com/programs/) | Annual   | $8.25/mo amortized | ~₹725              | ₹8,700         | Required to publish on iOS App Store          |
| Domain (.com/.in)                                                | Annual   | ~$1.20/mo          | ~₹100              | ~₹1,200        | Platform identity                             |
| **Subtotal (Non-Negotiable)**                                    |          | **~$109.45**       | **~₹9,325**        | **~₹1,11,900** |                                               |

> **Note on Claude:** Downgrading from Max ($100) to Pro ($20) saves ₹6,800/month. This is the single biggest cost-reduction lever if cash runs low.

### One-Time Costs (Already Paid or Due Once)

| Service                                                 | Cost (USD) | Cost (INR) | Notes                                |
| ------------------------------------------------------- | ---------- | ---------- | ------------------------------------ |
| [Google Play Console](https://play.google.com/console/) | $25        | ~₹2,100    | One-time registration, no annual fee |

### Free Tier SaaS (₹0 Current Cost)

| Service                                                          | Free Tier Limits                         | Monthly Cost at Free | Paid Tier Cost           | When You Outgrow Free                            |
| ---------------------------------------------------------------- | ---------------------------------------- | -------------------- | ------------------------ | ------------------------------------------------ |
| [Supabase](https://supabase.com/pricing)                         | 500MB DB, 1GB storage, 50K MAU           | ₹0                   | $25/mo (~₹2,125) Pro     | ~200-500 active users                            |
| [Vercel](https://vercel.com/pricing)                             | 100GB bandwidth, hobby project           | ₹0                   | $20/seat (~₹1,700) Pro   | Team features needed                             |
| [Stream.io](https://getstream.io/maker-account/) (Maker Account) | 2K MAU chat, 333K video participant-mins | ₹0                   | $99-299/mo (~₹8.4-25.4K) | $10K revenue OR $100K funding OR >5 team members |
| [Globe.dev](https://globe.dev/)                                  | Free tier (Flutter deployment)           | ₹0                   | Not publicly listed      | Unknown                                          |
| [Resend](https://resend.com/pricing)                             | 100 emails/day, 3K/month                 | ₹0                   | $20/mo (~₹1,700)         | ~100 bookings/day                                |
| [Upstash Redis](https://upstash.com/pricing)                     | Free tier                                | ₹0                   | $10/mo (~₹850)           | Heavy rate-limiting                              |
| [PostHog](https://posthog.com/pricing)                           | 1M events/month                          | ₹0                   | Usage-based              | Scale stage                                      |
| [Sentry](https://sentry.io/pricing)                              | 5K errors/month                          | ₹0                   | $26/mo (~₹2,200) Team    | Paid features needed                             |
| [Cloudflare](https://www.cloudflare.com/plans/)                  | CDN, DDoS protection                     | ₹0                   | $20/mo Pro               | Enterprise features                              |
| [GitHub](https://github.com/pricing)                             | Free private repos, Actions minutes      | ₹0                   | $4/user/mo (~₹340) Team  | Team management                                  |

### Total Current Monthly SaaS Burn

| Category                    | Amount (INR)   |
| --------------------------- | -------------- |
| Claude Max (Anthropic)      | ₹8,500         |
| Apple Developer (amortized) | ₹725           |
| Domain                      | ₹100           |
| All free tier tools         | ₹0             |
| **Total Monthly SaaS**      | **~₹9,325**    |
| **Total Annual SaaS**       | **~₹1,11,900** |

---

## Stream.io Maker Account: Why It's Free

Familiarise qualifies for Stream's [Maker Account](https://getstream.io/maker-account/) because:

| Requirement            | Your Status            | Qualifies? |
| ---------------------- | ---------------------- | ---------- |
| < 5 team members       | 2 (founder + 1 intern) | Yes        |
| < $10K monthly revenue | $0 (pre-revenue)       | Yes        |
| < $100K in funding     | $0 (bootstrapped)      | Yes        |

### What Maker Account Includes

| Feature        | Limit                             | Normal Paid Cost         |
| -------------- | --------------------------------- | ------------------------ |
| Chat           | 2,000 MAU, 100 concurrent         | $99-499/mo               |
| Video          | 333,000 participant-minutes/month | Usage-based, ~$20-270/mo |
| Activity Feeds | 125,000 API calls/month           | $99+/mo                  |
| AI Moderation  | $100 in credits                   | Varies                   |

### When You Lose Maker Account Eligibility

You lose access when ANY of these happen:

- Team grows beyond 5 members
- Monthly revenue exceeds $10K (~₹8.5L)
- Funding exceeds $100K (~₹85L)

**At that point, Stream costs jump to ~₹8,400-25,400/month** depending on usage. This is the biggest single SaaS cost increase to plan for.

---

## Payment Gateway Costs (Variable, Per-Transaction)

### Razorpay (India - Primary)

| Payment Method              | Fee  | GST on Fee (18%) | Total Effective | On ₹1,000 |
| --------------------------- | ---- | ---------------- | --------------- | --------- |
| Domestic cards (Visa/MC)    | 2%   | +0.36%           | 2.36%           | ₹23.60    |
| UPI                         | 0-1% | +0-0.18%         | 0-1.18%         | ₹0-11.80  |
| Net Banking                 | 2%   | +0.36%           | 2.36%           | ₹23.60    |
| International cards         | 3%   | +0.54%           | 3.54%           | ₹35.40    |
| Premium cards (Amex/Diners) | 3%   | +0.54%           | 3.54%           | ₹35.40    |
| EMI transactions            | 3%   | +0.54%           | 3.54%           | ₹35.40    |

- No setup fees, no maintenance fees
- UPI tiered: reduced fees after ₹25L cumulative UPI sales
- Settlement: T+2 business days (domestic), T+7 (international)

**Source:** [Razorpay Pricing](https://razorpay.com/pricing/)

### Stripe (International - Future)

| Method              | Fee                          |
| ------------------- | ---------------------------- |
| Standard            | 2.9% + $0.30 per transaction |
| International cards | +1% additional               |
| Currency conversion | +1% additional               |

**Source:** [Stripe Pricing](https://stripe.com/pricing)

---

## Per-Transaction Variable Costs (Updated)

### At Current Stack (All Free Tiers + Maker Account)

| Cost Component                      | Consultation (1hr) | Subscription (1mo, 4 calls) | Webinar (1hr) | Class (1mo, 4 sessions) |
| ----------------------------------- | ------------------ | --------------------------- | ------------- | ----------------------- |
| Video infrastructure (Stream Maker) | ₹0                 | ₹0                          | ₹0            | ₹0                      |
| Server/Database (Supabase Free)     | ₹0                 | ₹0                          | ₹0            | ₹0                      |
| Email notifications (Resend Free)   | ₹0                 | ₹0                          | ₹0            | ₹0                      |
| Payment gateway (~2.4%)             | ~₹24 per ₹1,000    | ~₹48 per ₹2,000             | ~₹12 per ₹500 | ~₹72 per ₹3,000         |
| **Total Variable Cost**             | **~₹24**           | **~₹48**                    | **~₹12**      | **~₹72**                |

**Previous estimate in this document was ₹42/transaction. Actual is ₹24** because video, server, and email are all free at current scale. The only real variable cost is the payment gateway fee.

### At Growth Stage (Paid Tiers)

| Cost Component          | Consultation (1hr) | Subscription (1mo) | Webinar (1hr) | Class (1mo) |
| ----------------------- | ------------------ | ------------------ | ------------- | ----------- |
| Video infrastructure    | ₹15-30             | ₹60-120            | ₹25-50        | ₹60-120     |
| Server/Database         | ₹2                 | ₹5                 | ₹3            | ₹10         |
| Email/SMS notifications | ₹2                 | ₹5                 | ₹3            | ₹8          |
| Payment gateway (~2.4%) | Variable           | Variable           | Variable      | Variable    |
| **Base Variable Cost**  | **₹19-34**         | **₹70-130**        | **₹31-56**    | **₹78-138** |

---

## SaaS Cost Projections by Revenue Stage

### Stage 1: Pre-Launch & Launch (₹0 GMV)

| Service                      | Monthly Cost   |
| ---------------------------- | -------------- |
| Claude Max                   | ₹8,500         |
| Apple Developer (amortized)  | ₹725           |
| Domain                       | ₹100           |
| Everything else (free tiers) | ₹0             |
| **Total**                    | **~₹9,325/mo** |

### Stage 2: Early Revenue (₹25K-₹1L GMV/month)

| Service                           | Monthly Cost             |
| --------------------------------- | ------------------------ |
| Claude Max                        | ₹8,500                   |
| Apple Developer                   | ₹725                     |
| Domain                            | ₹100                     |
| Supabase (still free tier likely) | ₹0                       |
| Stream.io (still Maker)           | ₹0                       |
| Resend (approaching limit)        | ₹0-1,700                 |
| **Total**                         | **~₹9,325 - ₹11,025/mo** |

### Stage 3: Growth (₹1L-₹5L GMV/month)

| Service                              | Monthly Cost              |
| ------------------------------------ | ------------------------- |
| Claude Max                           | ₹8,500                    |
| Supabase Pro                         | ₹2,125                    |
| Vercel Pro (2 seats)                 | ₹3,400                    |
| Stream.io (losing Maker, Start plan) | ₹8,400-25,400             |
| Resend Pro                           | ₹1,700                    |
| Apple Developer                      | ₹725                      |
| Domain + misc                        | ₹500                      |
| **Total**                            | **~₹25,350 - ₹42,350/mo** |

> **The Free Tier Cliff:** Stream.io going from ₹0 to ₹8,400-25,400 is the biggest single cost jump. Plan for this at ₹1L+ GMV.

### Stage 4: Scale (₹5L-₹20L GMV/month)

| Service                     | Monthly Cost              |
| --------------------------- | ------------------------- |
| Claude Max                  | ₹8,500                    |
| Supabase Pro + compute      | ₹5,000-10,000             |
| Vercel Pro (4 seats)        | ₹6,800                    |
| Stream.io (paid plan)       | ₹15,000-40,000            |
| Resend Pro                  | ₹1,700-4,250              |
| Sentry Team                 | ₹2,200                    |
| PostHog (if over free tier) | ₹0-8,500                  |
| Apple Developer             | ₹725                      |
| Domain + misc               | ₹500                      |
| **Total**                   | **~₹40,425 - ₹81,475/mo** |

### Stage 5: Enterprise (₹20L+ GMV/month)

| Service               | Monthly Cost        |
| --------------------- | ------------------- |
| All services at scale | ₹1,00,000-2,50,000+ |

---

## Free Tier Expiry Risk Matrix

| Service             | Trigger to Outgrow                      | Risk Level | Cost Jump             | Mitigation                                                   |
| ------------------- | --------------------------------------- | ---------- | --------------------- | ------------------------------------------------------------ |
| **Stream.io Maker** | $10K revenue, $100K funding, or >5 team | HIGH       | ₹0 → ₹8,400-25,400/mo | Largest single cost increase. Budget for this at ₹1L+ GMV    |
| **Supabase**        | 500MB DB or 50K MAU                     | MEDIUM     | ₹0 → ₹2,125/mo        | DB growth is gradual; monitor usage dashboard weekly         |
| **Vercel**          | Need team features or bandwidth         | LOW        | ₹0 → ₹1,700/seat      | Can stay on hobby plan for a long time with single developer |
| **Resend**          | 100 emails/day or 3K/month              | MEDIUM     | ₹0 → ₹1,700/mo        | At ~50+ bookings/day (each generates 2-3 emails)             |
| **PostHog**         | 1M events/month                         | LOW        | ₹0 → usage-based      | Very generous free tier; unlikely to hit in Year 1           |
| **Sentry**          | 5K errors/month                         | LOW        | ₹0 → ₹2,200/mo        | If hitting 5K errors, you have bigger problems               |

---

## Cost Comparison: Previous Estimates vs Reality

| Line Item         | Previous Doc Estimate    | Actual Cost (Feb 2026)       | Difference                                                                        |
| ----------------- | ------------------------ | ---------------------------- | --------------------------------------------------------------------------------- |
| Vercel            | ₹3,400/mo (Pro, 2 seats) | ₹0 (free tier)               | -₹3,400                                                                           |
| Supabase          | ₹2,100/mo (Pro)          | ₹0 (free tier)               | -₹2,100                                                                           |
| Stream.io / Video | ₹10,000-25,000/mo        | ₹0 (Maker Account)           | -₹10,000+                                                                         |
| Claude Max        | Not listed               | ₹8,500/mo                    | +₹8,500                                                                           |
| Apple Developer   | Not listed               | ₹725/mo                      | +₹725                                                                             |
| Google Play       | Not listed               | ₹175/mo (amortized one-time) | +₹175                                                                             |
| Globe.dev         | Not listed               | ₹0 (free tier)               | ₹0                                                                                |
| Email (Resend)    | ₹850-2,550               | ₹0 (free tier)               | -₹850+                                                                            |
| **Total**         | **~₹6,850-29,550**       | **~₹9,325**                  | **Significantly lower than estimated for infrastructure, but Claude adds ₹8,500** |

**Key takeaway:** The previous document overestimated infrastructure costs (assumed paid tiers for everything) but completely missed the ₹8,500/month Claude Max expense. The net effect is that actual costs are within the same range but allocated very differently.

---

## Break-Even Infrastructure

### At Current Costs (₹9,325/month SaaS)

```
Monthly SaaS: ₹9,325
Platform Revenue per ₹1,000 transaction: ~₹170 (at ~17% blended commission after gateway)
Break-even transactions: 9,325 / 170 = ~55 transactions/month

At 5 transactions/consultant/month: need ~11 active consultants
At 10 transactions/consultant/month: need ~6 active consultants
```

This is achievable within the first 1-2 months of launch.

### At Growth Costs (~₹35,000/month SaaS)

```
Monthly SaaS: ₹35,000
Break-even transactions: 35,000 / 170 = ~206 transactions/month

At 10 transactions/consultant/month: need ~21 active consultants
```

---

## Monitoring & Alerts

### Set Cost Alerts For

| Service   | Where to Monitor            | Alert When                   |
| --------- | --------------------------- | ---------------------------- |
| Supabase  | Dashboard → Usage           | 70% of any free tier limit   |
| Vercel    | Dashboard → Usage & Billing | 75% of bandwidth             |
| Stream.io | Dashboard → Usage           | 1,500 MAU (75% of 2K limit)  |
| Resend    | Dashboard → Usage           | 70 emails/day (70% of limit) |
| Razorpay  | Dashboard → Settlements     | Refund rate > 5%             |
| Claude    | Subscription page           | Before renewal each month    |

---

## Related Documents

- [01-business-model.md](./01-business-model.md) - Revenue model and commission structure
- [05-saas-metrics-monthly.md](./05-saas-metrics-monthly.md) - SaaS metrics tracking
- [07-pricing-calculator.md](./07-pricing-calculator.md) - Pricing strategy
- [10-profitability-minimum-pricing.md](./10-profitability-minimum-pricing.md) - Profitability analysis
