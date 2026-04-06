---
name: local-testing
description: Set up local Razorpay testing — test keys, ngrok tunnel, webhook registration, end-to-end test flow. Use when the user asks to "test locally", "set up ngrok", "test razorpay webhooks", "get test card numbers", or needs to verify their Razorpay integration before going live.
argument-hint: "[setup|webhook|e2e]"
---

# Local Razorpay Testing Guide

Complete guide to testing your Razorpay integration locally before touching production.

## Step 1: Get Test API Keys

1. Go to [Razorpay Dashboard](https://dashboard.razorpay.com)
2. Toggle to **Test Mode** (top-left switch)
3. Go to **Settings → API Keys → Generate Key**
4. You'll get:
   - `rzp_test_xxxxx` — Key ID
   - A secret — Key Secret (shown once, save it)

Update `.env.local`:
```
RAZORPAY_KEY_ID=rzp_test_xxxxx
RAZORPAY_KEY_SECRET=your_test_secret
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_test_xxxxx
```

**Test keys start with `rzp_test_`, live keys with `rzp_live_`.** They access completely separate environments — test data is invisible in live mode and vice versa.

## Step 2: Create Test Plans

Plans must exist before you can create subscriptions. Create them in test mode:

```bash
curl -u rzp_test_xxxxx:your_test_secret \
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
    }
  }'
```

Save the returned `plan_id` (e.g., `plan_test_xxxxx`) in your `.env.local`:
```
RAZORPAY_PLAN_MONTHLY=plan_test_xxxxx
```

**Test and live plans have different IDs.** You need separate plan IDs per environment.

## Step 3: Set Up ngrok for Webhooks

Razorpay can't reach `localhost`. You need a public tunnel.

### Install ngrok
```bash
# macOS
brew install ngrok

# or download from https://ngrok.com/download
# Sign up for free account and add authtoken
ngrok config add-authtoken your_token
```

### Start the tunnel
```bash
# Start your app first
npm run dev   # localhost:3000

# In another terminal, start ngrok
ngrok http 3000
```

ngrok gives you a URL like `https://abc123.ngrok-free.app`. This is your public URL.

**Keep ngrok running** throughout your testing session. If you restart ngrok, you get a new URL and must re-register the webhook.

### Free tier limitation
ngrok free tier gives a random URL each time. Paid plans give a stable subdomain. For development, random is fine — just update the webhook URL each session.

## Step 4: Register Webhook in Razorpay

1. Go to **Razorpay Dashboard → Settings → Webhooks** (in test mode)
2. Click **Add New Webhook**
3. Set the URL: `https://abc123.ngrok-free.app/api/billing/webhook`
4. Set a webhook secret (any strong string) — save it as `RAZORPAY_WEBHOOK_SECRET` in `.env.local`
5. Select events to listen for:
   - `subscription.authenticated`
   - `subscription.activated`
   - `subscription.charged`
   - `subscription.cancelled`
   - `subscription.completed`
   - `subscription.halted`
   - `subscription.paused`
   - `subscription.resumed`
   - `subscription.pending`
   - `subscription.updated`
   - `payment.authorized`
   - `payment.failed`
   - `payment.refund.created` (if using refunds)
   - `payment.refund.processed`
6. Click **Create Webhook**

**Webhook secret is NOT the same as API secret.** They're separate values.

## Step 5: End-to-End Test Flow

### Test a subscription

1. Start your app and ngrok
2. Click your subscribe button — it should create a subscription and open `short_url`
3. On the Razorpay checkout page, use test card details (see below)
4. After payment, check:
   - **Your terminal**: webhook logs should show incoming events
   - **ngrok inspector** at `http://127.0.0.1:4040`: shows all requests with payloads
   - **Razorpay Dashboard → Webhooks**: shows delivery attempts and response codes
   - **Your database**: subscription should be `active`

### Test card numbers

| Card | Number | Behavior |
|------|--------|----------|
| Success | `4111 1111 1111 1111` | Payment succeeds |
| Success (Mastercard) | `5267 3181 8797 5449` | Payment succeeds |
| Failure | `4000 0000 0000 0002` | Payment fails |

- **Expiry**: Any future date (e.g., `12/35`)
- **CVV**: Any 3 digits (e.g., `123`)
- **Name**: Anything
- **OTP/3DS**: Use `1234` when prompted in test mode

### Test UPI
Use any valid format UPI ID like `success@razorpay` for successful payments.

### Test a refund

```bash
# After a successful test payment, get the payment ID from your DB or dashboard
curl -u rzp_test_xxxxx:your_test_secret \
  https://api.razorpay.com/v1/payments/pay_xxxxx/refund \
  -H "Content-Type: application/json" \
  -d '{ "amount": 99900 }'
```

Test mode refunds process instantly. Live mode takes 5-7 business days.

## Step 6: Inspect Webhook Payloads

### ngrok web inspector
Open `http://127.0.0.1:4040` in your browser. You can:
- See every request Razorpay sends
- Inspect headers (including `x-razorpay-signature` and `x-razorpay-event-id`)
- View the full JSON payload
- **Replay requests** — click "Replay" to re-send a webhook for debugging

### Manual webhook testing with curl

Generate a test signature:
```bash
# Replace with your actual webhook secret and payload
export WEBHOOK_SECRET="your_webhook_secret"
export PAYLOAD='{"event":"subscription.activated","payload":{"subscription":{"entity":{"id":"sub_test123","plan_id":"plan_test456","status":"active","notes":{"userId":"user_1","planKey":"pro_monthly"}}}}}'

# Generate signature
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')

# Send test webhook
curl -X POST http://localhost:3000/api/billing/webhook \
  -H "Content-Type: application/json" \
  -H "x-razorpay-event-id: evt_test_$(date +%s)" \
  -H "x-razorpay-signature: $SIGNATURE" \
  -d "$PAYLOAD"
```

Expected responses:
- `200 OK` — webhook processed successfully
- `400 Missing signature` — signature header missing
- `400 Invalid signature` — wrong secret or payload mismatch

## Step 7: Going to Production Checklist

Before switching from test to live:

- [ ] Generate **live** API keys from Razorpay Dashboard (production mode)
- [ ] Create **live** plans (plan IDs are different from test)
- [ ] Register webhook with your **production URL** (not ngrok)
- [ ] Set **live** webhook secret
- [ ] Update all env vars (`rzp_test_` → `rzp_live_`, plan IDs, webhook secret)
- [ ] Verify webhook endpoint is HTTPS (required for live)
- [ ] Test with a real Rs 1 payment to confirm the full flow
- [ ] Enable all needed webhook events in live webhook settings
- [ ] Remove any test-mode skips or debug logging from production code

## Troubleshooting

### Webhook not arriving
1. Check ngrok is running and URL matches webhook registration
2. Check ngrok inspector (`http://127.0.0.1:4040`) for incoming requests
3. Check Razorpay Dashboard → Webhooks → delivery attempts
4. Verify you're in **test mode** on the dashboard (not live)

### Signature verification failing
1. Check you're using `RAZORPAY_WEBHOOK_SECRET`, not `RAZORPAY_KEY_SECRET`
2. Check you're reading raw body with `request.text()`, not `request.json()`
3. Check the secret matches what you set in Razorpay Dashboard

### ngrok URL changed
If ngrok restarted, update the webhook URL in Razorpay Dashboard. Old URL won't work.

### Payment stuck in "created"
User didn't complete checkout. In test mode, go to the `short_url` and complete payment with test card.

### Webhook returns 500
Check your app logs. Common causes:
- Database not running or not migrated
- Missing env vars
- Auth middleware blocking the webhook endpoint (webhooks are unauthenticated — exempt this route)
