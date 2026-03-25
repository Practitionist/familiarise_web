# Discount Codes / Coupons for International Users

> **Research Date:** March 2026

---

## 1. Currency Conversion Issues with Fixed-Amount Discounts

### The Problem

Fixed-amount discounts (e.g., "Rs 500 off") create problems for international customers because:

1. **Exchange rate fluctuation:** Rs 500 = $5.85 today, might be $5.72 tomorrow
2. **Marketing difficulty:** "Rs 500 off" is meaningless to a US customer
3. **Double conversion risk:** Some platforms accidentally convert the discount twice (original currency -> display currency -> checkout currency)
4. **Unfair value across markets:** Rs 500 is significant in India but trivial for US customers

### How Shopify Handles This

- Fixed-amount discounts set in store currency
- Auto-converted to customer's currency at checkout using current exchange rate
- **If using manual exchange rates:** discount converted using manual rate (more predictable)
- Amount can fluctuate daily based on exchange rates

---

## 2. Best Practices

### Percentage-Based Discounts (Recommended for International)

| Approach          | Example        | Pros                           | Cons                     |
| ----------------- | -------------- | ------------------------------ | ------------------------ |
| Percentage off    | "10% off"      | Currency-agnostic, fair        | Less impactful feeling   |
| Tiered percentage | "15% off >$50" | Drives higher AOV              | Complex to communicate   |

**Percentage discounts have NO currency issues.** They work identically regardless of checkout currency.

### Currency-Specific Fixed Discounts (Alternative)

Create separate discount amounts for each currency:

| Discount Code   | INR    | USD   | EUR   | GBP   |
| --------------- | ------ | ----- | ----- | ----- |
| WELCOME500       | Rs 500 | $6    | EUR 5.50 | GBP 4.75 |
| PREMIUM1000      | Rs 1000| $12   | EUR 11  | GBP 9.50 |

**Considerations:**
- More work to maintain
- Rates can become stale
- Need to update periodically
- Better user experience (customer sees familiar amounts)

### Market-Specific Discount Strategies

Different markets have different price sensitivities:

| Market  | Recommended Approach                        |
| ------- | ------------------------------------------- |
| India   | Fixed INR amounts (Rs 100, Rs 500, Rs 1000) |
| US/UK   | Percentage-based (10%, 15%, 20%)            |
| SEA     | Fixed USD amounts ($5, $10, $20)            |
| EU      | Percentage-based (VAT complexity)           |

---

## 3. Implementation Recommendations for Familiarise

### Short-term (MVP)

1. **Use percentage-based discounts only** for international users
2. Keep fixed-amount discounts in INR for Indian users only
3. Discount code validation should check currency compatibility

```typescript
// Suggested validation logic
function validateDiscount(discount: Discount, currency: string): boolean {
  if (discount.type === 'PERCENTAGE') {
    return true; // Always valid regardless of currency
  }

  if (discount.type === 'FIXED_AMOUNT') {
    // Only allow fixed discounts in matching currency
    return discount.currency === currency;
  }

  return false;
}
```

### Medium-term

1. Add multi-currency discount support (set amounts per currency)
2. Auto-convert fixed discounts using daily exchange rates
3. Display discount in customer's local currency

### Tax Considerations for International Discounts

- Discounts should be applied **before** GST calculation
- For exports (zero-rated), discount doesn't affect GST (already 0%)
- For domestic, discount reduces taxable value and thus GST amount
- No special tax implications for offering discounts to international customers

---

## Sources

- [Shopify Discounts and International Pricing](https://help.shopify.com/en/manual/international/pricing/discounts)
- [Multi-Currency Discounts Guide (Pixoo)](https://pixoo.app/blog/complete-guide-multi-currency-discounts-shopify)
- [Currency Conversion Tips for International Ecommerce (Modalyst)](https://www.modalyst.co/blog/currency-conversion-tips-for-international-ecommerce-stores/)
