"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { reportPaymentsError } from "@/app/checkout/plans/utils";

/**
 * Referral-credit balance shared by all four checkout pages. One hook +
 * one presentational block instead of four copies of the fetch, the
 * load-failed flag, and the render branch (which is how a fix to one —
 * "failed fetch must not read as zero" — silently missed the other three
 * before).
 */
export function useReferralCreditsBalance() {
  const [availableCredits, setAvailableCredits] = useState(0);
  const [isLoadingCredits, setIsLoadingCredits] = useState(true);
  // Distinct from zero: a failed fetch must not masquerade as "no credits".
  const [creditsLoadFailed, setCreditsLoadFailed] = useState(false);

  useEffect(() => {
    async function fetchCredits() {
      try {
        const response = await fetch("/api/referrals/credits/available");
        // fetch resolves on HTTP errors too: a non-OK status must reach the
        // catch below, or credits read 0 with loadFailed false and the buyer
        // is told they have no credits.
        if (!response.ok) {
          throw new Error(
            `Referral credits request failed (HTTP ${response.status}).`,
          );
        }
        const data = await response.json();
        setAvailableCredits(
          data.data.totalAvailable || 0, // already in paise
        );
      } catch (error) {
        reportPaymentsError(error);
        console.error("Error fetching referral credits:", error);
        setCreditsLoadFailed(true);
      } finally {
        setIsLoadingCredits(false);
      }
    }
    fetchCredits();
  }, []);

  return { availableCredits, isLoadingCredits, creditsLoadFailed };
}

export function ReferralCreditsBlock({
  availableCredits,
  isLoadingCredits,
  creditsLoadFailed,
  useReferralCredits,
  onCheckedChange,
  formatPrice,
}: {
  availableCredits: number;
  isLoadingCredits: boolean;
  creditsLoadFailed: boolean;
  useReferralCredits: boolean;
  onCheckedChange: (checked: boolean) => void;
  formatPrice: (paise: number) => string;
}) {
  return (
    <div className="grid gap-4">
      <div className="font-semibold">Referral Credits</div>
      {isLoadingCredits ? (
        <div className="text-sm text-muted-foreground">Loading credits...</div>
      ) : availableCredits > 0 ? (
        <div className="flex items-center justify-between gap-3 bg-muted p-3 rounded-lg border border-border">
          <div className="min-w-0">
            <div className="font-medium text-foreground">
              {formatPrice(availableCredits)} available
            </div>
            <div className="text-sm text-muted-foreground">
              Apply to this purchase
            </div>
          </div>
          <Switch
            checked={useReferralCredits}
            onCheckedChange={onCheckedChange}
          />
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">
          {creditsLoadFailed
            ? "Couldn't load credits — proceed without them or reload to retry."
            : "No referral credits available"}
        </div>
      )}
    </div>
  );
}
