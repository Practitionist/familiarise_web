"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STATE_NUMERIC_TO_NAME } from "@/lib/compliance/state-codes";
import {
  MotivationBanner,
  resolveFundingRailMotivation,
} from "@/components/organization/MotivationBanner";
import { AdvancedPermutationGate } from "@/components/organization/AdvancedPermutationGate";
import { billingSchema, type BillingFormData } from "./schemas";
import type { StepProps } from "./types";
import {
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_TAGLINE,
  SELF_SERVICE_FUNDING_SOURCES,
  narrowFundingSource,
} from "@/lib/labels/org-labels";

export function BillingStep({ onNext, onBack, initialData }: StepProps) {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<BillingFormData>({
    resolver: zodResolver(billingSchema),
    defaultValues: {
      fundingSource: narrowFundingSource(initialData.fundingSource),
      paymentTermsDays: initialData.paymentTermsDays ?? 60,
      gstStateCode: initialData.gstStateCode ?? "",
    },
  });

  const fundingSource = watch("fundingSource");
  const [personalAcknowledged, setPersonalAcknowledged] = useState(
    initialData.fundingSource === "PERSONAL",
  );
  const motivation = resolveFundingRailMotivation(fundingSource);
  const goldenRails = SELF_SERVICE_FUNDING_SOURCES.filter(
    (fs) => fs !== "PERSONAL",
  );

  const onSubmit = (data: BillingFormData) => onNext(data);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className="space-y-2">
        <Label>Funding source</Label>
        <p className="text-xs text-zinc-500">
          How your organization pays when a member books a session.
        </p>
        <div className="space-y-2">
          {goldenRails.map((fs) => (
            <button
              key={fs}
              type="button"
              onClick={() => setValue("fundingSource", fs)}
              className={`w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
                fundingSource === fs
                  ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900"
                  : "border-zinc-200 hover:border-zinc-300"
              }`}
            >
              <div
                className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  fundingSource === fs ? "border-zinc-900" : "border-zinc-300"
                }`}
              >
                {fundingSource === fs && (
                  <div className="w-2 h-2 rounded-full bg-zinc-900" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-900">
                  {FUNDING_SOURCE_LABEL[fs]}
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {FUNDING_SOURCE_TAGLINE[fs]}
                </p>
              </div>
            </button>
          ))}
        </div>

        <AdvancedPermutationGate
          isActivePermutation={fundingSource === "PERSONAL"}
          isDiscouraged={fundingSource === "PERSONAL"}
          acknowledged={personalAcknowledged}
          onAcknowledgeChange={setPersonalAcknowledged}
          discouragedConfirmationText="I understand that Personal reimbursement mode requires employees to pay out of pocket with personal cards at checkout and does not produce B2B GST invoices for Input Tax Credit."
          onSelectRecommended={() => {
            setValue("fundingSource", "WALLET");
            setPersonalAcknowledged(false);
          }}
          recommendedActionLabel="Switch to Prepaid Wallet (Recommended)"
          toggleLabel="Show Non-Standard Reimbursement Mode (Personal Card)"
        >
          <button
            type="button"
            onClick={() => setValue("fundingSource", "PERSONAL")}
            className={`w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
              fundingSource === "PERSONAL"
                ? "border-rose-700 bg-rose-50/50 ring-1 ring-rose-700"
                : "border-zinc-200 bg-white hover:border-zinc-300"
            }`}
          >
            <div
              className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                fundingSource === "PERSONAL"
                  ? "border-rose-700"
                  : "border-zinc-300"
              }`}
            >
              {fundingSource === "PERSONAL" && (
                <div className="w-2 h-2 rounded-full bg-rose-700" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-900">
                {FUNDING_SOURCE_LABEL.PERSONAL}
              </p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {FUNDING_SOURCE_TAGLINE.PERSONAL}
              </p>
            </div>
          </button>
        </AdvancedPermutationGate>

        <MotivationBanner
          tier={motivation.tier}
          title={motivation.title}
          message={motivation.message}
          recommendation={motivation.recommendation}
          actionLabel={
            motivation.recommendedFallback
              ? "Switch to Prepaid Wallet"
              : undefined
          }
          onAction={
            motivation.recommendedFallback
              ? () => {
                  setValue("fundingSource", motivation.recommendedFallback!);
                  setPersonalAcknowledged(false);
                }
              : undefined
          }
          compact
        />
      </div>

      {fundingSource === "INVOICE" && (
        <div className="space-y-2">
          <Label htmlFor="paymentTermsDays">Payment terms (days)</Label>
          <Input
            id="paymentTermsDays"
            type="number"
            min={1}
            max={120}
            {...register("paymentTermsDays")}
          />
          {errors.paymentTermsDays && (
            <p className="text-sm text-red-500">
              {errors.paymentTermsDays.message}
            </p>
          )}
          <p className="text-xs text-zinc-500">
            NET-{watch("paymentTermsDays") || 60} — monthly invoices are due
            within this window. India Net-60 is the default.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label>GST state</Label>
        <Select
          value={watch("gstStateCode")}
          onValueChange={(v) =>
            setValue("gstStateCode", v, { shouldValidate: true })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="Select your state" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STATE_NUMERIC_TO_NAME).map(([code, name]) => (
              <SelectItem key={code} value={code}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.gstStateCode && (
          <p className="text-sm text-red-500">{errors.gstStateCode.message}</p>
        )}
        <p className="text-xs text-zinc-500">
          The state your organisation is registered in for GST; it sets the tax
          on your invoices.
        </p>
      </div>

      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button
          type="submit"
          disabled={fundingSource === "PERSONAL" && !personalAcknowledged}
        >
          Next
        </Button>
      </div>
    </form>
  );
}
