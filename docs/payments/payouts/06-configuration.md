# Configuration Guide

> **Moved (org/B2B side):** The organization-side documentation for payouts now lives in [`docs/enterprise/10-money-and-ledger/07-payout-pipeline.md`](../../enterprise/10-money-and-ledger/07-payout-pipeline.md) and [`02-earnings-lifecycle.md`](../../finance/40-payouts/02-earnings-lifecycle.md). This file keeps the consumer-marketplace (B2C) and gateway-generic details only.

> Environment variables, constants, and setup instructions

---

## Environment Variables

### Required for Production

```bash
# Database
DATABASE_URL="postgresql://user:password@host:5432/database"

# RazorpayX (INR Payouts)
RAZORPAY_KEY_ID="rzp_live_xxxxx"
RAZORPAY_KEY_SECRET="xxxxx"
RAZORPAYX_ACCOUNT_NUMBER="2323230012345678"
# Static-egress proxy; live RazorpayX answers only allowlisted IPs and Netlify has none.
# A live key without it is refused (RAZORPAYX_EGRESS_NOT_CONFIGURED).
RAZORPAYX_EGRESS_PROXY_URL="http://user:password@static-ip-proxy:3128"

# Stripe (International Payouts)
STRIPE_SECRET_KEY="sk_live_xxxxx"
STRIPE_WEBHOOK_SECRET="whsec_xxxxx"

# Cron Authentication
PAYOUT_CRON_SECRET="random-secret-for-cron-jobs"
```

### Development/Testing

```bash
# Use test/sandbox keys
RAZORPAY_KEY_ID="rzp_test_xxxxx"
RAZORPAY_KEY_SECRET="xxxxx"

STRIPE_SECRET_KEY="sk_test_xxxxx"

# Enable mock payments (skip gateway calls)
ENABLE_MOCK_PAYMENTS="true"
```

---

## Payout Constants

Located in `lib/payments/payouts/constants.ts`:

```typescript
export const PAYOUT_CONSTANTS = {
  // Revenue split
  PLATFORM_FEE_PERCENTAGE: 20, // Platform takes 20%
  CONSULTANT_SHARE_PERCENTAGE: 80, // Consultant gets 80%

  // Thresholds (in paise)
  MINIMUM_PAYOUT_AMOUNT: 50000, // ₹500 minimum
  AUTO_APPROVE_THRESHOLD: 500000, // ₹5000 auto-approve limit

  // Hold periods (hours)
  HOLD_PERIOD_HOURS: {
    CONSULTATION: 24, // 24 hours
    WEBINAR: 48, // 48 hours
    SUBSCRIPTION: 168, // 7 days
    CLASS: 24, // 24 hours
  },

  // Retry config
  MAX_RETRY_ATTEMPTS: 3,
};
```

### Modifying Constants

To change thresholds:

1. Update values in `constants.ts`
2. Redeploy the application
3. New values take effect immediately for new operations

**Note:** Changes don't affect existing payouts/earnings.

---

## Tax Constants

```typescript
export const TAX_CONSTANTS = {
  GST_RATE: 18, // 18% GST
  SAC_CODE: "999293", // Consulting services

  HSN_CODES: {
    CONSULTING: "999293", // SAC for consulting
    EDUCATION: "999294", // SAC for education
    TRAINING: "999295", // SAC for training
  },
};
```

---

## Payout Mode Limits

```typescript
export const PAYOUT_MODES = {
  IMPS_LIMIT: 50000000, // ₹5 Lakh - instant transfer
  RTGS_MIN: 20000000, // ₹2 Lakh - RTGS minimum
};
```

| Mode | Amount Range  | Speed       | Availability |
| ---- | ------------- | ----------- | ------------ |
| IMPS | Up to ₹5 Lakh | < 5 minutes | 24x7         |
| NEFT | Any amount    | 2-4 hours   | Bank hours   |
| RTGS | ₹2 Lakh+      | 30 minutes  | Bank hours   |
| UPI  | Up to ₹1 Lakh | Instant     | 24x7         |

---

## Scheduling

The payout jobs run on the five-minute Netlify scheduled ticker (`netlify/functions/cron-tick.mts`), which calls each job's `CRON_SECRET`-gated twin under `/api/cleanup/[job]`. They do not run in GitHub Actions. The registry is `lib/cron/cleanup-registry.ts`, and each job runs under `withCronLock`.

| Job                   | Window and cadence (UTC)                                           | Per-run bite                     |
| --------------------- | ------------------------------------------------------------------ | -------------------------------- |
| `release-earnings`    | Every 15 minutes, at minute :05                                    | Default limit of 50              |
| `create-payout-batch` | Mondays from 20:00 for three hours, every 15 minutes at minute :05 | 10 consultant and 10 org payouts |
| `process-payouts`     | Every hour at minute :00                                           | 5 payouts per rail               |

IST is UTC+5:30, so the Monday 20:00 UTC window opens at 01:30 IST on Tuesday. A windowed job receives its window start as `?windowStart=` so that every slice of one window works on the same cohort. `reconcile-payout-status` and `handle-stuck-payouts` stay in `.github/workflows/cron-intra-day.yml`. Disbursement is additionally gated on `ENABLE_LIVE_PAYOUTS`.

