# Tax Engine

## Overview

Centralized tax determination for all checkout transactions. Handles domestic GST and zero-rating for export of services.

## Rules

### Domestic (India)

- **Rate**: 18% GST
- **SAC Codes**: 999293 (consulting), 999294 (education/webinars/classes), 999295 (training)
- **Calculation**: Tax-exclusive (plan price + 18% GST)
- **Invoice**: Standard GST invoice with tax breakdown

### International (Export of Services)

- **Rate**: 0% (zero-rated)
- **Legal basis**: IGST Act Section 2(6) — Export of services
- **Conditions** (all must be met):
  1. Supplier is in India
  2. Recipient is outside India
  3. Payment received in convertible foreign exchange
  4. Place of supply is outside India
  5. Supplier and recipient are not establishments of the same person
- **Invoice note**: "Export of services — Zero-rated under IGST Act Section 2(6)"
- **LUT requirement**: Letter of Undertaking must be filed to supply without charging IGST

### Key Change (Finance Bill 2026)

The intermediary rule (Section 13(8)(b)) that could classify marketplace services as domestic is being **deleted**. This confirms marketplace/intermediary services to foreign clients qualify as exports.

## Detection Logic

Tax jurisdiction is determined by **buyer country**, not currency:

```typescript
determineTax({
  baseAmountPaise: 50000,
  buyerCountry: "US",        // → 0% (export)
  serviceType: "CONSULTING",
})

determineTax({
  baseAmountPaise: 50000,
  buyerCountry: "IN",        // → 18% GST
  serviceType: "CONSULTING",
})
```

### Previous Bug (Fixed)

The old code used `currency !== "INR"` to detect international transactions. Since ALL plans default to `priceCurrency: "INR"`, this condition **never triggered**, meaning every transaction was charged 18% GST — including exports. Now uses `buyerCountry !== "IN"`.

## E-Commerce Operator Classification

**Status**: UNRESOLVED — needs CA opinion before launch.

If Familiarise is classified as an "e-commerce operator" under Section 24 CGST Act:
- GST registration is **mandatory from Day 1** (no ₹20L threshold)
- Must collect TCS (Tax Collected at Source) of 0.5% on supplies
- Monthly GSTR-8 filing required

## Key Files

| File | Purpose |
|------|---------|
| `lib/payments/tax/tax-engine.ts` | `determineTax()` — core tax logic |
| `lib/payments/tax/buyer-country.ts` | `detectBuyerCountry()` — buyer location |
| `lib/payments/payouts/constants.ts` | `TAX_CONSTANTS` — rates and SAC codes |
| `lib/payments/payouts/invoice-service.ts` | Invoice generation with zero-rating |
