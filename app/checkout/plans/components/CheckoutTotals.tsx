"use client";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { EmiHint } from "@/app/checkout/components/CheckoutFlags";
import { FxEstimateNote } from "@/app/checkout/components/FxEstimateNote";
import { formatPercentage, type PricingBreakdown } from "../math";

type TaxContextStatus = "loading" | "loaded" | "failed";

/**
 * Tax, credits and the total depend on the server's GST regime, so they render only
 * once the checkout context has loaded; a failed load offers a retry, never a guess.
 */
export function CheckoutTotals({
  pricing,
  formatPrice,
  taxContext,
}: Readonly<{
  pricing: PricingBreakdown;
  formatPrice: (paise: number) => string;
  taxContext: {
    taxContextStatus: TaxContextStatus;
    retryTaxContext: () => void;
  };
}>) {
  if (taxContext.taxContextStatus === "loading") {
    return (
      <p className="text-sm text-muted-foreground">
        Calculating tax and total…
      </p>
    );
  }
  if (taxContext.taxContextStatus === "failed") {
    return (
      <div className="flex items-center justify-between gap-2 text-sm">
        <p className="text-destructive">
          We couldn&apos;t load tax for this booking.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={taxContext.retryTaxContext}
        >
          Retry
        </Button>
      </div>
    );
  }
  return (
    <>
      <div className="flex items-center justify-between">
        <div>Tax ({formatPercentage(pricing.taxRate)})</div>
        <div>{formatPrice(pricing.taxAmount)}</div>
      </div>
      {pricing.creditsApplied > 0 && (
        <div className="flex items-center justify-between text-foreground">
          <div>Referral Credits</div>
          <div>-{formatPrice(pricing.creditsApplied)}</div>
        </div>
      )}
      <Separator className="bg-border" />
      <div className="flex items-center justify-between font-semibold">
        <div>Total</div>
        <div>{formatPrice(pricing.total)}</div>
      </div>
    </>
  );
}

/** The FX estimate and EMI hint for the total, shown only beside a loaded total. */
export function CheckoutTotalNotes({
  totalPaise,
  organizationId,
  taxContextStatus,
}: Readonly<{
  totalPaise: number;
  organizationId: string | null;
  taxContextStatus: TaxContextStatus;
}>) {
  if (taxContextStatus !== "loaded") return null;
  return (
    <>
      <FxEstimateNote totalPaise={totalPaise} organizationId={organizationId} />
      <EmiHint totalPaise={totalPaise} organizationId={organizationId} />
    </>
  );
}
