// Server-side currency conversion service using ExchangeRate-API
// (open.er-api.com) — supports INR as base natively, no API key needed,
// updates once daily. We cache for 1 hour to reduce rate drift exposure.

const CACHE_TTL = 60 * 60 * 1000; // 1 hour (reduced from 24h)

let cachedRates: Record<string, number> | null = null;
let cachedAt = 0;

/**
 * Returns INR→X rates for all supported currencies.
 * Fetched directly from ExchangeRate-API with INR as base.
 */
export async function getExchangeRates(): Promise<Record<string, number>> {
  const now = Date.now();
  if (cachedRates && now - cachedAt < CACHE_TTL) {
    return cachedRates;
  }

  const res = await fetch("https://open.er-api.com/v6/latest/INR");

  if (!res.ok) {
    if (cachedRates) return cachedRates;
    throw new Error(`Failed to fetch exchange rates: ${res.status}`);
  }

  const data = await res.json();
  if (data.result !== "success") {
    if (cachedRates) return cachedRates;
    throw new Error("Exchange rate API returned an error");
  }

  cachedRates = data.rates as Record<string, number>;
  cachedAt = now;
  return cachedRates;
}

/**
 * Force-invalidates the in-memory exchange rate cache.
 * Called by POST /api/admin/exchange-rates/refresh (admin-only).
 */
export function invalidateExchangeRateCache(): void {
  cachedRates = null;
  cachedAt = 0;
}

/**
 * Returns cache metadata for admin monitoring.
 */
export function getExchangeRateCacheInfo(): { cachedAt: number | null; ageMs: number | null } {
  if (!cachedRates) return { cachedAt: null, ageMs: null };
  return { cachedAt, ageMs: Date.now() - cachedAt };
}

export function convertPrice(
  amountINR: number,
  targetCurrency: string,
  rates: Record<string, number>,
): number {
  if (targetCurrency === "INR") return amountINR;
  const rate = rates[targetCurrency];
  if (!rate) return amountINR;
  return Math.round(amountINR * rate * 100) / 100;
}

// Maps Accept-Language header or navigator.language to a currency code
const LOCALE_CURRENCY_MAP: Record<string, string> = {
  "en-US": "USD",
  "en-GB": "GBP",
  "en-AU": "AUD",
  "en-CA": "CAD",
  "en-IN": "INR",
  "hi-IN": "INR",
  hi: "INR",
  "de-DE": "EUR",
  de: "EUR",
  "fr-FR": "EUR",
  fr: "EUR",
  "es-ES": "EUR",
  es: "EUR",
  "it-IT": "EUR",
  it: "EUR",
  "pt-BR": "BRL",
  pt: "EUR",
  "ja-JP": "JPY",
  ja: "JPY",
  "zh-CN": "CNY",
  zh: "CNY",
  "ko-KR": "KRW",
  ko: "KRW",
  "ar-AE": "AED",
  "ar-SA": "SAR",
  "ru-RU": "RUB",
  ru: "RUB",
  "nl-NL": "EUR",
  nl: "EUR",
  "sv-SE": "SEK",
  sv: "SEK",
  "pl-PL": "PLN",
  pl: "PLN",
  "tr-TR": "TRY",
  tr: "TRY",
  "th-TH": "THB",
  th: "THB",
  "id-ID": "IDR",
  "ms-MY": "MYR",
  "en-SG": "SGD",
  "en-NZ": "NZD",
  "da-DK": "DKK",
  da: "DKK",
  "nb-NO": "NOK",
  nb: "NOK",
  "fi-FI": "EUR",
  fi: "EUR",
  "en-ZA": "ZAR",
};

export function detectCurrencyFromLocale(locale: string): string {
  // Try exact match first
  if (LOCALE_CURRENCY_MAP[locale]) return LOCALE_CURRENCY_MAP[locale];

  // Try base language (e.g. "en-US" → "en")
  const base = locale.split("-")[0];
  if (LOCALE_CURRENCY_MAP[base]) return LOCALE_CURRENCY_MAP[base];

  return "INR";
}

/**
 * Returns the display symbol for any ISO 4217 currency code using the Intl API.
 * Replaces the previous hardcoded CURRENCY_SYMBOLS map — handles all ISO currencies
 * automatically without needing manual updates for new currencies.
 *
 * Examples: getCurrencySymbol("INR") → "₹", getCurrencySymbol("USD") → "$"
 */
export function getCurrencySymbol(currency: string): string {
  try {
    // Extract just the symbol from a formatted number (e.g. "₹0" → "₹")
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      })
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value ?? currency
    );
  } catch {
    // Fallback to currency code for unsupported/unknown codes
    return currency;
  }
}

/**
 * @deprecated Use getCurrencySymbol(code) instead.
 * Kept as a Proxy for backward compatibility with existing callers.
 */
export const CURRENCY_SYMBOLS: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get(_target, prop: string) {
      return getCurrencySymbol(prop);
    },
    has(_target, _prop) {
      return true; // All ISO 4217 codes are "present"
    },
  },
);
