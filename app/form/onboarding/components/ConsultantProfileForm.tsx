import React from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ConsultantProfile, consultantProfileSchema } from "../../../../schemas/UserSchema";

interface Props {
  onNext: (data: Partial<ConsultantProfile>) => void;
  onBack: () => void;
  initialData: Partial<ConsultantProfile>;
}

const ConsultantProfileForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<ConsultantProfile>({
    resolver: zodResolver(consultantProfileSchema),
    defaultValues: {
      ...initialData,
      scheduleType: initialData.scheduleType || 'weekly',
      weeklySlots: initialData.weeklySlots || {},
      customSlots: initialData.customSlots || {},
    },
  });

  const onSubmit = (data: ConsultantProfile) => {
    onNext(data);
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full max-w-md space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="specialization">Specialization</Label>
        <Input
          id="specialization"
          {...register("specialization")}
        />
        {errors.specialization && (
          <p className="text-red-500">{errors.specialization.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="experience">Experience</Label>
        <Input
          id="experience"
          {...register("experience")}
        />
        {errors.experience && (
          <p className="text-red-500">{errors.experience.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="location">Location</Label>
        <Input id="location" {...register("location")} />
        {errors.location && (
          <p className="text-red-500">{errors.location.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" {...register("description")} />
        {errors.description && (
          <p className="text-red-500">{errors.description.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="tags">Tags (comma-separated)</Label>
        <Input id="tags" {...register("tags")} />
        {errors.tags && (
          <p className="text-red-500">{errors.tags.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="domain">Domain</Label>
        <Input id="domain" {...register("domain")} />
        {errors.domain && (
          <p className="text-red-500">{errors.domain.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="subDomains">Sub-Domains (comma-separated)</Label>
        <Input id="subDomains" {...register("subDomains")} />
        {errors.subDomains && (
          <p className="text-red-500">{errors.subDomains.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label>Schedule Type</Label>
        <Controller
          name="scheduleType"
          control={control}
          render={({ field }) => (
            <RadioGroup
              onValueChange={field.onChange}
              value={field.value}
              className="flex flex-col space-y-1"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="weekly" id="weekly" />
                <Label htmlFor="weekly">Weekly</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="custom" id="custom" />
                <Label htmlFor="custom">Custom</Label>
              </div>
            </RadioGroup>
          )}
        />
        {errors.scheduleType && <p className="text-red-500">{errors.scheduleType.message}</p>}
      </div>

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

export default ConsultantProfileForm;