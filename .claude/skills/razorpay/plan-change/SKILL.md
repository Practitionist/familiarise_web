---
description: Implement subscription plan changes with Razorpay — deferred cancellation pattern, no downtime. Use when the user asks to "upgrade plan", "downgrade subscription", "switch plans", "change billing plan", or needs to move users between subscription tiers without service interruption.
---

# Razorpay Plan Change (Upgrade / Downgrade)

The correct pattern for plan changes is **deferred cancellation** — create the new subscription first, let the webhook cancel the old one after payment succeeds. This prevents downtime if the user abandons checkout.

## Why NOT Cancel-Then-Create

```
BAD:  Cancel old → Create new → User abandons checkout → No subscription!
GOOD: Create new (with note) → User pays → Webhook cancels old → Seamless
```

## API Route: Change Plan

```typescript
// app/api/billing/change-plan/route.ts
export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { newPlanKey } = await request.json();

  try {
    // 1. Get current subscription
    const current = await getActiveSubscriptionByUserId(user.id);
    if (!current) {
      return Response.json({ error: "No active subscription" }, { status: 400 });
    }

    // 2. Prevent same-plan change
    if (current.planKey === newPlanKey) {
      return Response.json({ error: "Already on this plan" }, { status: 409 });
    }

    // 3. Create NEW subscription with reference to old one
    const planId = planIdFor(newPlanKey);
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: totalCountFor(newPlanKey),
      quantity: 1,
      customer_notify: 1,
      notes: {
        userId: user.id,
        planKey: newPlanKey,
        replacesSubscription: current.razorpaySubscriptionId,  // KEY: signals webhook
      },
    });

    // 4. DO NOT cancel old subscription here — webhook handles it
    // 5. DO NOT create DB row here — webhook auto-creates on activation

    return Response.json({
      shortUrl: subscription.short_url,
      subscriptionId: subscription.id,
    });
  } catch (error) {
    console.error("Failed to change plan:", error);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}
```

## Webhook: Handle `replacesSubscription`

In your `subscription.activated` webhook handler, check for `replacesSubscription` in notes:

```typescript
// Inside subscription.activated handler
const entity = event.payload.subscription.entity;

if (entity.notes?.replacesSubscription) {
  const oldSubId = entity.notes.replacesSubscription;

  // Cancel old subscription on Razorpay (at cycle end for grace)
  try {
    await razorpay.subscriptions.cancel(oldSubId, true);
  } catch {
    // Best-effort — may already be cancelled
  }

  // Mark old subscription as cancelled in DB
  await markSubscriptionCancelled(oldSubId);
}
```

## Client-Side: Upgrade Confirmation

```typescript
const handlePlanChange = async (newPlanKey: string) => {
  const confirmed = window.confirm(
    "Switching plans will cancel your current subscription after payment. Continue?"
  );
  if (!confirmed) return;

  const res = await fetch("/api/billing/change-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newPlanKey }),
  });

  const data = await res.json();
  if (data.shortUrl) {
    window.open(data.shortUrl, "_blank");
  }
};
```

## Key Rules

1. **Never cancel before new payment succeeds** — deferred cancellation only
2. **`notes.replacesSubscription`** is the coordination signal between route and webhook
3. **Webhook auto-creates DB row** if subscription not found but `notes.userId` + `notes.planKey` exist
4. **Old subscription stays active** until webhook confirms new payment
5. **Cancel with `true`** (at cycle end) — gives grace period for any billing cycle overlap

## Monthly ↔ Yearly: No Proration

Razorpay does NOT prorate. When switching plans:
- **Monthly → Yearly**: User pays full yearly amount immediately. Old monthly runs until webhook cancels it at cycle end. User briefly overpays (days left on monthly cycle).
- **Yearly → Monthly**: User pays full monthly amount immediately. Old yearly runs until cycle end. User might have months of unused yearly left.

**Recommendations:**
1. **Switch at cycle end**: Show "Your yearly plan starts when your current monthly cycle ends on [date]." Store the pending switch in your DB, trigger it via a cron or the `subscription.completed` webhook.
2. **Manual credit**: Calculate unused days on the old plan and issue a partial refund via the Refund skill.
3. **Keep it simple**: Most SaaS just lets the user switch immediately and eats the small overlap cost. The goodwill is worth more than a few days of proration.

## Gotchas

1. **No DB writes in the route**: The plan-change route only creates a Razorpay subscription. DB upsert happens in the webhook.
2. **Customer ID reuse**: Razorpay auto-links the customer if the same email is used.
3. **`cancel(id, true)` not `cancel(id, { at_cycle_end: true })`**: Second parameter is boolean, not object. SDK types may be misleading.
4. **Race window**: Between new subscription creation and old cancellation, user briefly has two subscriptions. Your access-check should handle this (any active = access granted).
5. **No proration**: Razorpay charges full plan amount. You handle credits/refunds yourself.
6. **Downgrade to free**: If you have a free tier, just cancel the subscription at cycle end and revoke premium access when the period expires. No new subscription needed.
