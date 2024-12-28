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
import { SubscriptionPlan, SubscriptionPlanSchema } from "@/schemas/PlanSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import React from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";

interface Props {
  onNext: (data: SubscriptionPlan[]) => void;
  onBack: () => void;
  initialData: SubscriptionPlan[];
}

const SubscriptionPlanFormSchema = z.object({
  plans: SubscriptionPlanSchema.array().min(
    1,
    "At least one subscription plan is required",
  ),
});

type FormData = z.infer<typeof SubscriptionPlanFormSchema>;

const SubscriptionPlanForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(SubscriptionPlanFormSchema),
    defaultValues: {
      plans: initialData.length
        ? initialData
        : [
            {
              id: crypto.randomUUID(),
              title: "",
              description: "",
              durationInMonths: 1,
              price: 0,
              callsPerWeek: 1,
              videoMeetings: 1,
              emailSupport: "GENERAL",
              language: "English",
              level: "Beginner",
              prerequisites: "",
              materialProvided: "",
              learningOutcomes: [],
            },
          ],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "plans",
  });

  const onSubmit = async (data: FormData) => {
    console.log("Form submitted:", data);
    try {
      onNext(data.plans);
      console.log("onNext function called successfully");
    } catch (error) {
      console.error("Error in onNext function:", error);
    }
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full max-w-md space-y-4"
    >
      <h2 className="text-xl font-bold">Subscription Plans</h2>
      {fields.map((field, index) => (
        <div key={field.id} className="space-y-2 p-4 border rounded">
          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.title`}>Title</Label>
            <Input
              id={`plans.${index}.title`}
              type="text"
              {...register(`plans.${index}.title` as const)}
            />
            {errors.plans && errors.plans[index]?.title?.message && (
              <p className="text-red-500">
                {errors.plans[index]?.title?.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.description`}>Description</Label>
            <Input
              id={`plans.${index}.description`}
              type="text"
              {...register(`plans.${index}.description` as const)}
            />
            {errors.plans && errors.plans[index]?.description?.message && (
              <p className="text-red-500">
                {errors.plans[index]?.description?.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.durationInMonths`}>Duration</Label>
            <Controller
              name={`plans.${index}.durationInMonths` as const}
              control={control}
              render={({ field }) => (
                <Select
                  onValueChange={(value: string) =>
                    field.onChange(parseInt(value))
                  }
                  value={field.value?.toString()}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select duration" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">One Month</SelectItem>
                    <SelectItem value="3">Three Months</SelectItem>
                    <SelectItem value="6">Six Months</SelectItem>
                    <SelectItem value="12">Twelve Months</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            {errors.plans && errors.plans[index]?.durationInMonths?.message && (
              <p className="text-red-500">
                {errors.plans[index]?.durationInMonths?.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.price`}>Price (cents)</Label>
            <Input
              id={`plans.${index}.price`}
              type="number"
              {...register(`plans.${index}.price` as const, {
                valueAsNumber: true,
              })}
            />
            {errors.plans && errors.plans[index]?.price?.message && (
              <p className="text-red-500">
                {errors.plans[index]?.price?.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.callsPerWeek`}>
              Calls Per Week
            </Label>
            <Input
              id={`plans.${index}.callsPerWeek`}
              type="number"
              {...register(`plans.${index}.callsPerWeek` as const, {
                valueAsNumber: true,
              })}
            />
            {errors.plans && errors.plans[index]?.callsPerWeek?.message && (
              <p className="text-red-500">
                {errors.plans[index]?.callsPerWeek?.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`plans.${index}.videoMeetings`}>
              Video Meetings Per Month
            </Label>
            <Input
              id={`plans.${index}.videoMeetings`}
              type="number"
              {...register(`plans.${index}.videoMeetings` as const, {
                valueAsNumber: true,
              })}
            />
            {errors.plans && errors.plans[index]?.videoMeetings?.message && (
              <p className="text-red-500">
                {errors.plans[index]?.videoMeetings?.message}
              </p>
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
                    <SelectItem value="GENERAL">General</SelectItem>
                    <SelectItem value="PRIORITY">Priority</SelectItem>
                    <SelectItem value="DEDICATED">Dedicated</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            {errors.plans && errors.plans[index]?.emailSupport?.message && (
              <p className="text-red-500">
                {errors.plans[index]?.emailSupport?.message}
              </p>
            )}
          </div>

          {fields.length > 1 && (
            <Button
              type="button"
              onClick={() => remove(index)}
              variant="outline"
            >
              Remove Plan
            </Button>
          )}
        </div>
      ))}

      <Button
        type="button"
        onClick={() =>
          append({
            id: crypto.randomUUID(),
            title: "",
            description: "",
            durationInMonths: 1,
            price: 0,
            callsPerWeek: 1,
            videoMeetings: 1,
            emailSupport: "GENERAL",
            language: "English",
            level: "Beginner",
            prerequisites: "",
            materialProvided: "",
            learningOutcomes: [],
          })
        }
        variant="outline"
      >
        Add Plan
      </Button>

      {errors.plans?.root && (
        <p className="text-red-500">{errors.plans.root.message}</p>
      )}

      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="submit" variant="night" disabled={isSubmitting}>
          {isSubmitting ? "Submitting..." : "Next"}
        </Button>
      </div>

      {Object.keys(errors).length > 0 && (
        <p className="text-red-500">
          Please correct the errors in the form before submitting.
        </p>
      )}
    </form>
  );
};

export default SubscriptionPlanForm;
