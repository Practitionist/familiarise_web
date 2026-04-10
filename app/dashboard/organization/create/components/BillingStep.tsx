"use client";

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
import { billingSchema, type BillingFormData } from "../schemas";
import type { StepProps } from "../types";

const BILLING_MODES = [
  {
    value: "TAG_ONLY",
    label: "Tag-only",
    description:
      "Learners pay at checkout with their own card. Payments are tagged to your organization for reporting and analytics. No org-level billing.",
  },
  {
    value: "SEAT_PACK",
    label: "Seat pack",
    description:
      "Your organization pre-purchases a credit pool. When learners book, credits are deducted automatically. Top up anytime from the dashboard.",
  },
  {
    value: "INVOICED_MONTHLY",
    label: "Invoiced monthly",
    description:
      "Learners book freely throughout the month. At month-end, your org receives one consolidated invoice. Pay within your configured NET terms.",
  },
];

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
      billingMode: (initialData.billingMode as BillingFormData["billingMode"]) ?? "TAG_ONLY",
      paymentTermsDays: initialData.paymentTermsDays ?? 30,
      seatsTotal: initialData.seatsTotal ?? null,
    },
  });

  const billingMode = watch("billingMode");

  const onSubmit = (data: BillingFormData) => onNext(data);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className="space-y-2">
        <Label>Billing mode</Label>
        <div className="space-y-2">
          {BILLING_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              onClick={() =>
                setValue("billingMode", mode.value as BillingFormData["billingMode"])
              }
              className={`w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
                billingMode === mode.value
                  ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900"
                  : "border-zinc-200 hover:border-zinc-300"
              }`}
            >
              <div
                className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  billingMode === mode.value
                    ? "border-zinc-900"
                    : "border-zinc-300"
                }`}
              >
                {billingMode === mode.value && (
                  <div className="w-2 h-2 rounded-full bg-zinc-900" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-900">
                  {mode.label}
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {mode.description}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {billingMode === "INVOICED_MONTHLY" && (
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
            e.g., 30 = NET-30 (invoice due within 30 days)
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="seatsTotal">Seat budget (optional)</Label>
        <Input
          id="seatsTotal"
          type="number"
          min={1}
          {...register("seatsTotal")}
          placeholder="Leave blank for unlimited"
        />
        <p className="text-xs text-zinc-500">
          Maximum number of learners who can join the org.
        </p>
      </div>

      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="submit">Next</Button>
      </div>
    </form>
  );
}
