# Local Testing — Razorpay Test Cards, Test UPI & Signed Webhooks

Official citations:
- [Test Card Details (`https://razorpay.com/docs/payments/payments/test-card-details/`)](https://razorpay.com/docs/payments/payments/test-card-details/)
- [Standard Checkout Test Integration (`https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/#2-test-integration`)](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/#2-test-integration)

---

## 1. Official Razorpay Test Card Numbers

> **NEVER use Stripe test card numbers** (`4242...`, `4111...`, `4000...`) or legacy retired cards (`4012 0010...`) with Razorpay. Always use the official Razorpay test cards below (`https://razorpay.com/docs/payments/payments/test-card-details/`).

### Domestic (Indian) Cards — Success
Use any future expiry date (e.g., `05/30`), any 3-digit CVV (4-digit for Amex), and any cardholder name. On the mock bank ACS page, click **Success** (or enter any 4–10 digit OTP).

| Network & Type | Card Number |
|---|---|
| **Visa (Debit, Consumer)** | `4100 2800 0000 1007` |
| **Mastercard (Credit, Business)** | `5555 5100 0008 1006` *(or `5500 6700 0000 1002`)* |
| **Mastercard (Prepaid, Consumer)** | `5180 2872 0009 1001` |
| **RuPay (Credit, Consumer)** | `6527 6589 0000 1005` |
| **Diners (Credit, Consumer)** | `3608 280009 1007` |
| **Amex (Credit, Consumer)** | `3402 560004 01007` |
| **EMI (Mastercard)** | `5241 8100 0000 0000` |

### Domestic (Indian) Cards — Error Simulation (`4100 2800 ...`)
These cards deterministically trigger specific failure reasons (`payment.failed`):

| Simulated Error Reason | Visa Card Number | Mastercard Card Number |
|---|---|---|
| `payment_timed_out` | `4100 2800 0009 0000` | `5305 6200 0009 0000` |
| `insufficient_fund` | `4100 2800 0008 0001` | `5305 6200 0008 0001` |
| `payment_cancelled` | `4100 2800 0007 0002` | `5305 6200 0007 0002` |
| `card_declined` | `4100 2800 0006 0003` | `5305 6200 0006 0003` |
| `card_disabled_for_online_payments` | `4100 2800 0003 0006` | `5305 6200 0003 0006` |
| `gateway_technical_error` | `4100 2800 0002 0007` | `5305 6200 0002 0007` |
| `card_number_invalid` | `4100 2800 0001 0008` | `5305 6200 0001 0008` |
| `authentication_failed` | `4100 2800 0000 0009` | `5305 6200 0000 0009` |

### International Cards

| Network | Card Number |
|---|---|
| **Visa (International)** | `4012 8888 8888 1881` |
| **Mastercard (International)** | `5555 5555 5555 4444` *(or `5105 1051 0510 5100` / `5104 0600 0000 0008`)* |

---

## 2. Test UPI VPAs, Netbanking & Phone Number Gotcha

### Test UPI VPAs (UPI Collect Only in Test Mode)
- **Success VPA**: `success@razorpay`
- **Failure VPA**: `failure@razorpay`
- **Watch out**: In Test Mode, only **UPI Collect** (typing a `@razorpay` VPA) works; UPI Intent and UPI QR Code require Live Mode.

### Test Netbanking & Wallets
- Selecting any bank under Netbanking or any Wallet in Test Mode opens Razorpay's mock bank page with **Success** and **Failure** buttons.

### Phone Number Gotcha in Test Mode (`#717`)
- **Never use `9999999999` or `+919999999999`** in Test Mode! Razorpay's test backend rejects any phone number whose last 10 digits are identical with `"Invalid mobile number"`.
- `normalizeRazorpayContact` in [`lib/payments/razorpay-prefill.ts`](../../../../../lib/payments/razorpay-prefill.ts) filters out `/(\d)\1{9,}/`. Always use a non-repeating number such as **`9876543210`** (`+919876543210`).

---

## 3. Simulating Signed Webhooks Locally (`POST /api/webhooks/razorpay`)

Unlike Stripe (`stripe listen`), Razorpay's CLI does **not** provide a local webhook-forwarding (`listen`) command. You can either:
1. Expose `localhost:3000` with `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000` and register `https://<tunnel>/api/webhooks/razorpay` in **Razorpay Dashboard (Test Mode) → Developers → Webhooks**, OR
2. Send a locally signed webhook directly to `http://localhost:3000/api/webhooks/razorpay` using the script below.

### Local Signed Webhook Helper (`curl` + `openssl`)

```bash
#!/usr/bin/env bash
set -euo pipefail

WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:3000/api/webhooks/razorpay}"
SECRET="${RAZORPAY_WEBHOOK_SECRET:?Set RAZORPAY_WEBHOOK_SECRET in your environment}"

ORDER_ID="${1:-order_TestLocal00001}"
PAYMENT_ID="${2:-pay_TestLocal00001}"
AMOUNT_PAISE="${3:-118000}"

BODY=$(cat <<EOF
{"entity":"event","account_id":"acc_TestLocal","event":"payment.captured","contains":["payment"],"payload":{"payment":{"entity":{"id":"${PAYMENT_ID}","entity":"payment","amount":${AMOUNT_PAISE},"currency":"INR","status":"captured","order_id":"${ORDER_ID}","invoice_id":null,"international":false,"method":"upi","amount_refunded":0,"refund_status":null,"captured":true,"description":"Consultation booking","card_id":null,"bank":null,"wallet":null,"vpa":"success@razorpay","email":"buyer@example.com","contact":"+919876543210","notes":{"type":"booking"},"fee":2360,"tax":360,"error_code":null,"error_description":null,"error_source":null,"error_step":null,"error_reason":null,"created_at":$(date +%s)}}},"created_at":$(date +%s)}
EOF
)

SIGNATURE=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')

curl -i -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: ${SIGNATURE}" \
  --data-raw "$BODY"
```

### Why `--data-raw` and Single-Line `BODY` Matter
- `app/api/webhooks/razorpay/route.ts` computes `HMAC-SHA256` over the **exact raw bytes** of the request body (`readBodyWithinCap(req)`).
- Always sign the exact string passed to `--data-raw` without re-formatting or adding a trailing newline.
- Remember that `schemas/webhooks/razorpay.ts` validates `payment.captured` strictly with `razorpayPaymentCapturedEventSchema`, so all nullable fields on `payload.payment.entity` (`invoice_id`, `refund_status`, `description`, `card_id`, `bank`, `wallet`, `vpa`, `fee`, `tax`, `error_*`) must be present (as `null` or typed values).
