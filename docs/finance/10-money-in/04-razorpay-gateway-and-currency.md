---
title: Razorpay gateway and currency
type: reference
audience: engineers and operators configuring or debugging the payment gateway
status: live
last-reviewed: 2026-10-23
---

# Razorpay gateway and currency

This page states which payment gateway the platform runs, what is enforced about currency, how buyer country is decided, what environment variables configure the gateway, and what the display-currency feature does and does not do. The short version is that Razorpay is the only gateway with code behind it, every charge is an INR order, and a foreign currency on screen is a client-side estimate and nothing more.

## 1. One gateway, INR only

`routeGateway` (`lib/payments/gateway-router.ts`) returns `RAZORPAY` and `INR` for every buyer. An overseas buyer receives the same INR order and pays it with an overseas card; their issuer converts at its own rate. The request body's gateway field is checked with `assertGatewayUsable` first, so a client cannot ask for anything else.

`PaymentGateway` has four enum values (`STRIPE`, `RAZORPAY`, `DODO_PAYMENTS`, `CARD`), but `UNIMPLEMENTED_GATEWAYS` in `lib/payments/constants.ts` lists `STRIPE` and `DODO_PAYMENTS`, and every money path refuses them with `UnsupportedGatewayError`. Searching the application code for Cashfree, Tazapay or Xflow finds one comment and an unused `PayoutRailProvider.CASHFREE_PAYOUTS` value; those gateways have been researched and parked, not built.

Settlement being INR-only is enforced at four independent points, so no single mistake can charge in the wrong currency.

| Point                 | Enforcer                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order creation        | `assertInrSettlement` (`lib/payments/validation/currency-guards.ts`) is the first statement of `createRazorpayOrder` and throws `NON_INR_SETTLEMENT` (422)                                                                                          |
| Inbound gateway data  | `toCurrencyEnum` throws on a blank or unknown code, so such a webhook dead-letters; it accepts every `Currency` enum value (`INR`, `USD`, `EUR`, `GBP`), and the `refund_currency_inr` and `dispute_currency_inr` CHECKs below reject a non-INR row |
| Administrative inputs | Organisation creation, the billing-account patch and purchase-order creation validate `z.literal("INR")`                                                                                                                                            |
| Database              | `payment_currency_inr`, `refund_currency_inr`, `dispute_currency_inr`, `ledger_account_currency_inr`, `consultant_earnings_currency_inr` and `consultant_payout_currency_inr` CHECKs in `prisma/sql/check-constraints.sql`                          |

A 100x charge was once possible because an organisation could be created with a USD billing currency and its INR paise were sent to Razorpay as dollars; the guards above exist so that cannot recur. The `Currency` enum stays on money columns so a future multi-currency ledger needs no column migration ([ADR 15](../../enterprise/70-design-decisions/15-currency-as-enum-with-display-fields.md)).

## 2. Buyer country and tax

Buyer country decides GST (18 % domestic, zero-rated export only under a valid Letter of Undertaking, otherwise 18 % IGST; see `determineTax` in [checkout and pricing](01-checkout-and-pricing.md)). `detectBuyerCountry` (`lib/payments/tax/buyer-country.ts`) uses, in order:

1. `User.country` when it is a two-letter code.
2. The `cf-ipcountry` header, ignoring `XX` and `T1`.
3. Otherwise India, which charges GST rather than risking a missed collection.

`Accept-Language` is not a signal and must not be reintroduced. In this deployment the first two signals almost never fire (the profile field is free text, and production has no Cloudflare in front of it), so the language header used to decide the tax outcome and `en-US`, common in India, zero-rated domestic sales as exports.

The payment records `buyerCountry` and `isInternational`. These are tax facts, not routing inputs.

## 3. Display currency is an estimate

A buyer can switch the site to a supported foreign currency. The conversion happens in the browser from INR paise and is shown with a note under the total: "Estimated in USD. You will be charged ₹5,000.00 in INR by the payment gateway; your card issuer's rate applies." (`app/checkout/components/FxEstimateNote.tsx`). Two fields on `Payment` record what the buyer saw for audit: `displayCurrencyAtCheckout`, validated against `SUPPORTED_CURRENCY_CODES` in `lib/currency-codes.ts`, and `exchangeRateAtCheckout`. No stored amount is ever derived from either.

Rates come from ExchangeRate-API's open endpoint, configured by `EXCHANGE_RATE_API_URL` and defaulting to `https://open.er-api.com/v6/latest/INR`. `lib/currency.ts` keeps the last response for one hour in a per-instance variable and never serves one older than 24 hours; after that `getExchangeRates` throws, `/api/currency` answers 500, and the client falls back to INR and rupee symbols so the display degrades together. The CDN is the cache that matters: `/api/currency` sends `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400` and is limited to thirty requests a minute per IP (`currencyLimiter`), because the provider locks out abusive callers. The provider's licence requires visible attribution wherever its rates appear, which `RATE_PROVIDER_NAME` and `RATE_PROVIDER_URL` supply to every surface.

## 4. Environment

Server-side variables are read at runtime. `NEXT_PUBLIC_RAZORPAY_KEY_ID` is inlined into the browser bundle at build time, so changing it needs a rebuild and redeploy. Test and live Razorpay modes have separate keys and separate webhook secrets, so a secret generated in test mode rejects every live delivery.

