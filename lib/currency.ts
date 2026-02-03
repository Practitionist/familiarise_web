// Server-side currency conversion service using ExchangeRate-API
// (open.er-api.com) — supports INR as base natively, no API key needed,
// updates once daily. We cache for 24 hours.

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

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

// Currency symbol lookup
export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "\u20AC",
  GBP: "\u00A3",
  INR: "\u20B9",
  JPY: "\u00A5",
  CNY: "\u00A5",
  AUD: "A$",
  CAD: "C$",
  BRL: "R$",
  KRW: "\u20A9",
  AED: "AED",
  SAR: "SAR",
  RUB: "\u20BD",
  SEK: "kr",
  PLN: "z\u0142",
  TRY: "\u20BA",
  THB: "\u0E3F",
  IDR: "Rp",
  MYR: "RM",
  SGD: "S$",
  NZD: "NZ$",
  DKK: "kr",
  NOK: "kr",
  ZAR: "R",
};
