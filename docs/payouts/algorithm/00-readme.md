# Payout Algorithm Documentation

> Complete documentation for the Familiarise consultant payout system

---

## Quick Navigation

| I want to...                       | Go to                                                  |
| ---------------------------------- | ------------------------------------------------------ |
| Understand the system architecture | [01-architecture.md](./01-architecture.md)             |
| Learn how earnings work            | [02-earnings-lifecycle.md](./02-earnings-lifecycle.md) |
| Understand payout processing       | [03-payout-processing.md](./03-payout-processing.md)   |
| Reference API endpoints            | [04-api-reference.md](./04-api-reference.md)           |
| Configure the system               | [05-configuration.md](./05-configuration.md)           |

---

## System Overview

The payout system handles the complete lifecycle of consultant earnings:

1. **Payment Success** - When a consultee pays for a service
2. **Earnings Creation** - Platform takes 20% fee, consultant gets 80%
3. **Hold Period** - Earnings held for 24-168 hours (by type)
4. **Ready for Payout** - After hold period, eligible for batching
5. **Batch Creation** - Weekly batches group eligible earnings
6. **Admin Approval** - Large payouts require manual approval
7. **Processing** - Sent to RazorpayX or Stripe Connect
8. **Completion** - Webhook confirms delivery

---

## Key Stats

| Category                  | Count | Details                                                            |
| ------------------------- | ----- | ------------------------------------------------------------------ |
| **Database Models**       | 4     | ConsultantEarnings, Payout, PayoutAccount, Invoice                 |
| **Services**              | 3     | EarningsService, PayoutService, InvoiceService                     |
| **Provider Integrations** | 2     | RazorpayX (INR), Stripe Connect (International)                    |
| **Cron Jobs**             | 3     | Release earnings (hourly), Create batch (weekly), Process (weekly) |
| **API Endpoints**         | 12+   | Admin, Staff, Consultant routes                                    |

---

## File Structure

```
lib/payments/payouts/
├── index.ts                 # Central exports
├── constants.ts             # Configuration constants
├── earnings-service.ts      # Earnings lifecycle management
├── payout-service.ts        # Payout batch & processing
├── invoice-service.ts       # Invoice generation
├── razorpay-payouts.ts      # RazorpayX integration
└── stripe-connect.ts        # Stripe Connect integration

scripts/
├── release-earnings.ts      # Hourly: PENDING → READY
├── create-payout-batch.ts   # Weekly: Create batches
└── process-payouts.ts       # Weekly: Process approved

.github/workflows/
├── release-earnings.yml     # Hourly schedule
├── create-payout-batch.yml  # Monday 1:30 AM IST
└── process-payouts.yml      # Monday 2:30 AM IST
```

---

## Quick Start Checklist

### For New Developers

- [ ] Read [01-architecture.md](./01-architecture.md) for system overview
- [ ] Understand earnings flow in [02-earnings-lifecycle.md](./02-earnings-lifecycle.md)
- [ ] Review database models in Prisma schema
- [ ] Check environment variables in [05-configuration.md](./05-configuration.md)

### For DevOps/Deployment

- [ ] Configure GitHub Actions secrets (DATABASE_URL, payment keys)
- [ ] Verify cron schedules in `.github/workflows/`
- [ ] Set up RazorpayX webhook endpoints
- [ ] Set up Stripe webhook endpoints

### For Testing

- [ ] Use mock payments (isMockPayment flag)
- [ ] Test hold period release with shorter durations
- [ ] Verify webhook handling with test events

---

## Key Constants

| Constant           | Value | Purpose                       |
| ------------------ | ----- | ----------------------------- |
| Platform Fee       | 20%   | Deducted from each payment    |
| Consultant Share   | 80%   | Net amount to consultant      |
| Minimum Payout     | ₹500  | Threshold for batch inclusion |
| Auto-Approve Limit | ₹5000 | Below this, auto-approved     |
| Max Retries        | 3     | Failed payout retry limit     |

### Hold Periods by Appointment Type

| Type         | Hold Period | Rationale                  |
| ------------ | ----------- | -------------------------- |
| Consultation | 24 hours    | Short-term service         |
| Class        | 24 hours    | Similar to consultation    |
| Webinar      | 48 hours    | Allow participant feedback |
| Subscription | 7 days      | Longer commitment period   |

---

## Related Documentation

- [Payment System Architecture](../../payments/architecture.md)
- [Checkout Flow](../../payments/checkout-flow/01-checkout-flow.md)
- [Payout Architecture (Business)](../../finances/02-payout-architecture.md)
- [Booking Algorithm](../../booking/algorithm/00-readme.md)

---

## Changelog

| Date       | Change                                                    |
| ---------- | --------------------------------------------------------- |
| 2025-12-26 | Initial documentation created                             |
| 2025-12-26 | Payout system implemented with RazorpayX + Stripe Connect |
