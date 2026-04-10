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
    description: "Learners pay individually. Payments are tagged to your org for reporting.",
  },
  {
    value: "SEAT_PACK",
    label: "Seat pack",
    description: "Pre-buy credits. Learner bookings deduct from your credit pool.",
  },
  {
    value: "INVOICED_MONTHLY",
    label: "Invoiced monthly",
    description: "Learners book freely. You get one invoice at month-end.",
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
        <Select
          value={billingMode}
          onValueChange={(v) =>
            setValue("billingMode", v as BillingFormData["billingMode"])
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BILLING_MODES.map((mode) => (
              <SelectItem key={mode.value} value={mode.value}>
                {mode.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-zinc-500">
          {BILLING_MODES.find((m) => m.value === billingMode)?.description}
        </p>
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
