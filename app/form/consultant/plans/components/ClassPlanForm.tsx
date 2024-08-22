// File: app/form/consultant/plans/components/ClassPlanForm.tsx

import React from "react";
import { useForm, useFieldArray, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { classPlanSchema } from "@/schemas/PlanSchema";
import { ClassPlan, SubscriptionEmailSupport } from "@prisma/client";

interface Props {
  onSubmit: (data: ClassPlan[]) => void;
  onBack: () => void;
  initialData: ClassPlan[];
}

const ClassPlanForm: React.FC<Props> = ({
  onSubmit,
  onBack,
  initialData,
}) => {
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<{ plans: ClassPlan[] }>({
    resolver: zodResolver(classPlanSchema.array()),
    defaultValues: { plans: initialData.length ? initialData : [{ duration: 1, price: 0, callsPerWeek: 1, videoMeetings: 1, emailSupport: SubscriptionEmailSupport.GENERAL }] },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "plans",
  });

  const onSubmitForm = (data: { plans: ClassPlan[] }) => {
    onSubmit(data.plans);
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmitForm)}
      className="w-full max-w-md space-y-4"
    >
      <h2 className="text-xl font-bold">Class Plans</h2>
      {fields.map((field, index) => (
        <div key={field.id} className="space-y-2 p-4 border rounded">
          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.duration`}>Duration (weeks)</Label>
            <Input
              id={`plans.${index}.duration`}
              type="number"
              step="0.5"
              {...register(`plans.${index}.duration` as const, { valueAsNumber: true })}
            />
            {errors.plans?.[index]?.duration && (
              <p className="text-red-500">{errors.plans?.[index]?.duration?.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.price`}>Price (cents)</Label>
            <Input
              id={`plans.${index}.price`}
              type="number"
              {...register(`plans.${index}.price` as const, { valueAsNumber: true })}
            />
            {errors.plans?.[index]?.price && (
              <p className="text-red-500">{errors.plans?.[index]?.price?.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.callsPerWeek`}>Calls Per Week</Label>
            <Input
              id={`plans.${index}.callsPerWeek`}
              type="number"
              {...register(`plans.${index}.callsPerWeek` as const, { valueAsNumber: true })}
            />
            {errors.plans?.[index]?.callsPerWeek && (
              <p className="text-red-500">{errors.plans?.[index]?.callsPerWeek?.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.videoMeetings`}>Video Meetings Per Month</Label>
            <Input
              id={`plans.${index}.videoMeetings`}
              type="number"
              {...register(`plans.${index}.videoMeetings` as const, { valueAsNumber: true })}
            />
            {errors.plans?.[index]?.videoMeetings && (
              <p className="text-red-500">{errors.plans?.[index]?.videoMeetings?.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.emailSupport`}>Email Support</Label>
            <Controller
              name={`plans.${index}.emailSupport` as const}
              control={control}
              render={({ field }) => (
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select email support level" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SubscriptionEmailSupport.GENERAL}>General</SelectItem>
                    <SelectItem value={SubscriptionEmailSupport.PRIORITY}>Priority</SelectItem>
                    <SelectItem value={SubscriptionEmailSupport.DEDICATED}>Dedicated</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            {errors.plans?.[index]?.emailSupport && (
              <p className="text-red-500">{errors.plans?.[index]?.emailSupport?.message}</p>
            )}
          </div>

          <Button type="button" onClick={() => remove(index)} variant="outline">
            Remove Plan
          </Button>
        </div>
      ))}

      <Button
        type="button"
        onClick={() => append({ 
          id: crypto.randomUUID(),
          duration: 1, 
          price: 0, 
          callsPerWeek: 1, 
          videoMeetings: 1, 
          emailSupport: SubscriptionEmailSupport.GENERAL,
          consultantProfileId: null,
          createdAt: new Date(),
          updatedAt: new Date()
        })}
        variant="outline"
      >
        Add Plan
      </Button>

      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="submit" variant="night">
          Submit
        </Button>
      </div>
    </form>
  );
};

export default ClassPlanForm;