"use client";

import { useCurrency } from "@/hooks/useCurrency";
import { RATE_PROVIDER_NAME, RATE_PROVIDER_URL } from "@/lib/currency-codes";
import { formatCurrencyAmount } from "@/utils/formatting";

/**
 * #1396 — every order-summary line on the four checkout pages, the Total
 * included, is rendered through `useCurrency().formatPrice`, which multiplies
 * INR paise by a live rate and stamps a foreign symbol on the result. The
 * Razorpay modal then opens with the server's INR amount and the confirmation
 * email is written in INR, so a buyer who had selected USD read "$59.38", was
 * charged ₹5,000.00, and was emailed "₹5,000.00" — with the mid-market-versus-
 * card-network spread and the gateway's markup, typically two to four percent,
 * unaccounted for anywhere on the page.
 *
 * This component is the disclosure. It renders only while the figures above it
 * really are an estimate, names the INR amount the gateway will take, and
 * carries the attribution that the rate provider's licence requires wherever
 * its rates are displayed.
 *
 * It exists as one shared component rather than four copies so the four
 * checkout pages each add a single line, which also keeps the duplication ratio
 * on new code inside the quality gate.
 */
export function FxEstimateNote({ totalPaise }: { totalPaise: number }) {
  const { currency, isEstimate } = useCurrency();

  if (!isEstimate) return null;

  return (
    <p className="text-xs text-muted-foreground">
      Estimated in {currency}. You will be charged{" "}
      {formatCurrencyAmount(totalPaise, "INR")} in INR by the payment gateway;
      your card issuer&rsquo;s rate applies. Rates by{" "}
      <a
        href={RATE_PROVIDER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:text-foreground"
      >
        {RATE_PROVIDER_NAME}
      </a>
      .
    </p>
  );
}
