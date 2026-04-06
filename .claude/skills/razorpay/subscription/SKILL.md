---
description: Create Razorpay subscription checkout — hosted checkout, customer upsert, pending dedup, popup-blocked fallback. Use when the user asks to "add subscription billing", "set up recurring payments", "create hosted checkout", "implement subscriptions", or needs a checkout flow for recurring charges.
argument-hint: "[monthly|yearly|setup]"
---

# Razorpay Subscription Creation

Build a production-grade subscription creation flow. This handles customer creation, duplicate prevention, hosted checkout, and popup-blocked fallback.


## Architecture: Hosted Checkout (Not JS SDK)

Use Razorpay's hosted checkout (`short_url`) instead of the JS SDK popup. Why:
- Works on all browsers (no popup blockers)
- No client-side SDK bundle needed
- Razorpay handles the entire payment UI
- Mobile-friendly by default

## API Route: Create Subscription

```typescript
// app/api/billing/create-subscription/route.ts
import { razorpay } from "@/lib/razorpay";
import { planIdFor, totalCountFor } from "@/lib/billing/plans";

export async function POST(request: Request) {
  // 1. Authenticate user (your auth system)
  const user = await getAuthenticatedUser(request);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { planKey } = await request.json();

  try {
    // 2. Check for pending subscription (prevent duplicates)
    const existing = await getSubscriptionByUserId(user.id);
    if (existing) {
      const isPending = ["created", "authenticated", "pending"].includes(existing.status);
      const isRecent = Date.now() - existing.createdAt.getTime() < 3600_000; // 1 hour

      if (isPending && isRecent) {
        // Return existing checkout URL — user may have abandoned and returned
        return Response.json({
          shortUrl: null, // Cannot retrieve short_url after creation
          subscriptionId: existing.razorpaySubscriptionId,
          error: "Subscription already pending. Complete existing checkout or wait 1 hour.",
        }, { status: 409 });
      }

      if (isPending && !isRecent) {
        // Stale pending — cancel on Razorpay (best-effort)
        try {
          await razorpay.subscriptions.cancel(existing.razorpaySubscriptionId, false);
        } catch {
          // Ignore — may already be cancelled
        }
      }
    }

    // 3. Create or reuse Razorpay customer
    //    fail_existing: 0 = return existing customer if email matches (upsert)
    const customer = await razorpay.customers.create({
      name: user.name || "Customer",
      email: user.email,
      ...(user.phone ? { contact: user.phone.replace(/[^\d+]/g, "") } : {}),
      fail_existing: 0 as 0 | 1,  // TypeScript SDK quirk — needs explicit cast
    });

    // 4. Create subscription
    const planId = planIdFor(planKey);
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: totalCountFor(planKey),
      quantity: 1,
      customer_notify: 1,
      notes: {
        userId: user.id,
        planKey,
      },
      ...(user.email ? {
        notify_info: {
          notify_email: user.email,
          ...(user.phone ? { notify_phone: user.phone.replace(/[^\d+]/g, "") } : {}),
        },
      } : {}),
    });

    // 5. Save to database
    await createSubscriptionRecord({
      userId: user.id,
      planKey,
      razorpaySubscriptionId: subscription.id,
      razorpayPlanId: planId,
      razorpayCustomerId: customer.id,
      status: "created",
    });

    // 6. Return hosted checkout URL
    return Response.json({
      shortUrl: subscription.short_url,
      subscriptionId: subscription.id,
    });
  } catch (error) {
    console.error("Failed to create subscription:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}
```

## Client-Side: Popup + Fallback + Polling

```typescript
// components/checkout-button.tsx
"use client";
import { useState, useEffect } from "react";

export function CheckoutButton({ planKey }: { planKey: string }) {
  const [loading, setLoading] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  // Poll for activation when user returns from payment tab
  useEffect(() => {
    const handler = async () => {
      if (document.visibilityState !== "visible") return;
      const res = await fetch("/api/billing/status");
      const data = await res.json();
      if (data.active) {
        window.location.href = "/dashboard"; // Redirect on success
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  const handleCheckout = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/billing/create-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planKey }),
      });
      const data = await res.json();

      if (!data.shortUrl) {
        alert(data.error || "Failed to create checkout");
        return;
      }

      // Try opening in new tab
      const popup = window.open(data.shortUrl, "_blank");

      if (!popup || popup.closed) {
        // Popup was blocked — show fallback link
        setFallbackUrl(data.shortUrl);
      }
    } catch (error) {
      alert("Failed to start checkout");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button onClick={handleCheckout} disabled={loading}>
        {loading ? "Creating checkout..." : "Subscribe"}
      </button>

      {fallbackUrl && (
        <div style={{ marginTop: 12, padding: 12, background: "#fef3c7", borderRadius: 8 }}>
          <p>Popup was blocked by your browser.</p>
          <a href={fallbackUrl} target="_blank" rel="noopener">
            Open payment page &rarr;
          </a>
        </div>
      )}
    </div>
  );
}
```

## Key Patterns

### Pending Subscription Dedup
- Check for existing `created|authenticated|pending` subscriptions
- If recent (< 1 hour): block duplicate creation (409)
- If stale (> 1 hour): cancel on Razorpay, allow new creation
- NEVER allow two active subscriptions for the same plan

