import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ConsulteeProfile, ConsulteeProfileSchema } from "@/schemas/UserSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import React from "react";
import { useForm, Controller } from "react-hook-form";

interface Props {
  onNext: (data: Partial<ConsulteeProfile>) => void;
  onBack: () => void;
  initialData: Partial<ConsulteeProfile>;
}

const ConsulteePreferencesForm: React.FC<Props> = ({ onNext, onBack, initialData }) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
    control,
  } = useForm<ConsulteeProfile>({
    resolver: zodResolver(ConsulteeProfileSchema),
    defaultValues: initialData,
  });

  const onSubmit = (data: ConsulteeProfile) => {
    onNext(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-full max-w-md space-y-4">
      <div className="space-y-2">
        <Label htmlFor="preferredCommunicationMethod">Preferred Communication Method</Label>
        <Controller
          name="preferredCommunicationMethod"
          control={control}
          render={({ field }) => (
            <Select onValueChange={field.onChange} value={field.value}>
              <SelectTrigger>
                <SelectValue placeholder="Select communication method" />
              </SelectTrigger>
              <SelectContent className="bg-slate-100">
                <SelectItem value="VIDEO">Video</SelectItem>
                <div className="border-t border-gray-300 my-1"></div>
                <SelectItem value="AUDIO">Audio</SelectItem>
                <div className="border-t border-gray-300 my-1"></div>
                <SelectItem value="IN_PERSON">In Person</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        {errors.preferredCommunicationMethod && (
          <p className="text-red-500">{errors.preferredCommunicationMethod.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="preferredLanguage">Preferred Language</Label>
        <Input id="preferredLanguage" {...register("preferredLanguage")} />
        {errors.preferredLanguage && (
          <p className="text-red-500">{errors.preferredLanguage.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="specialRequirements">Special Requirements (Optional)</Label>
        <Textarea id="specialRequirements" {...register("specialRequirements")} />
        {errors.specialRequirements && (
          <p className="text-red-500">{errors.specialRequirements.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="interests">Interests (comma-separated)</Label>
        <Input id="interests" {...register("interests")} />
        {errors.interests && (
          <p className="text-red-500">{errors.interests.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="goals">Goals</Label>
        <Textarea id="goals" {...register("goals")} />
        {errors.goals && (
          <p className="text-red-500">{errors.goals.message}</p>
        )}
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

export default ConsulteePreferencesForm;