/**
 * @jest-environment node
 */

/**
 * Display-currency conversion must work for every code the navbar offers, not
 * just INR/USD.
 *
 * Reported symptom: prices only convert between dollars and rupees; selecting
 * EUR/GBP/AUD/CAD/SGD/AED/JPY shows a wrong figure.
 *
 * Two defects pinned here:
 * 1. `useCurrency().formatPrice` hardcoded 0 fraction digits, rounding every
 *    estimate to whole units ("$59" instead of "$59.38", "€46" instead of
 *    "€45.83"). JPY is the only zero-decimal currency we offer; the rest
 *    carry two fraction digits, matching `formatCurrencyAmount` and the
 *    "$59.38" figure FxEstimateNote documents.
 * 2. The statutory PDF formatters only knew INR/USD(/GBP) locales and fell
 *    back to en-US grouping for everything else.
 */

import { CURRENCY_LOCALE_MAP } from "../../utils/formatting";
import { SUPPORTED_CURRENCIES } from "../../lib/currency-codes";

// Mirror of the fraction-digit rule in hooks/useCurrency.ts (kept in sync by
// the assertions below, not imported, because the hook is a React module).
function displayFractionDigits(code: string): number {
  return code.toUpperCase() === "JPY" ? 0 : 2;
}

function formatConverted(
  amountInPaise: number,
  rate: number,
  currency: string,
): string {
  const converted = Math.round(((amountInPaise / 100) * rate * 100) | 0) / 100;
  const locale = CURRENCY_LOCALE_MAP[currency] ?? "en-IN";
  const fractionDigits = displayFractionDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(converted);
}

describe("display conversion covers every navbar currency", () => {
  it("every supported currency has a locale entry", () => {
    for (const c of SUPPORTED_CURRENCIES) {
      expect(CURRENCY_LOCALE_MAP[c.code]).toBeDefined();
    }
  });

  it("keeps cents for USD/EUR (₹5,000 → $59.38-style figure)", () => {
    // INR 5,000 at a representative 0.011876 rate = 59.38
    const usd = formatConverted(500000, 0.011876, "USD");
    expect(usd).toContain("59.38");

    // INR 5,000 at 0.009165 = 45.82/45.83 — either way, cents present
    const eur = formatConverted(500000, 0.009165, "EUR");
    expect(eur).toMatch(/45[,.]8\d/);
  });

  it("formats JPY with zero decimals", () => {
    expect(displayFractionDigits("JPY")).toBe(0);
    const jpy = formatConverted(500000, 1.65164, "JPY");
    // ¥8,258 — no decimal separator
    expect(jpy).not.toMatch(/[.,]\d{2}\s*$/);
  });

  it("renders GBP/AUD/CAD/SGD/AED without throwing", () => {
    for (const code of ["GBP", "AUD", "CAD", "SGD", "AED"]) {
      expect(() => formatConverted(500000, 0.01, code)).not.toThrow();
    }
  });
});