### Changing a schedule

Edit `TARGET_EVERY_MINUTES`, `TARGET_OFFSET_MINUTES` and `TARGET_WINDOWS` in `netlify/functions/cron-tick.mts`. A tick may fire at most `MAX_TARGETS_PER_TICK` targets, and the cadence test pins that.

---

## RazorpayX Setup

### 1. Enable RazorpayX

1. Log in to Razorpay Dashboard
2. Go to **RazorpayX** section
3. Complete business verification
4. Enable **Payouts** feature

### 2. Get API Credentials

1. Go to **Settings → API Keys**
2. Generate new key pair for RazorpayX
3. Save both `key_id` and `key_secret`

### 3. Get Account Number

1. Go to **RazorpayX → Account Details**
2. Copy your **Account Number**
3. Set as `RAZORPAYX_ACCOUNT_NUMBER`

### 4. Configure Webhooks

1. Go to **Settings → Webhooks**
2. Add endpoint: `https://yourdomain.com/api/webhooks/razorpay`
3. Select events:
   - `payout.processed`
   - `payout.failed`
   - `payout.reversed`
4. Copy webhook secret

---

## Stripe Connect Setup

### 1. Enable Connect

1. Log in to Stripe Dashboard
2. Go to **Connect → Settings**
3. Enable **Express** or **Standard** accounts
4. Configure branding and terms

### 2. Get API Keys

1. Go to **Developers → API Keys**
2. Copy **Secret Key** for production
3. Use **Test Key** for development

### 3. Configure Webhooks

1. Go to **Developers → Webhooks**
2. Add endpoint: `https://yourdomain.com/api/webhooks/stripe`
3. Select events:
   - `account.updated`
   - `transfer.created`
   - `transfer.failed`
   - `transfer.reversed`
4. Copy webhook secret

### 4. Platform Settings

1. Go to **Connect → Settings**
2. Set **Payout schedule**: Manual or Automatic
3. Configure **Statement descriptors**
4. Set **Branding** for onboarding pages

---

## NPM Scripts

Added to `package.json`:

```json
{
  "scripts": {
    "scripts:release-earnings": "npx tsx scripts/earnings/release-earnings.ts"
  }
}
```

### Running Manually

```bash
# Release earnings from hold
npm run scripts:release-earnings
```

To run the batch or the disbursement on demand, use System Jobs "Run now" in the back office, or `POST /api/admin/payouts` (batch) and `POST /api/admin/payouts/process`. Each is an admin money door (ADMIN, step-up, reason).

---

## Testing Configuration

### Mock Payments

Enable mock mode to skip gateway calls:

```typescript
// In payment creation
const payment = await prisma.payment.create({
  data: {
    ...paymentData,
    isMockPayment: true, // Skip gateway
  },
});
```

### Shorter Hold Periods

For testing, temporarily modify constants:

```typescript
// lib/payments/payouts/constants.ts
HOLD_PERIOD_HOURS: {
  CONSULTATION: 0.1,  // 6 minutes for testing
  WEBINAR: 0.1,
  SUBSCRIPTION: 0.1,
  CLASS: 0.1,
},
```

**Remember to revert before production!**

### Manual Script Testing

```bash
# Test release script
npm run scripts:release-earnings

# Check output
# ✅ Released 5 earnings from hold
# 📊 Total: 5 released, 0 skipped
```

---

## Monitoring & Logging

### Script Output

All scripts log to stdout with emoji indicators:

```
🚀 Starting earnings release...
📦 Found 10 pending earnings
✅ Released 8 earnings
⏳ 2 still in hold period
📊 Summary: 8 released, 2 pending
```

### GitHub Actions Logs

1. Go to **Actions** tab in repository
2. Click on workflow run
3. View step-by-step logs
4. Check for `::error::` annotations

### Error Notifications

Configure in workflow files:

```yaml
- name: Notify on failure
  if: failure()
  run: |
    # Send Slack notification
    # Send email alert
```

---

## Troubleshooting

### Common Issues

| Issue                  | Cause              | Solution                                       |
| ---------------------- | ------------------ | ---------------------------------------------- |
| Payouts not processing | Missing API keys   | Check environment variables                    |
| Webhook not received   | Wrong endpoint URL | Verify webhook configuration                   |
| Earnings not releasing | Ticker not running | Check the Netlify function log for `cron-tick` |
| Bank transfer failed   | Invalid IFSC       | Verify account details                         |

### Debug Steps

1. **Check cron jobs**: open the `cron-tick` function log on Netlify, or System Jobs in the back office
2. **Verify webhooks**: Check Stripe/Razorpay webhook logs
3. **Database state**: Query earnings/payouts tables
4. **API logs**: Check Vercel/server logs

### Support Resources

- [RazorpayX Documentation](https://razorpay.com/docs/razorpayx/)
- [Stripe Connect Documentation](https://stripe.com/docs/connect)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)

---

## Back to [00-readme.md](./00-readme.md)
