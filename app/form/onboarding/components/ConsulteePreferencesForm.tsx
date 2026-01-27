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
import { Textarea } from "@/components/ui/textarea";
import {
  ConsulteeProfile,
  ConsulteePreferences,
  PersonalInfoAndRole,
} from "@/schemas/user";
import React, { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";

type OnboardingFormData = PersonalInfoAndRole &
  Partial<ConsulteeProfile> &
  Partial<ConsulteePreferences> & {
    preferredCommunicationMethod: "VIDEO" | "AUDIO" | "IN_PERSON";
    goals?: string[];
  };

interface FormValues extends Omit<OnboardingFormData, "goals"> {
  goals?: string;
}

interface Props {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  initialData: Partial<OnboardingFormData>;
}

const COMMUNICATION_OPTIONS = [
  { value: "VIDEO", label: "Video Call" },
  { value: "AUDIO", label: "Audio Call" },
  { value: "IN_PERSON", label: "In Person" },
];

const ConsulteePreferencesForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
    control,
    reset,
  } = useForm<FormValues>({
    defaultValues: {
      ...initialData,
      preferredCommunicationMethod:
        initialData.preferredCommunicationMethod || "VIDEO",
      goals: initialData.goals?.join(", "),
    },
  });

  // Sync form values when initialData changes (for back navigation)
  useEffect(() => {
    if (initialData && Object.keys(initialData).length > 0) {
      reset({
        ...initialData,
        preferredCommunicationMethod:
          initialData.preferredCommunicationMethod || "VIDEO",
        goals: initialData.goals?.join(", "),
      });
    }
  }, [initialData, reset]);

  const onSubmit = (data: FormValues) => {
    // Convert comma-separated strings to arrays
    const goals =
      data.goals
        ?.split(",")
        .map((g) => g.trim())
        .filter(Boolean) || [];

    onNext({
      ...data,
      goals,
      preferredCommunicationMethod:
        data.preferredCommunicationMethod || "VIDEO",
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Communication Preferences */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Communication Preferences
        </h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="preferredCommunicationMethod">
              Preferred Communication Method
            </Label>
            <Controller
              name="preferredCommunicationMethod"
              control={control}
              defaultValue="VIDEO"
              render={({ field }) => (
                <Select
                  onValueChange={field.onChange}
                  value={field.value || "VIDEO"}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select communication method" />
                  </SelectTrigger>
                  <SelectContent>
                    {COMMUNICATION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.preferredCommunicationMethod && (
              <p className="text-sm text-destructive">
                {errors.preferredCommunicationMethod.message}
              </p>
            )}
          </div>

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
      </div>

      {/* Goals */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Your Goals
        </h3>

        <div className="space-y-2">
          <Label htmlFor="goals">
            What do you hope to achieve?{" "}
            <span className="text-muted-foreground">(comma-separated)</span>
          </Label>
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
