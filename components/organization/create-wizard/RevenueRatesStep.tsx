"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { StepProps } from "./types";

// Defaults: 1000 / 1000 / 8000 basis points (10 / 10 / 80 %).
// These mirror `DEFAULT_RATE_CARD` in lib/api/organizations/rate-card.ts
// so an org that accepts the wizard defaults ends up with the same split
// the settlement code falls back to when no RateCard row exists.
const DEFAULT_PLATFORM_BPS = 1000;
const DEFAULT_ORG_BPS = 1000;
const DEFAULT_CONSULTANT_BPS = 8000;
const TOTAL_BPS = 10000;

/**
 * Percentages render with two decimals because 10000 bps / 100 = 100.00%
 * and we want the UI to mirror exactly what the DB stores. Dividing by
 * 100 converts bps → pct display; multiplying by 100 converts pct input
 * → bps. Anywhere there's arithmetic we stay in bps to avoid float drift.
 */
function bpsToPct(bps: number): string {
  return (bps / 100).toFixed(2);
}
function pctToBps(pct: string): number {
  const n = parseFloat(pct);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

export function RevenueRatesStep({ onNext, onBack, initialData }: StepProps) {
  const [platformBps, setPlatformBps] = useState(
    initialData.platformBps ?? DEFAULT_PLATFORM_BPS,
  );
  const [orgBps, setOrgBps] = useState(
    initialData.orgBps ?? DEFAULT_ORG_BPS,
  );
  const [consultantBps, setConsultantBps] = useState(
    initialData.consultantBps ?? DEFAULT_CONSULTANT_BPS,
  );

  const sum = platformBps + orgBps + consultantBps;
  const isValid = sum === TOTAL_BPS;
  const diffBps = TOTAL_BPS - sum;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    onNext({ platformBps, orgBps, consultantBps });
  };

  const makeHandler =
    (setter: React.Dispatch<React.SetStateAction<number>>) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const bps = pctToBps(e.target.value);
      setter(Math.min(TOTAL_BPS, Math.max(0, bps)));
    };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <p className="text-sm text-zinc-500">
        Each booking payment is split three ways. Percentages must sum to{" "}
        <strong>100%</strong> (10,000 basis points). You can adjust these
        later from organization settings — changes create a new rate card
        effective from the change date, so historical earnings stay at
        their original split.
      </p>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="platform-rate">Platform commission (%)</Label>
          <Input
            id="platform-rate"
            type="number"
            step="0.01"
            min={0}
            max={100}
            value={bpsToPct(platformBps)}
            onChange={makeHandler(setPlatformBps)}
          />
          <p className="text-xs text-zinc-500">Familiarise&apos;s fee per session.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="org-rate">Organization share (%)</Label>
          <Input
            id="org-rate"
            type="number"
            step="0.01"
            min={0}
            max={100}
            value={bpsToPct(orgBps)}
            onChange={makeHandler(setOrgBps)}
          />
          <p className="text-xs text-zinc-500">
            Your org&apos;s cut from each consultant&apos;s booking.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="consultant-rate">Consultant payout (%)</Label>
          <Input
            id="consultant-rate"
            type="number"
            step="0.01"
            min={0}
            max={100}
            value={bpsToPct(consultantBps)}
            onChange={makeHandler(setConsultantBps)}
          />
          <p className="text-xs text-zinc-500">
            What each consultant keeps. Can be overridden per consultant via
            a membership rate-card override.
          </p>
        </div>
      </div>

      {/* Live sum indicator */}
      <div
        className={`flex items-center justify-between rounded-lg px-4 py-3 text-sm font-medium ${
          isValid
            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
            : "bg-red-50 text-red-700 border border-red-200"
        }`}
      >
        <span>Total</span>
        <span>
          {bpsToPct(sum)}%{" "}
          {isValid
            ? "✓"
            : `— needs to be 100% (${diffBps > 0 ? "+" : ""}${bpsToPct(diffBps)}%)`}
        </span>
      </div>

      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={!isValid}>
          Next
        </Button>
      </div>
    </form>
  );
}
