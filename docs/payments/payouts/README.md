# Payouts Documentation

How consultant earnings flow from payment success to bank deposit. Covers the full lifecycle: earnings creation, hold periods, batch processing, and gateway disbursement.

---

## Documents

| # | Document | Description |
|---|----------|-------------|
| 01 | [Architecture](./01-architecture.md) | System design, service layer, database models, provider integrations |
| 02 | [Earnings Lifecycle](./02-earnings-lifecycle.md) | PENDING → READY → PAID status flow, hold periods |
| 03 | [Payout Processing](./03-payout-processing.md) | Batch creation, approval workflow, processing pipeline |
| 04 | [International Payments](./04-international-payments.md) | Cross-border scenarios, currency handling, regulatory compliance |
| 05 | [API Reference](./05-api-reference.md) | Payout and earnings API endpoints |
| 06 | [Configuration](./06-configuration.md) | Hold periods, thresholds, batch schedules |
| 07 | [Razorpay Implementation](./07-razorpay-implementation.md) | RazorpayX payout code and integration details |
| 08 | [Stripe Implementation](./08-stripe-implementation.md) | Stripe Connect payout code and integration details |

## Related

- Gateway-level payout flows: [gateways/razorpay/03-payout-flow.md](../gateways/razorpay/03-payout-flow.md), [gateways/stripe/03-payout-flow.md](../gateways/stripe/03-payout-flow.md)
- Revenue splits and commission rates: [finances/02-revenue-distribution.md](../../finances/02-revenue-distribution.md)
