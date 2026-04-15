"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { StepProps } from "../types";

// Platform defaults (10 / 5 / 85)
const DEFAULT_PLATFORM = 10;
const DEFAULT_ORG = 5;
const DEFAULT_CONSULTANT = 85;

export function RevenueRatesStep({ onNext, onBack, initialData }: StepProps) {
  const [platform, setPlatform] = useState(
    initialData.platformCommissionRate != null
      ? Math.round(initialData.platformCommissionRate * 100)
      : DEFAULT_PLATFORM,
  );
  const [org, setOrg] = useState(
    initialData.orgRetainRate != null
      ? Math.round(initialData.orgRetainRate * 100)
      : DEFAULT_ORG,
  );
  const [consultant, setConsultant] = useState(
    initialData.consultantPayoutRate != null
      ? Math.round(initialData.consultantPayoutRate * 100)
      : DEFAULT_CONSULTANT,
  );

  const sum = platform + org + consultant;
  const isValid = sum === 100;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    onNext({
      platformCommissionRate: platform / 100,
      orgRetainRate: org / 100,
      consultantPayoutRate: consultant / 100,
    });
  };

  const makeHandler =
    (setter: React.Dispatch<React.SetStateAction<number>>) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseInt(e.target.value, 10);
      setter(isNaN(v) ? 0 : Math.min(100, Math.max(0, v)));
    };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <p className="text-sm text-zinc-500">
        Each booking payment is split three ways. Rates must sum to{" "}
        <strong>100%</strong>. You can adjust these later in organization
        settings.
      </p>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="platform-rate">Platform commission (%)</Label>
          <Input
            id="platform-rate"
            type="number"
            min={0}
            max={100}
            value={platform}
            onChange={makeHandler(setPlatform)}
          />
          <p className="text-xs text-zinc-500">Familiarise's fee per session.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="org-rate">Organization share (%)</Label>
          <Input
            id="org-rate"
            type="number"
            min={0}
            max={100}
            value={org}
            onChange={makeHandler(setOrg)}
          />
          <p className="text-xs text-zinc-500">
            Your org's cut from each consultant's booking.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="consultant-rate">Consultant payout (%)</Label>
          <Input
            id="consultant-rate"
            type="number"
            min={0}
            max={100}
            value={consultant}
            onChange={makeHandler(setConsultant)}
          />
          <p className="text-xs text-zinc-500">
            What each consultant keeps. Can be overridden per consultant.
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
          {sum}% {isValid ? "✓" : `— needs to be 100% (${100 - sum > 0 ? "+" : ""}${100 - sum}%)`}
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
