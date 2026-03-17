import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  ConsulteeProfile,
  ConsulteePreferences,
  PersonalInfoAndRole,
} from "@/schemas/user";
import React, { useEffect } from "react";
import { useForm } from "react-hook-form";

type OnboardingFormData = PersonalInfoAndRole &
  Partial<ConsulteeProfile> &
  Partial<ConsulteePreferences> & {
    goals?: string;
  };

interface Props {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  initialData: Partial<OnboardingFormData>;
}

const ConsulteePreferencesForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<OnboardingFormData>({
    defaultValues: {
      ...initialData,
      goals: initialData.goals,
    },
  });

  // Sync form values when initialData changes (for back navigation)
  useEffect(() => {
    if (initialData && Object.keys(initialData).length > 0) {
      reset({
        ...initialData,
        goals: initialData.goals,
      });
    }
  }, [initialData, reset]);

  const onSubmit = (data: OnboardingFormData) => {
    onNext({
      ...initialData,
      ...data,
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Communication Preferences */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Communication Preferences
        </h3>

        <div className="space-y-2">
          <Label htmlFor="preferredLanguage">Preferred Language</Label>
          <Input
            id="preferredLanguage"
            {...register("preferredLanguage")}
            placeholder="e.g., English, Spanish, French"
          />
          {errors.preferredLanguage && (
            <p className="text-sm text-destructive">
              {errors.preferredLanguage.message}
            </p>
          )}
        </div>
      </div>

      {/* Goals */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Your Goals
        </h3>

        <div className="space-y-2">
          <Label htmlFor="goals">What do you hope to achieve?</Label>
          <Textarea
            id="goals"
            {...register("goals")}
            placeholder="e.g., Improve leadership skills, Learn new technologies, Career transition"
            rows={3}
          />
          {errors.goals && (
            <p className="text-sm text-destructive">{errors.goals.message}</p>
          )}
        </div>
      </div>

      {/* Navigation */}
      <div className="flex gap-4 pt-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className="flex-1"
        >
          Back
        </Button>
        <Button type="submit" className="flex-1">
          Continue
        </Button>
      </div>
    </form>
  );
};

export default ConsulteePreferencesForm;
