# SaaS Expenditures & Infrastructure Costs

## Overview

This document details all SaaS and infrastructure costs for Familiarise. Updated February 2026 to reflect the actual bootstrapped stack.

**Exchange Rate:** ₹90.7/$1 (Feb 13, 2026)

**Key insight:** At the bootstrapped/pre-revenue stage, the platform runs almost entirely on free tiers. The single largest SaaS cost is Claude Max ($100/mo) for AI-assisted development. If GST-registered, 18% GST applies on all foreign SaaS under Reverse Charge Mechanism (RCM) but is fully claimable as Input Tax Credit (ITC).

---

## Current Stack - Pre-Launch (February 2026)

### Non-Negotiable Costs (Paid)

| Service                                                          | Plan     | Monthly (USD) | INR @90.7  | GST 18% (RCM) | Total INR/mo | Annual (INR)   | Purpose                                       |
| ---------------------------------------------------------------- | -------- | ------------- | ---------- | ------------- | ------------ | -------------- | --------------------------------------------- |
| [Claude Max](https://claude.com/pricing) (Anthropic)             | Max $100 | $100          | ₹9,070     | ₹1,633        | ₹10,703      | ~₹1,28,436     | AI coding assistant, primary development tool |
| [Apple Developer Program](https://developer.apple.com/programs/) | Annual   | $8.25/mo      | ₹748       | ₹135          | ₹883         | ₹10,596        | Required to publish on iOS App Store          |
| Domain (.com/.in)                                                | Annual   | ~$1.20/mo     | ₹109       | -             | ₹109         | ~₹1,308        | Platform identity                             |
| **Subtotal (Non-Negotiable)**                                    |          | **~$109.45**  | **₹9,927** | **₹1,768**    | **₹11,695**  | **~₹1,40,340** |                                               |

> **Note on GST:** The GST (RCM) column applies only if GST-registered. If unregistered, actual cost = ₹9,927/month. GST paid under RCM is fully claimable as ITC, making it net-zero when collecting GST from customers.
>
> **Note on Claude:** Downgrading from Max ($100) to Pro ($20) saves ~₹7,260/month (pre-GST). This is the single biggest cost-reduction lever if cash runs low.

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
| [Novu](https://novu.co/pricing)                                  | 10K workflow runs/mo, 20 workflows       | ₹0                   | $30/mo (~₹2,721) Pro     | ~500-1K bookings/month (~5-8 events each)        |
| [Resend](https://resend.com/pricing)                             | 100 emails/day, 3K/month                 | ₹0                   | $20/mo (~₹1,814)         | ~100 bookings/day                                |
| [Upstash Redis](https://upstash.com/pricing)                     | 500K cmds/mo, 256 MB data, 50 GB bw     | ₹0                   | $0.20/100K cmds PAYG (₹18/mo at 10K MAU) | ~8,300 MAU — see [cost model](../upstash/redis/04-pricing-and-cost-model.md) |
| [PostHog](https://posthog.com/pricing)                           | 1M events/month                          | ₹0                   | Usage-based              | Scale stage                                      |
| [Sentry](https://sentry.io/pricing)                              | 5K errors/month                          | ₹0                   | $26/mo (~₹2,200) Team    | Paid features needed                             |
| [Cloudflare](https://www.cloudflare.com/plans/)                  | CDN, DDoS protection                     | ₹0                   | $20/mo Pro               | Enterprise features                              |
| [GitHub](https://github.com/pricing)                             | Free private repos, Actions minutes      | ₹0                   | $4/user/mo (~₹340) Team  | Team management                                  |

### Total Current Monthly SaaS Burn

| Category                    | Pre-GST (INR)  | With GST (INR) |
| --------------------------- | -------------- | -------------- |
| Claude Max (Anthropic)      | ₹9,070         | ₹10,703        |
| Apple Developer (amortized) | ₹748           | ₹883           |
| Domain                      | ₹109           | ₹109           |
| Novu (free tier)            | ₹0             | ₹0             |
| All other free tier tools   | ₹0             | ₹0             |
| **Total Monthly SaaS**      | **~₹9,927**    | **~₹11,695**   |
| **Total Annual SaaS**       | **~₹1,19,124** | **~₹1,40,340** |

> The "With GST" column applies only if GST-registered (18% RCM on foreign SaaS). If unregistered, use the "Pre-GST" column. GST paid under RCM is claimable as ITC.

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

**At that point, Stream costs jump to ~₹36,189-₹42,703/month** (Start plan $399/mo + GST RCM). This is the biggest single SaaS cost increase to plan for.

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

| Service                      | Monthly (Pre-GST) | Monthly (With GST) |
| ---------------------------- | ----------------- | ------------------ |
| Claude Max                   | ₹9,070            | ₹10,703            |
| Apple Developer (amortized)  | ₹748              | ₹883               |
| Domain                       | ₹109              | ₹109               |
| Novu (free tier)             | ₹0                | ₹0                 |
| Everything else (free tiers) | ₹0                | ₹0                 |
| **Total**                    | **~₹9,927/mo**    | **~₹11,695/mo**    |

### Stage 2: Early Revenue (₹25K-₹1L GMV/month)

| Service                           | Monthly (Pre-GST)        | Monthly (With GST)        |
| --------------------------------- | ------------------------ | ------------------------- |
| Claude Max                        | ₹9,070                   | ₹10,703                   |
| Apple Developer                   | ₹748                     | ₹883                      |
| Domain                            | ₹109                     | ₹109                      |
| Supabase (still free tier likely) | ₹0                       | ₹0                        |
| Stream.io (still Maker)           | ₹0                       | ₹0                        |
| Novu (still free tier)            | ₹0                       | ₹0                        |
| Resend (approaching limit)        | ₹0-₹1,814                | ₹0-₹2,141                 |
| **Total**                         | **~₹9,927 - ₹11,741/mo** | **~₹11,695 - ₹13,836/mo** |

### Stage 3: Growth (₹1L-₹5L GMV/month)

| Service                      | Monthly (Pre-GST) | Monthly (With GST) |
| ---------------------------- | ----------------- | ------------------ |
| Claude Max                   | ₹9,070            | ₹10,703            |
| Supabase Pro ($25)           | ₹2,268            | ₹2,676             |
| Vercel Pro (2 seats, $40)    | ₹3,628            | ₹4,281             |
| Stream.io (Start plan, $399) | ₹36,189           | ₹42,703            |
| Novu Pro ($30)               | ₹2,721            | ₹3,211             |
| Resend Pro ($20)             | ₹1,814            | ₹2,141             |
| Apple Developer              | ₹748              | ₹883               |
| Domain + misc                | ₹500              | ₹500               |
| **Total**                    | **~₹56,938/mo**   | **~₹67,098/mo**    |

> **The Free Tier Cliff:** Going from Stage 2 (~₹10-12K) to Stage 3 (~₹57-67K) is a **5-6x cost jump**. Stream.io alone goes from ₹0 to ₹36-43K. This happens when you hit ₹8.5L/month revenue OR $100K funding OR >5 team members.

### Stage 4: Scale (₹5L-₹20L GMV/month)

| Service                     | Monthly (Pre-GST)           | Monthly (With GST)          |
| --------------------------- | --------------------------- | --------------------------- |
| Claude Max                  | ₹9,070                      | ₹10,703                     |
| Supabase Pro + compute      | ₹5,443-₹9,070               | ₹6,423-₹10,703              |
| Vercel Pro (4 seats, $80)   | ₹7,256                      | ₹8,562                      |
| Stream.io (paid plan)       | ₹16,326-₹42,703             | ₹19,265-₹50,390             |
| Novu Pro/Team ($30-$250)    | ₹2,721-₹22,675              | ₹3,211-₹26,757              |
| Resend Pro ($20-$50)        | ₹1,814-₹4,535               | ₹2,141-₹5,351               |
| Sentry Team ($26)           | ₹2,358                      | ₹2,782                      |
| PostHog (if over free tier) | ₹0-₹9,070                   | ₹0-₹10,703                  |
| Apple Developer             | ₹748                        | ₹883                        |
| Domain + misc               | ₹500                        | ₹500                        |
| **Total**                   | **~₹46,236 - ₹1,07,985/mo** | **~₹54,470 - ₹1,27,534/mo** |

### Stage 5: Enterprise (₹20L+ GMV/month)

| Service               | Monthly (Pre-GST)    | Monthly (With GST)   |
| --------------------- | -------------------- | -------------------- |
| All services at scale | ₹1,10,000-₹2,70,000+ | ₹1,30,000-₹3,20,000+ |

---

## Free Tier Expiry Risk Matrix

| Service             | Trigger to Outgrow                      | Risk Level | Cost Jump (Pre-GST)     | Mitigation                                                       |
| ------------------- | --------------------------------------- | ---------- | ----------------------- | ---------------------------------------------------------------- |
| **Stream.io Maker** | $10K revenue, $100K funding, or >5 team | HIGH       | ₹0 → ₹36,189-₹42,703/mo | Largest single cost increase. Budget for this at ₹8.5L+ GMV      |
| **Novu**            | 10K workflow runs/month                 | MEDIUM     | ₹0 → ₹2,721/mo          | ~500-1K bookings/month triggers upgrade. Each booking = 5-8 runs |
| **Supabase**        | 500MB DB or 50K MAU                     | MEDIUM     | ₹0 → ₹2,268/mo          | DB growth is gradual; monitor usage dashboard weekly             |
| **Resend**          | 100 emails/day or 3K/month              | MEDIUM     | ₹0 → ₹1,814/mo          | At ~50+ bookings/day (each generates 2-3 emails)                 |
| **Vercel**          | Need team features or bandwidth         | LOW        | ₹0 → ₹1,814/seat        | Can stay on hobby plan for a long time with single developer     |
| **PostHog**         | 1M events/month                         | LOW        | ₹0 → usage-based        | Very generous free tier; unlikely to hit in Year 1               |
| **Sentry**          | 5K errors/month                         | LOW        | ₹0 → ₹2,358/mo          | If hitting 5K errors, you have bigger problems                   |
| **Upstash Redis**   | ~8,300 MAU (~500K Redis cmds/mo)        | LOW        | ₹0 → ₹18/mo PAYG        | Stays free through Year 1; see [cost model](../upstash/redis/04-pricing-and-cost-model.md) |

---

## Cost Comparison: Previous Estimates vs Reality

| Line Item         | Previous Doc Estimate    | Actual Cost (Feb 2026, Pre-GST) | Difference                                                                        |
| ----------------- | ------------------------ | ------------------------------- | --------------------------------------------------------------------------------- |
| Vercel            | ₹3,400/mo (Pro, 2 seats) | ₹0 (free tier)                  | -₹3,400                                                                           |
| Supabase          | ₹2,100/mo (Pro)          | ₹0 (free tier)                  | -₹2,100                                                                           |
| Stream.io / Video | ₹10,000-25,000/mo        | ₹0 (Maker Account)              | -₹10,000+                                                                         |
| Claude Max        | Not listed               | ₹9,070/mo                       | +₹9,070                                                                           |
| Apple Developer   | Not listed               | ₹748/mo                         | +₹748                                                                             |
| Novu              | Not listed               | ₹0 (free tier)                  | ₹0                                                                                |
| Google Play       | Not listed               | ~₹189/mo (amortized one-time)   | +₹189                                                                             |
| Globe.dev         | Not listed               | ₹0 (free tier)                  | ₹0                                                                                |
| Email (Resend)    | ₹850-2,550               | ₹0 (free tier)                  | -₹850+                                                                            |
| **Total**         | **~₹6,850-29,550**       | **~₹9,927**                     | **Significantly lower than estimated for infrastructure, but Claude adds ₹9,070** |

**Key takeaway:** The previous document overestimated infrastructure costs (assumed paid tiers for everything) but completely missed the ₹9,070/month Claude Max expense. The net effect is that actual costs are within the same range but allocated very differently. If GST-registered, add 18% RCM on foreign SaaS (₹1,768/month currently), but this is claimable as ITC.

---

## Break-Even Infrastructure

### At Current Costs (~₹9,927/month SaaS, pre-GST)

```
Monthly SaaS: ₹9,927
Platform Revenue per ₹1,000 transaction: ~₹170 (at ~17% blended commission after gateway)
Break-even transactions: 9,927 / 170 = ~59 transactions/month

At 5 transactions/consultant/month: need ~12 active consultants
At 10 transactions/consultant/month: need ~6 active consultants
```

This is achievable within the first 1-2 months of launch.

### At Growth Costs (~₹57,000/month SaaS, pre-GST)

```
Monthly SaaS: ₹57,000
Break-even transactions: 57,000 / 170 = ~335 transactions/month

At 10 transactions/consultant/month: need ~34 active consultants
```

> **Note:** At growth stage, if GST-registered, you pay ~₹10,160/month in RCM on foreign SaaS but claim it back as ITC. Net SaaS cost remains the pre-GST figure if you're collecting GST from customers.

---

## GST Impact on Foreign SaaS (Reverse Charge Mechanism)

When GST-registered, you must pay 18% IGST on all imported services (foreign SaaS) under Reverse Charge Mechanism (RCM). This GST is claimable as Input Tax Credit (ITC), making it effectively net-zero if you collect GST from your customers.

### RCM Liability by Stage

| Stage         | Foreign SaaS (Pre-GST)  | RCM @ 18%       | Total With GST     | ITC Claimable |
| ------------- | ----------------------- | --------------- | ------------------ | ------------- |
| Pre-Launch    | ₹9,818 (Claude + Apple) | ₹1,768          | ₹11,586            | ₹1,768        |
| Early Revenue | ~₹9,818-₹11,632         | ~₹1,768-₹2,094  | ~₹11,586-₹13,726   | Same          |
| Growth        | ~₹56,438                | ~₹10,159        | ~₹66,597           | ₹10,159       |
| Scale         | ~₹45,488-₹1,07,237      | ~₹8,188-₹19,303 | ~₹53,676-₹1,26,540 | Same          |

> **Key insight:** If NOT GST-registered, you don't pay RCM but also can't claim ITC. If GST-registered and collecting GST from customers, the RCM is a cash flow timing issue (pay now, claim back in returns) but not an actual cost.

---

## Monitoring & Alerts

### Set Cost Alerts For

| Service   | Where to Monitor            | Alert When                      |
| --------- | --------------------------- | ------------------------------- |
| Supabase  | Dashboard → Usage           | 70% of any free tier limit      |
| Vercel    | Dashboard → Usage & Billing | 75% of bandwidth                |
| Stream.io | Dashboard → Usage           | 1,500 MAU (75% of 2K limit)     |
| Novu      | Dashboard → Usage           | 7,000 runs/month (70% of limit) |
| Resend    | Dashboard → Usage           | 70 emails/day (70% of limit)    |
| Upstash   | Dashboard → Usage           | 400K commands/month (80% of free tier) |
| Razorpay  | Dashboard → Settlements     | Refund rate > 5%                |
| Claude    | Subscription page           | Before renewal each month       |

---

## Related Documents

- [01-business-model.md](./01-business-model.md) - Revenue model and commission structure
- [05-saas-metrics-monthly.md](./05-saas-metrics-monthly.md) - SaaS metrics tracking
- [07-pricing-calculator.md](./07-pricing-calculator.md) - Pricing strategy
- [09-tax-compliance-india.md](./09-tax-compliance-india.md) - Tax compliance (GST, TDS, TCS)
- [10-profitability-minimum-pricing.md](./10-profitability-minimum-pricing.md) - Profitability analysis
- `temp/11-cfo-master-plan.md` - Comprehensive CFO financial blueprint (private, not in git)
- [../upstash/redis/04-pricing-and-cost-model.md](../upstash/redis/04-pricing-and-cost-model.md) - Upstash Redis command budget, growth projections, and plan decision guide
