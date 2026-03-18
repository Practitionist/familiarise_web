# Multi-Currency Architecture

## Strategy: India-First + Accept International

All prices are stored in **INR paise**. International buyers see approximate prices in their local currency (client-side conversion), but all charges are processed in INR via Razorpay.

### Gateway Selection

| Buyer Country | Gateway  | Method                            | Fee                     | Settlement |
| ------------- | -------- | --------------------------------- | ----------------------- | ---------- |
| India         | Razorpay | Domestic (UPI, cards, netbanking) | 2% + GST (~2.36%)       | INR, T+2   |
| International | Razorpay | IBT (International Bank Transfer) | 1% + GST, zero forex    | INR, T+1   |
| Fallback      | Stripe   | Checkout Sessions                 | ~6.3% (4.3% + 2% forex) | INR, T+5-7 |

### Why Razorpay for Everything

1. **Cost**: Razorpay IBT is 1% vs Stripe's 6.3% for international — **5x cheaper**
2. **eFIRC**: Razorpay auto-generates eFIRC (Foreign Inward Remittance Certificate) monthly — Stripe requires manual coordination with bank
3. **PA-CB License**: Razorpay received RBI PA-CB license (Dec 2025) — authorized for cross-border
4. **UPI**: Zero-fee domestic payments (unique advantage over TopMate which uses Stripe)

### Competitive Advantage vs TopMate

TopMate's effective international cost: **15-18%** (10% commission + 3% Stripe + 2-3% forex)
Familiarise's effective international cost: **~11%** (10% commission + 1% Razorpay IBT)

**Structural moat**: 4-7% cost advantage per international transaction.

## Currency Flow

```
[Consultant sets price in INR paise]
    ↓
[Consultee sees price in local currency (client-side conversion)]
    ↓
[Checkout: buyer country detected → tax determined → gateway auto-routed]
    ↓
[Razorpay charges in INR (or auto-converts for IBT)]
    ↓
[Payment recorded with buyerCountry + isInternational flags]
    ↓
[Earnings created in INR → hold period → TDS calculated → payout in INR]
```

## Buyer Country Detection

Server-side cascade at checkout:

1. `User.country` (profile field — highest confidence)
2. `cf-ipcountry` header (Cloudflare geo-IP)
3. `Accept-Language` → country mapping
4. Fallback: `"IN"` (conservative — charges GST rather than missing it)

## Exchange Rate Handling

- Rates from `open.er-api.com` (free, daily updates, INR base)
- Cached for 24 hours server-side
- Client-side: React Query with 1-hour stale time
- Disclaimer shown: "Final amount may vary based on current exchange rate"
- `exchangeRateAtCheckout` stored on Payment record for audit

## Key Files

| File                                         | Purpose                                  |
| -------------------------------------------- | ---------------------------------------- |
| `lib/payments/tax/buyer-country.ts`          | Buyer country detection cascade          |
| `lib/payments/tax/tax-engine.ts`             | Tax determination (GST vs zero-rated)    |
| `lib/payments/gateway-router.ts`             | Auto-routing to Razorpay/Stripe          |
| `lib/payments/validation/currency-guards.ts` | Currency consistency validation          |
| `lib/currency.ts`                            | Exchange rates + locale→currency mapping |
| `hooks/useCurrency.ts`                       | Client-side currency display hook        |

## Future Phases

- **Phase 2**: Multi-currency pricing (consultants set prices in their currency)
- **Phase 3**: International consultant payouts via Wise
- **Phase 4**: EU VAT OSS + AU GST collection