| Variable                                    | Purpose                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `RAZORPAY_KEY_ID`, `RAZORPAY_SECRET`        | Server API credentials for orders, fetches and refunds. The secret is also the key for client signatures.                            |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID`               | The publishable key the checkout sheet uses; it must be the same account as `RAZORPAY_KEY_ID`.                                       |
| `RAZORPAY_WEBHOOK_SECRET`                   | HMAC secret for payment webhooks. Distinct from the API secret. Missing means the route answers 500.                                 |
| `RAZORPAY_WEBHOOK_SECRET_PREVIOUS`          | Set only during a rotation; accepted and reported as a warning while set.                                                            |
| `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION`    | Pre-launch override that downgrades the test-key boot guard to a log line. Delete it when live keys go in.                           |
| `RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET`  | RazorpayX credentials; outside production they fall back to the Razorpay keys.                                                       |
| `RAZORPAYX_ACCOUNT_NUMBER`                  | The RazorpayX account payouts are debited from.                                                                                      |
| `RAZORPAYX_WEBHOOK_SECRET` and `_PREVIOUS`  | Secret for `payout.*` and `fund_account.*` events only.                                                                              |
| `RAZORPAYX_EGRESS_PROXY_URL`                | Static-egress proxy; a live RazorpayX key without it makes each payout call refuse (see [RazorpayX](../40-payouts/04-razorpayx.md)). |
| `ENABLE_LIVE_PAYOUTS`                       | Gates real payout submission and the live-key guard for the payouts client.                                                          |
| `ENABLE_SAVED_CARDS`, `ENABLE_CHECKOUT_EMI` | Opt-in checkout features (section 5).                                                                                                |
| `ENABLE_MOCK_PAYMENTS`                      | Allows mock payment helpers outside development; checkout itself honours a mock request only when `NODE_ENV` is `development`.       |
| `EXCHANGE_RATE_API_URL`                     | Display-currency rate source (section 3).                                                                                            |

**Test-key guard.** `lib/payments/core/razorpay.ts` runs a check when it loads: a key starting `rzp_test_` with `NODE_ENV=production` throws `RAZORPAY_TEST_KEY_IN_PRODUCTION` (pinned by `__tests__/payments/razorpay-test-key-guard.test.ts`). It is skipped during `next build`, because builds run with `NODE_ENV=production` and legitimately hold test keys, and the override variable downgrades it to an error log while the site runs on test keys before launch. A live RazorpayX key without the egress proxy is reported once per process at load.

**Rotating the webhook secret** has to be a two-sided change. Save the new secret in the Razorpay dashboard, set the old value as `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` and the new one as `RAZORPAY_WEBHOOK_SECRET` in the same deploy, wait for the warnings to stop, then delete the previous variable. A hard cutover loses events signed in the gap, and Razorpay disables an endpoint that returns non-2xx for 24 hours.

## 5. Gateway behaviour worth knowing

- **Client calls are bounded.** Every SDK call goes through `withRazorpaySdkTimeout` (30 seconds) and a circuit breaker held in Redis. Client errors (4xx other than 429) never trip the breaker; 5xx, 429 and timeouts do. Refunds use raw HTTP with an `AbortSignal` timeout and a required `X-Refund-Idempotency` header, rejected unless it is a valid key, because a repaired key could collide with another refund.
- **Orders** carry a generated `receipt`, the sanitised notes, `customer_id` when a saved-card customer exists, and a capture window sized to the hold. A stale `customer_id` after a switch from test to live keys is cleared and the order retried without it.
- **Saved cards** (`ENABLE_SAVED_CARDS`): `ensureRazorpayCustomer` creates the Customer once with `fail_existing: 0` so Razorpay returns the existing one for the same contact, and stores the id by CAS on the null column. Razorpay shows its own tokenisation consent, so the platform keeps no consent table.
- **EMI** (`ENABLE_CHECKOUT_EMI`): while off, the checkout sheet hides the EMI block; while on, it is offered for gateway-paid totals of at least ₹3,000. The merchant receives the full amount either way, so `Payment.amount` does not change.

## 6. Vendor facts to confirm

Razorpay's fees, settlement cycle and international card availability are commercial terms outside the code. The router's comments record roughly 2 % plus GST domestic and roughly 3 % plus GST for international cards, and the platform reconciles the real fee per capture (`postGatewayFee`) and per settlement ([gateway clearing](../20-ledger/05-gateway-clearing-and-settlement.md)); read those journals, not this page, for what Razorpay actually charged.

## Where in code

- `lib/payments/gateway-router.ts`, `lib/payments/constants.ts`, `lib/payments/validation/currency-guards.ts`, `lib/payments/validation/gateway-guards.ts`.
- `lib/payments/core/razorpay.ts`: client, breaker, orders, customers, refunds.
- `lib/payments/tax/buyer-country.ts`, `lib/payments/tax/tax-engine.ts`.
- `lib/currency.ts`, `lib/currency-codes.ts`, `app/api/currency/route.ts`, `app/checkout/components/FxEstimateNote.tsx`.

## Related

- [Checkout and pricing](01-checkout-and-pricing.md).
- [Go-live checklist](../70-operations/07-go-live-checklist.md) for switching to live keys.
- [Money decisions](../90-decisions/README.md) for why Stripe was removed.

## Deprecated & Superseded Approaches

Stripe was a live fallback gateway until it was removed in October 2026; its checkout-session code, webhook handler, forex-fee table and `createStripeCheckoutSession` guard call are gone, and the `STRIPE` enum value remains only as a refused label. International buyers were once described as routed to a separate rail at one percent with zero forex markup; that was a different Razorpay product the code never used. A "Future Phases" plan for multi-currency pricing, Wise payouts, EU VAT and Australian GST is not scheduled and is not code. Documents that listed `assertNoTestKeysInLiveProduction` as a function describe a guard that is now a module-load block. Delete any of these if found.
