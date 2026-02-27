# Webhooks Documentation

Payment webhook handling for Stripe and Razorpay events.

---

## Documents

| #   | Document                                                   | Description                                        |
| --- | ---------------------------------------------------------- | -------------------------------------------------- |
| 01  | [Monitoring](./01-monitoring.md)                           | Webhook activity monitoring, success notifications |
| 02  | [Razorpay Webhook Schema](./02-razorpay-webhook-schema.md) | Razorpay webhook event schemas and validation      |

## Related

- Webhook handlers implementation: `app/api/webhooks/stripe/route.ts`, `app/api/webhooks/razorpay/route.ts`
- Payment processing on webhook: [checkout-flow/03-payment-processing.md](../checkout-flow/03-payment-processing.md)