### Customer Upsert
- `fail_existing: 0` returns existing customer if email matches
- Always strip phone formatting: `.replace(/[^\d+]/g, "")`
- Omit `contact` field entirely if phone is null (don't pass empty string)

### Popup-Blocked Detection
```javascript
const popup = window.open(url, "_blank");
if (!popup || popup.closed) {
  // Show fallback link
}
```

### Payment Completion Detection
Use `visibilitychange` event — fires when user switches back to your tab after completing payment in Razorpay's tab. Poll your status endpoint to check if webhook has activated the subscription.

## Billing Intervals: Monthly, Yearly, and Upfront

### Plan Configuration

Plans are created in Razorpay Dashboard or via API. Each plan has a fixed interval (`monthly` or `yearly`) and amount. You map them in your config:

```typescript
// lib/billing/plans.ts
export const PLANS = {
  monthly: {
    razorpayPlanId: process.env.RAZORPAY_PLAN_ID_MONTHLY!,
    name: "Monthly",
    interval: "monthly",
    totalCount: 60,    // Max 60 charges = 5 years
    amount: 49900,     // ₹499 in paise
  },
  yearly: {
    razorpayPlanId: process.env.RAZORPAY_PLAN_ID_YEARLY!,
    name: "Yearly",
    interval: "yearly",
    totalCount: 5,     // Max 5 charges = 5 years
    amount: 499900,    // ₹4,999 in paise
  },
} as const;
```

### Pay Upfront (Default)

By default, Razorpay charges the first payment immediately when the user completes checkout. This is the standard flow — no extra configuration needed.

### Free Trial / Delayed Start

Razorpay subscriptions do NOT have a native "trial" feature. Simulate it with `start_at`:

```typescript
const trialDays = 14;
const startAt = Math.floor(Date.now() / 1000) + (trialDays * 86400);

const subscription = await razorpay.subscriptions.create({
  plan_id: planId,
  total_count: totalCountFor(planKey),
  quantity: 1,
  start_at: startAt,  // First charge happens after trial
  notes: { userId: user.id, planKey, trialEndsAt: new Date(startAt * 1000).toISOString() },
});
```

**Gotcha**: With `start_at`, the user still goes through checkout and authorizes their card. Razorpay places a ₹0 or ₹1 auth hold. The first real charge happens at `start_at`. Track trial end in your DB to show "Trial ends on X" in the UI.

### Upfront Extra Charge (Setup Fee)

To charge extra on the first billing cycle (e.g., setup fee + first month):

```typescript
const subscription = await razorpay.subscriptions.create({
  plan_id: planId,
  total_count: totalCountFor(planKey),
  quantity: 1,
  // addons charge extra on the FIRST payment only
  // This creates a one-time ₹999 setup fee on top of the plan amount
  notes: { userId: user.id, planKey },
});

// Alternative: use offer_id for discounts on first charge
// Offers are created in Razorpay Dashboard under Subscriptions → Offers
```

**Important**: Razorpay subscriptions don't support arbitrary upfront amounts as a parameter. For true setup fees, create a separate one-time order (see the `one-time-payment` skill) before or after the subscription.

### Offer / Coupon Codes

Razorpay supports subscription offers (discounts) — created in the Dashboard:

```typescript
const subscription = await razorpay.subscriptions.create({
  plan_id: planId,
  total_count: totalCountFor(planKey),
  quantity: 1,
  offer_id: "offer_XXXXX",  // Created in Razorpay Dashboard
  notes: { userId: user.id, planKey },
});
```

Offers can discount the first N cycles or all cycles. You cannot create offers via API — Dashboard only.

## Monthly ↔ Yearly Switching

**Razorpay does NOT prorate.** When a user switches from monthly to yearly (or vice versa):
- They pay the FULL new plan amount immediately
- The old subscription runs until the webhook cancels it (deferred cancellation pattern)
- No credit is given for unused time on the old plan

If you want to offer proration, you must calculate the credit yourself:

```typescript
// In your plan-change API route
const daysRemaining = Math.ceil(
  (currentPeriodEnd.getTime() - Date.now()) / 86400_000
);
const dailyRate = currentPlan.amount / 30; // monthly plan
const credit = Math.round(daysRemaining * dailyRate);

// Option 1: Apply credit as a note (for manual adjustment)
// Option 2: Create a one-time refund for the prorated amount
// Option 3: Use Razorpay's offer system to discount the first yearly charge
```

**Recommendation**: For simplicity, switch at cycle end. Show the user: "Your yearly plan starts when your current monthly cycle ends on [date]." This avoids the proration mess entirely.

## Gotchas

1. **`short_url` is one-time**: You cannot retrieve it after creation. If lost, create a new subscription.
2. **`fail_existing` TypeScript**: Cast `0 as 0 | 1` — Razorpay SDK types are wrong.
3. **`notify_info` conditional**: Only include if you have email/phone. Empty object causes errors.
4. **`total_count`**: Monthly = 60 (5 years max), Yearly = 5 (5 years max). This is max renewals, not billing cycles.
5. **Customer without phone**: Omit the `contact` field entirely — don't pass null or empty string.
6. **No proration**: Razorpay charges the full plan amount on every cycle. There is no built-in proration for mid-cycle plan changes.
7. **No native trials**: Use `start_at` to delay the first real charge. Card is authorized at checkout.
8. **Offers are Dashboard-only**: You cannot create discount offers via API. Create them in Razorpay Dashboard → Subscriptions → Offers.
