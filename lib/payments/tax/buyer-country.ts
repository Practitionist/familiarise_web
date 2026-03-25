/**
 * Buyer Country Detection
 *
 * Server-side detection cascade for determining buyer's country at checkout.
 * Used for tax jurisdiction determination (GST vs zero-rated export).
 */

// Maps locale strings to ISO 3166-1 alpha-2 country codes
const LOCALE_COUNTRY_MAP: Record<string, string> = {
  "en-US": "US",
  "en-GB": "GB",
  "en-AU": "AU",
  "en-CA": "CA",
  "en-IN": "IN",
  "hi-IN": "IN",
  hi: "IN",
  "de-DE": "DE",
  de: "DE",
  "fr-FR": "FR",
  fr: "FR",
  "es-ES": "ES",
  es: "ES",
  "it-IT": "IT",
  it: "IT",
  "pt-BR": "BR",
  pt: "PT",
  "ja-JP": "JP",
  ja: "JP",
  "zh-CN": "CN",
  zh: "CN",
  "ko-KR": "KR",
  ko: "KR",
  "ar-AE": "AE",
  "ar-SA": "SA",
  "ru-RU": "RU",
  ru: "RU",
  "nl-NL": "NL",
  nl: "NL",
  "sv-SE": "SE",
  sv: "SE",
  "pl-PL": "PL",
  pl: "PL",
  "tr-TR": "TR",
  tr: "TR",
  "th-TH": "TH",
  th: "TH",
  "id-ID": "ID",
  "ms-MY": "MY",
  "en-SG": "SG",
  "en-NZ": "NZ",
  "da-DK": "DK",
  da: "DK",
  "nb-NO": "NO",
  nb: "NO",
  "fi-FI": "FI",
  fi: "FI",
  "en-ZA": "ZA",
  "en-NG": "NG",
  "en-KE": "KE",
  "en-GH": "GH",
};

/**
 * Detect country from Accept-Language header
 */
function detectCountryFromLocale(acceptLanguage: string): string | null {
  // Parse Accept-Language: "en-US,en;q=0.9,hi-IN;q=0.8"
  const locales = acceptLanguage
    .split(",")
    .map((part) => part.split(";")[0].trim());

  for (const locale of locales) {
    if (LOCALE_COUNTRY_MAP[locale]) return LOCALE_COUNTRY_MAP[locale];
    const base = locale.split("-")[0];
    if (LOCALE_COUNTRY_MAP[base]) return LOCALE_COUNTRY_MAP[base];
  }

  return null;
}

/**
 * Detect buyer country using a cascading strategy.
 *
 * Priority:
 * 1. User's profile country (highest confidence — explicitly set)
 * 2. Cloudflare cf-ipcountry header (geo-IP, available on Netlify with CF DNS)
 * 3. Accept-Language header mapping
 * 4. Fallback: "IN" (conservative — charges GST rather than missing it)
 */
export function detectBuyerCountry(params: {
  userCountry?: string | null;
  cfIpCountry?: string | null;
  acceptLanguage?: string | null;
}): string {
  // 1. User profile country (most reliable)
  if (params.userCountry && params.userCountry.length === 2) {
    return params.userCountry.toUpperCase();
  }

  // 2. Cloudflare geo-IP header
  if (
    params.cfIpCountry &&
    params.cfIpCountry !== "XX" &&
    params.cfIpCountry !== "T1"
  ) {
    return params.cfIpCountry.toUpperCase();
  }

  // 3. Accept-Language header
  if (params.acceptLanguage) {
    const detected = detectCountryFromLocale(params.acceptLanguage);
    if (detected) return detected;
  }

  // 4. Conservative fallback — assume India (charge GST rather than miss it)
  return "IN";
}

/**
 * Extract buyer country detection params from a Request/Headers object.
 * Use this in API routes to get the params for detectBuyerCountry.
 */
export function extractBuyerCountryParams(headers: Headers): {
  cfIpCountry: string | null;
  acceptLanguage: string | null;
} {
  return {
    cfIpCountry: headers.get("cf-ipcountry"),
    acceptLanguage: headers.get("accept-language"),
  };
}
