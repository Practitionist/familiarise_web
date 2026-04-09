---
name: stripe-migration
description: Migrate from Stripe to Razorpay — concept mapping, code migration patterns, parallel running. Use when the user asks to "migrate from stripe", "switch to razorpay", "move from stripe to razorpay", "run stripe and razorpay together", or needs to transition an existing Stripe billing system.
argument-hint: "[mapping|migration-plan|parallel]"
---

# Stripe to Razorpay Migration

Migrate an existing Stripe integration to Razorpay. Covers concept mapping, code patterns, parallel provider strategies, and gotchas that bite during the switch.


## Concept Mapping

| Stripe | Razorpay | Notes |
|--------|----------|-------|
| Customer | Customer | Similar API, different fields |
| Price / Product | Plan | Razorpay uses a single Plan object (no separate Price) |
| Subscription | Subscription | Different lifecycle states and params |
| PaymentIntent | Order | Razorpay Orders are simpler — no confirm step |
| Checkout Session | Hosted checkout (`short_url`) | Razorpay returns a URL on subscription creation |
| Webhook | Webhook | Different event names, different signature scheme |
| `stripe.webhooks.constructEvent()` | Manual HMAC verification | See signature section below |
| Stripe CLI (`stripe listen`) | ngrok + Razorpay Dashboard | No local CLI forwarding tool |
| Customer portal | No equivalent | Must build subscription management UI yourself |

## Webhook Event Mapping

| Stripe Event | Razorpay Event | Notes |
|-------------|----------------|-------|
| `checkout.session.completed` | `subscription.activated` | Razorpay fires on first successful charge |
| `invoice.paid` | `subscription.charged` | Recurring payment success |
| `invoice.payment_failed` | `payment.failed` | Check `subscription_id` in payload to link |
| `customer.subscription.deleted` | `subscription.cancelled` | Also check `subscription.completed` and `subscription.halted` |
| `customer.subscription.updated` | `subscription.updated` | Detect plan changes via `plan_id` field |
| `charge.refunded` | `payment.refund.processed` | Different payload structure |

## Code Migration Patterns

### SDK Initialization

```typescript
// ── Stripe ──
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// ── Razorpay ──
import Razorpay from "razorpay";
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});
```

### Subscription Creation

```typescript
// ── Stripe ──
const session = await stripe.checkout.sessions.create({
  mode: "subscription",
  line_items: [{ price: priceId, quantity: 1 }],
  success_url: "https://example.com/success",
  cancel_url: "https://example.com/cancel",
});
// Redirect to session.url

// ── Razorpay ──
const subscription = await razorpay.subscriptions.create({
  plan_id: planId,          // Must create plan first (no inline prices)
  total_count: 60,          // Max billing cycles
  quantity: 1,
  customer_notify: 1,
  notes: { userId, planKey },
});
// Redirect to subscription.short_url
```

### Webhook Signature Verification

```typescript
// ── Stripe ──
const event = stripe.webhooks.constructEvent(
  rawBody,
  request.headers["stripe-signature"],
  process.env.STRIPE_WEBHOOK_SECRET!
);

// ── Razorpay ──
import crypto from "crypto";

const signature = request.headers.get("x-razorpay-signature");
const expected = crypto
  .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!)
  .update(rawBody)  // MUST be raw body string, not parsed JSON
  .digest("hex");

const isValid = crypto.timingSafeEqual(
  Buffer.from(expected, "hex"),
  Buffer.from(signature!, "hex")
);
```

### Checkout Redirect

```typescript
// ── Stripe ──
window.location.href = session.url;

// ── Razorpay ──
const popup = window.open(subscription.short_url, "_blank");
if (!popup || popup.closed) {
  // Show fallback link — popup blockers are common
  showFallbackLink(subscription.short_url);
}
```

## Migration Strategy for Existing Subscribers

Do NOT migrate active Stripe subscriptions. Let them expire naturally.

1. **New signups** go to Razorpay immediately
2. **Existing Stripe subscribers** continue on Stripe until their subscription expires or cancels
3. **When a Stripe sub ends**, redirect the user to Razorpay checkout on their next visit
4. **Run both providers in parallel** during the transition period

### Access Check (Parallel Providers)

```typescript
async function hasActiveSubscription(userId: string): Promise<boolean> {
  const [stripeSub, razorpaySub] = await Promise.all([
    getActiveStripeSubscription(userId),
    getActiveRazorpaySubscription(userId),
  ]);
  return !!(stripeSub || razorpaySub);
}
```

## Parallel Provider Pattern

Abstract billing behind an interface so your app code does not care which provider is active:

```typescript
interface BillingProvider {
  getActiveSubscription(userId: string): Promise<Subscription | null>;
  createCheckout(userId: string, planKey: string): Promise<{ url: string }>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  handleWebhook(request: Request): Promise<void>;
}

class StripeBilling implements BillingProvider { /* ... */ }
class RazorpayBilling implements BillingProvider { /* ... */ }

// Route to the correct provider based on user's existing subscription
async function getBillingProvider(userId: string): Promise<BillingProvider> {
  const stripeSub = await getActiveStripeSubscription(userId);
  if (stripeSub) return new StripeBilling();
  return new RazorpayBilling(); // Default for new users
}
```

### Webhook Routes (Both Active)

```typescript
// app/api/billing/stripe-webhook/route.ts
export async function POST(request: Request) {
  // Verify with Stripe signing secret, handle Stripe events
}

// app/api/billing/razorpay-webhook/route.ts
export async function POST(request: Request) {
  // Verify with Razorpay webhook secret, handle Razorpay events
}
```

Keep both webhook routes active until all Stripe subscriptions have expired.

## Key Differences That Bite You

1. **Charging model**: Stripe charges automatically (pull-based). Razorpay subscriptions are similar, but hosted checkout is push-based (user initiates).
2. **Customer portal**: Stripe has a built-in portal for managing subscriptions. Razorpay does not — you must build cancellation, plan change, and invoice UI yourself.
3. **Webhook signature header**: Stripe uses `stripe-signature`, Razorpay uses `x-razorpay-signature`.
4. **SDK types**: Stripe SDK has excellent TypeScript types. Razorpay SDK types have quirks (e.g., `fail_existing` needs `0 as 0 | 1` cast).
5. **Currency units**: Stripe uses cents (USD smallest unit), Razorpay uses paise (INR smallest unit). Both are smallest-unit integers, but watch currency conversion logic.
6. **Idempotency keys**: Stripe supports idempotency keys natively on API calls. Razorpay does not — you must implement idempotency yourself (especially for webhooks).

## Gotchas

1. **Never cancel all Stripe subscriptions at once** — migrate gradually. Let subscriptions expire naturally or cancel in batches.
2. **Razorpay requires plans before subscriptions**: You cannot create prices inline like Stripe. Create plans in the Razorpay Dashboard or via API before creating subscriptions.
3. **Razorpay webhook secret is separate from API secret**: Stripe uses a webhook signing secret. Razorpay also has a separate webhook secret (configured in Dashboard), distinct from your `key_secret`.
4. **Test modes are completely isolated**: Test your Razorpay integration separately with test keys. Stripe test mode and Razorpay test mode are independent — do not mix credentials.
5. **Raw body is critical for both**: Both providers compute webhook signatures on the raw request body. Parsing JSON before verification breaks the signature check.
6. **No `short_url` retrieval**: Razorpay's hosted checkout URL cannot be fetched after subscription creation. If the URL is lost, you must create a new subscription.
7. **Transition period database schema**: Add a `provider` column (`"stripe" | "razorpay"`) to your subscriptions table to distinguish which provider manages each subscription.
