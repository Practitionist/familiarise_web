---
description: Set up Razorpay integration — SDK, env vars, database schema, plan configuration. Use when the user asks to "set up razorpay", "add payments to my app", "initialize billing", "configure razorpay", or is starting a new Razorpay integration from scratch.
argument-hint: "[framework]"
---

# Razorpay Integration Setup

You are setting up Razorpay payment integration. Follow these steps precisely.


## Step 1: Install Dependencies

```bash
npm install razorpay
# or
pnpm add razorpay
```

## Step 2: Environment Variables

Create or update `.env.local`:

```
# Razorpay API Keys
RAZORPAY_KEY_ID=rzp_test_xxxxx          # Test key (rzp_live_xxxxx for production)
RAZORPAY_KEY_SECRET=xxxxx               # API secret
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_test_xxxxx  # Same as RAZORPAY_KEY_ID (client-side)
RAZORPAY_WEBHOOK_SECRET=xxxxx           # Webhook signature verification

# Plan IDs (create plans in Razorpay Dashboard first)
RAZORPAY_PLAN_MONTHLY=plan_xxxxx
RAZORPAY_PLAN_YEARLY=plan_xxxxx
```

**IMPORTANT**: Test keys start with `rzp_test_`, live keys with `rzp_live_`. Never commit secrets.

## Step 3: Razorpay Client Singleton

Create a shared Razorpay instance. Do NOT create new instances per request.

```typescript
// lib/razorpay.ts
import Razorpay from "razorpay";

// Validate required env vars at startup — fail early, not at first payment
const requiredEnvVars = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
] as const;

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});
```

## Step 4: Database Schema

You need these tables. Adapt to your ORM (Drizzle, Prisma, raw SQL):

### Subscriptions Table
```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL,
  plan_key VARCHAR NOT NULL,              -- e.g. "pro_monthly", "pro_yearly"
  razorpay_subscription_id VARCHAR UNIQUE NOT NULL,
  razorpay_plan_id VARCHAR NOT NULL,
  razorpay_customer_id VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'created',  -- created|authenticated|active|halted|cancelled|completed|paused
  current_period_end TIMESTAMP,
  last_event_id VARCHAR,                  -- Webhook idempotency
  last_payment_id VARCHAR,
  cancelled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_sub_user ON subscriptions(user_id);
CREATE INDEX idx_sub_rzp ON subscriptions(razorpay_subscription_id);
```

### GST Invoices Table (required for Indian businesses)
```sql
CREATE TABLE gst_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL,
  razorpay_invoice_id VARCHAR UNIQUE,     -- From Razorpay Invoice API (razorpay.invoices.create())
  razorpay_payment_id VARCHAR NOT NULL,
  razorpay_subscription_id VARCHAR,
  type VARCHAR NOT NULL,                  -- "subscription" | "one_time"
  plan_key VARCHAR,
  amount_paise INTEGER NOT NULL,
  base_paise INTEGER NOT NULL,            -- amount / 1.18
  cgst_paise INTEGER NOT NULL,            -- (amount - base) / 2
  sgst_paise INTEGER NOT NULL,            -- (amount - base) / 2
  short_url VARCHAR,                      -- Razorpay-hosted invoice page URL from Invoice API
  created_at TIMESTAMP DEFAULT NOW()
);
```

**NOTE**: The `razorpay_invoice_id` column stores the ID returned by the Razorpay Invoice API (`razorpay.invoices.create()`). Subscription payments do NOT auto-generate invoices — you must create them yourself via the Invoice API with proper line items (base amount, CGST, SGST). The `short_url` field stores the Razorpay-hosted invoice page URL for customer download.

## Step 5: Plan ID Management

Create a bidirectional plan lookup (env var driven):

```typescript
// lib/billing/plans.ts
type PlanKey = "pro_monthly" | "pro_yearly";

const PLAN_MAP: Record<PlanKey, { envVar: string; totalCount: number; displayName: string }> = {
  pro_monthly: { envVar: "RAZORPAY_PLAN_MONTHLY", totalCount: 60, displayName: "Pro Monthly" },
  pro_yearly: { envVar: "RAZORPAY_PLAN_YEARLY", totalCount: 5, displayName: "Pro Yearly" },
};

export function planIdFor(planKey: PlanKey): string {
  const entry = PLAN_MAP[planKey];
  const id = process.env[entry.envVar];
  if (!id) throw new Error(`Missing env var ${entry.envVar}`);
  return id;
}

export function planKeyFor(razorpayPlanId: string): PlanKey | null {
  for (const [key, entry] of Object.entries(PLAN_MAP)) {
    if (process.env[entry.envVar] === razorpayPlanId) return key as PlanKey;
  }
  return null;
}

export function totalCountFor(planKey: PlanKey): number {
  return PLAN_MAP[planKey].totalCount;
}
```

## Step 6: Create Razorpay Plans (Dashboard or API)

Plans must be created BEFORE subscriptions. Use the Razorpay Dashboard or API:

```bash
curl -u rzp_test_key:rzp_test_secret \
  https://api.razorpay.com/v1/plans \
  -H "Content-Type: application/json" \
  -d '{
    "period": "monthly",
    "interval": 1,
    "item": {
      "name": "Pro Plan Monthly",
      "amount": 99900,
      "currency": "INR",
      "description": "Pro plan billed monthly"
    },
    "notes": { "sac_code": "998314" }
  }'
```

**GST-inclusive pricing**: If your prices include GST, add `"tax_inclusive": true` when creating the plan.

**Pricing math** (18% GST included):
- Base = amount_paise / 1.18
- GST = amount_paise - base
- CGST = GST / 2, SGST = GST / 2

## Common Gotchas

1. **Test vs Live keys**: Subscriptions created with test keys cannot be accessed with live keys
2. **Plan IDs are environment-specific**: Test and live have different plan IDs
3. **Webhook secret is separate**: Not the same as API secret
4. **Phone normalization**: Strip non-digits before passing to Razorpay: `phone.replace(/[^\d+]/g, "")`
5. **`fail_existing: 0` TypeScript quirk**: Cast as `0 as 0 | 1` to satisfy TypeScript types
6. **Razorpay subscriptions do NOT include GST**: Razorpay charges the plan amount as-is. You must calculate and display GST yourself (18% for SaaS, SAC code 998314)
7. **Invoices must be created via Razorpay Invoice API**: Subscription payments do NOT auto-generate GST invoices. You must call `razorpay.invoices.create()` with line items for base amount, CGST, and SGST
8. **Multiple subscriptions per user can exist**: When a user changes plans, both old and new subscriptions coexist in Razorpay until the old one is explicitly cancelled. Never assume one subscription per user — always check for ANY active subscription
