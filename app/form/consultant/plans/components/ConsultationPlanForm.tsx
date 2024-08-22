// File: app/form/consultant/plans/components/ConsultationPlanForm.tsx

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConsultationPlan, consultationPlanSchema } from "@/schemas/PlanSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import React from "react";
import { useFieldArray, useForm } from "react-hook-form";

interface Props {
  onNext: (data: ConsultationPlan[]) => void;
  onBack: () => void;
  initialData: ConsultationPlan[];
}

const ConsultationPlanForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<{ plans: ConsultationPlan[] }>({
    resolver: zodResolver(consultationPlanSchema.array()),
    defaultValues: { plans: initialData.length ? initialData : [{ id: '', duration: 1, price: 0, consultantProfileId: null, createdAt: new Date(), updatedAt: new Date() }] },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "plans",
  });

  const onSubmit = (data: { plans: ConsultationPlan[] }) => {
    onNext(data.plans);
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full max-w-md space-y-4"
    >
      <h2 className="text-xl font-bold">Consultation Plans</h2>
      {fields.map((field, index) => (
        <div key={field.id} className="space-y-2 p-4 border rounded">
          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.duration`}>Duration (hours)</Label>
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

          <Button type="button" onClick={() => remove(index)} variant="outline">
            Remove Plan
          </Button>
        </div>
      ))}

      <Button
        type="button"
        onClick={() =>
          append({
            id: '',
            duration: 1,
            price: 0,
            consultantProfileId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
        }
        variant="outline"
      >
        Add Plan
      </Button>

      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="submit" variant="night">
          Next
        </Button>
      </div>
    </form>
  );
};

export default ConsultationPlanForm;