import { formatCurrencyAmount } from "@/utils/formatting";

/** Single owner for the free-trial string — route literals through this. */
export const FREE_TRIAL_LABEL = "Free trial";

/** Row meta for a trial: "₹100 trial · 30 min" when paid, "Free trial" only
 *  when the plan genuinely charges nothing. Null price (payload without the
 *  field) stays neutral rather than claiming Free. */
export function trialMeta(
  priceInPaise: number | null | undefined,
  durationMinutes: number | null | undefined,
): string {
  const label =
    priceInPaise === null || priceInPaise === undefined
      ? "Trial"
      : priceInPaise > 0
        ? `${formatCurrencyAmount(priceInPaise, "INR")} trial`
        : FREE_TRIAL_LABEL;
  return durationMinutes ? `${label} · ${durationMinutes} min` : label;
}
