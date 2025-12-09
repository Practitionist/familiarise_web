# SaaS Expenditures & Infrastructure Costs

## Overview

This document details the current and projected SaaS expenditures for Familiarise. All costs are based on actual pricing as of December 2025.

---

## Current Tech Stack Costs

### Infrastructure & Hosting

| Service | Plan | Monthly Cost (USD) | Monthly Cost (INR) | Notes |
|---------|------|-------------------|-------------------|-------|
| [Vercel](https://vercel.com/pricing) | Pro | $20/seat | ~₹1,700/seat | Frontend hosting, Edge functions |
| [Supabase](https://supabase.com/pricing) | Pro | $25 + usage | ~₹2,100 base | 8GB DB, 100GB storage, 100K MAUs |

### Payment Processing

| Service | Fee Structure | Example on ₹1,000 | Notes |
|---------|---------------|-------------------|-------|
| [Razorpay](https://razorpay.com) | 2% + 18% GST | ~₹24 (2.36%) | Domestic cards, UPI, netbanking |
| Razorpay (International) | 3% + 18% GST | ~₹35 (3.54%) | International cards |
| Razorpay UPI | ~0-1% | ~₹0-10 | Lowest fees |
| Stripe (if used) | 2.9% + $0.30 | ~₹54 | Higher base rate |

**Source**: [Razorpay Pricing](https://razorpay.com/docs/)

### Communication & Notifications

| Service | Plan | Monthly Cost | Notes |
|---------|------|--------------|-------|
| [Resend](https://resend.com/pricing) | Pro | $20-50 | Transactional emails (10K-100K/mo) |
| SMS Provider | Pay-per-SMS | ~₹0.15-0.25/SMS | OTP, notifications |
| [Twilio](https://www.twilio.com/pricing) (alt) | Usage | ~$0.0079/SMS | International SMS |

### Video & Real-time

| Service | Plan | Monthly Cost | Notes |
|---------|------|--------------|-------|
| Stream.io / Daily.co | Pro | ₹10,000-25,000 | WebRTC video calls |
| Agora (alternative) | Usage | ~$0.99/1000 min | Pay-per-minute |
| 100ms (alternative) | Starter | Free-₹8,000 | 10K free minutes |

### Analytics & Monitoring

| Service | Plan | Monthly Cost | Notes |
|---------|------|--------------|-------|
| [Mixpanel](https://mixpanel.com/pricing) | Growth | Free-$24 | User analytics, 10K MTU free |
| [PostHog](https://posthog.com/pricing) | Free | $0 | 1M events/mo free |
| [Sentry](https://sentry.io/pricing) | Team | $26/mo | Error tracking |
| Vercel Analytics | Included | $0 | Basic with Pro plan |

### Other Services

| Service | Plan | Cost | Notes |
|---------|------|------|-------|
| Domain | Annual | ~₹1,000-1,500/yr | .com/.in domain |
| SSL Certificate | Included | $0 | Via Vercel/Cloudflare |
| [Cloudflare](https://www.cloudflare.com/plans) | Free | $0 | CDN, DDoS protection |
| GitHub | Team | $4/user/mo | Code repository |

---

## Cost Projections by Stage

### Stage 1: MVP (0-100 users)

| Category | Monthly Cost |
|----------|--------------|
| Vercel Pro (2 seats) | ₹3,400 (~$40) |
| Supabase Pro | ₹2,100 (~$25) |
| Email (Resend) | ₹850 (~$10) |
| Video (100ms Free) | ₹0 |
| Domain + Misc | ₹500 |
| **Total** | **~₹6,850/mo** |

### Stage 2: Growth (100-1,000 users)

| Category | Monthly Cost |
|----------|--------------|
| Vercel Pro (4 seats) | ₹6,800 (~$80) |
| Supabase Pro + compute | ₹5,000 (~$60) |
| Email (Resend Pro) | ₹2,550 (~$30) |
| Video (Paid tier) | ₹10,000 |
| SMS (5K/mo) | ₹1,000 |
| Analytics | ₹2,000 (~$24) |
| Sentry | ₹2,200 (~$26) |
| **Total** | **~₹29,550/mo** |

### Stage 3: Scale (1,000-10,000 users)

| Category | Monthly Cost |
|----------|--------------|
| Vercel Pro (10 seats) | ₹17,000 (~$200) |
| Supabase Pro + XL compute | ₹15,000 (~$175) |
| Email | ₹4,250 (~$50) |
| Video | ₹25,000 |
| SMS (25K/mo) | ₹5,000 |
| Analytics (Paid) | ₹8,500 (~$100) |
| Sentry Team | ₹6,800 (~$80) |
| CDN/Security | ₹4,250 (~$50) |
| **Total** | **~₹85,800/mo** |

### Stage 4: Enterprise (10,000+ users)

| Category | Monthly Cost |
|----------|--------------|
| Vercel Enterprise | Custom ($20K+/yr) |
| Supabase Team/Enterprise | ₹50,000+ (~$600+) |
| All services scaled | Variable |
| **Total** | **₹2,00,000+/mo** |

---

## Per-Transaction Cost Breakdown

### Example: ₹1,000 Consultation

| Cost Component | Amount | % of Transaction |
|----------------|--------|------------------|
| Razorpay Gateway | ₹24 (2% + GST) | 2.4% |
| Server/DB cost (estimated) | ₹2 | 0.2% |
| Video minutes (30 min) | ₹15 | 1.5% |
| Email notifications (3) | ₹0.50 | 0.05% |
| SMS notifications (2) | ₹0.40 | 0.04% |
| **Total Variable Cost** | **~₹42** | **4.2%** |

### Margin Analysis

```
Transaction: ₹1,000
- Gateway Fee: ₹24 (2.4%)
- Variable Costs: ₹18 (1.8%)
= Net Available: ₹958

Platform Commission (20%): ₹192
Consultant Share (80%): ₹766

Platform Margin after costs: ₹192 - ₹18 = ₹174 (17.4%)
```

---

## Supabase Detailed Breakdown

### Pro Plan ($25/month) Includes

| Resource | Included | Overage Cost |
|----------|----------|--------------|
| Database Size | 8 GB | $0.125/GB |
| Storage | 100 GB | $0.021/GB |
| Egress | 250 GB | $0.09/GB |
| MAUs (Auth) | 100,000 | $0.00325/MAU |
| Edge Functions | 2M invocations | $2/million |
| Realtime Messages | 5M | $2.5/million |

### Compute Add-ons

| Size | Monthly Cost | Use Case |
|------|--------------|----------|
| Micro | Included | Development |
| Small | $10/mo | Light production |
| Medium | $25/mo | Standard production |
| Large | $50/mo | High traffic |
| XL | $100/mo | Heavy workloads |

**Source**: [Supabase Pricing](https://supabase.com/pricing)

---

## Vercel Detailed Breakdown

### Pro Plan ($20/seat/month) Includes

| Resource | Included | Overage Cost |
|----------|----------|--------------|
| Bandwidth | 1 TB | $40/100GB |
| Serverless Executions | 1M | $0.60/million |
| Edge Middleware | 1M | $0.65/million |
| Image Optimization | 5K | $5/1K |
| Build Hours | 400 | $0.50/hour |

### Team Considerations

- **Viewer seats** are FREE (read-only access)
- Only deployers need paid seats
- Typical early team: 2-4 paid seats

**Source**: [Vercel Pricing](https://vercel.com/pricing)

---

## Cost Optimization Strategies

### 1. Use Free Tiers Wisely

| Service | Free Tier Limit |
|---------|-----------------|
| Supabase | 2 projects, 500MB DB |
| Vercel | 100GB bandwidth, 100hrs build |
| PostHog | 1M events/month |
| Resend | 100 emails/day |
| 100ms | 10K free minutes/month |

### 2. Right-Size Infrastructure

- Start with Supabase Small compute, scale up as needed
- Use Vercel Edge Functions for lightweight operations
- Cache aggressively to reduce DB queries

### 3. Optimize Video Costs

| Strategy | Savings |
|----------|---------|
| Limit max call duration | 20-30% |
| Use audio-only for check-ins | 50% |
| Compress video quality | 15-25% |

### 4. Bundle Services

- Vercel + Supabase often offer discounts together
- Annual billing typically saves 10-20%

---

## Annual Cost Summary

### Year 1 Projection (MVP → Growth)

| Quarter | Monthly Avg | Quarterly Total |
|---------|-------------|-----------------|
| Q1 | ₹10,000 | ₹30,000 |
| Q2 | ₹20,000 | ₹60,000 |
| Q3 | ₹35,000 | ₹1,05,000 |
| Q4 | ₹50,000 | ₹1,50,000 |
| **Year 1 Total** | | **₹3,45,000** |

### Break-Even Infrastructure

To cover infrastructure costs with platform revenue:

```
Monthly Infra Cost: ₹30,000
Platform Revenue per ₹1,000 transaction: ₹174 (net)
Break-even transactions: 30,000 / 174 = ~173 transactions/month

At 10 transactions/consultant/month:
Need: ~17 active consultants to cover infra
```

---

## Monitoring & Alerts

### Set Cost Alerts For

| Service | Alert Threshold |
|---------|-----------------|
| Supabase | 80% of included quotas |
| Vercel | 75% of bandwidth |
| Razorpay | Track refund rate |
| Overall | Monthly budget +20% |

### Tools for Cost Monitoring

- Supabase Dashboard → Usage tab
- Vercel Dashboard → Usage & Billing
- Custom dashboard with Mixpanel/PostHog

---

## Related Documents

- [01-business-model.md](./01-business-model.md) - Revenue model
- [05-saas-metrics-monthly.md](./05-saas-metrics-monthly.md) - Track metrics
- [07-pricing-calculator.md](./07-pricing-calculator.md) - Pricing strategy
