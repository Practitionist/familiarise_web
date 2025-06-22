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
import { zodResolver } from "@hookform/resolvers/zod";
import React from "react";
import { useForm, Controller } from "react-hook-form";
import { useThemeClasses } from "../useTheme";

type OnboardingFormData = PersonalInfoAndRole &
  Partial<ConsulteeProfile> &
  Partial<ConsulteePreferences> & {
    preferredCommunicationMethod: "VIDEO" | "AUDIO" | "IN_PERSON";
    interests?: string[];
    goals?: string[];
  };

interface FormValues extends Omit<OnboardingFormData, "interests" | "goals"> {
  interests?: string;
  goals?: string;
}

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
  const { classes, colors } = useThemeClasses();
  const {
    register,
    handleSubmit,
    formState: { errors },
    control,
  } = useForm<FormValues>({
    defaultValues: {
      ...initialData,
      preferredCommunicationMethod:
        initialData.preferredCommunicationMethod || "VIDEO",
      interests: initialData.interests?.join(", "),
      goals: initialData.goals?.join(", "),
    },
  });

  const onSubmit = (data: FormValues) => {
    // Convert comma-separated strings to arrays
    const interests =
      data.interests
        ?.split(",")
        .map((i) => i.trim())
        .filter(Boolean) || [];
    const goals =
      data.goals
        ?.split(",")
        .map((g) => g.trim())
        .filter(Boolean) || [];

    onNext({
      ...data,
      interests,
      goals,
      preferredCommunicationMethod:
        data.preferredCommunicationMethod || "VIDEO",
    });
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full space-y-6"
    >
      <div className="space-y-3">
        <Label htmlFor="preferredCommunicationMethod" className={`${colors.textPrimary} font-medium`}>
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
              <SelectTrigger className={`${colors.inputBg} ${colors.inputBorder} ${colors.textPrimary} h-12 rounded-lg ${colors.inputFocus}`}>
                <SelectValue placeholder="Select communication method" className={colors.textSecondary} />
              </SelectTrigger>
              <SelectContent className={classes.dropdown}>
                <SelectItem value="VIDEO" className={classes.dropdownItem}>📹 Video</SelectItem>
                <SelectItem value="AUDIO" className={classes.dropdownItem}>🎙️ Audio</SelectItem>
                <SelectItem value="IN_PERSON" className={classes.dropdownItem}>👥 In Person</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        {errors.preferredCommunicationMethod && (
          <p className={`${colors.error} text-sm`}>
            {errors.preferredCommunicationMethod.message}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="preferredLanguage" className={`${colors.textPrimary} font-medium`}>Preferred Language</Label>
        <Input 
          id="preferredLanguage" 
          {...register("preferredLanguage")} 
          className={classes.input}
          placeholder="e.g., English, Spanish, French"
        />
        {errors.preferredLanguage && (
          <p className={`${colors.error} text-sm`}>{errors.preferredLanguage.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="specialRequirements" className={`${colors.textPrimary} font-medium`}>
          Special Requirements (Optional)
        </Label>
        <Textarea
          id="specialRequirements"
          {...register("specialRequirements")}
          className={classes.textarea}
          placeholder="Any accessibility needs or special accommodations..."
        />
        {errors.specialRequirements && (
          <p className={`${colors.error} text-sm`}>{errors.specialRequirements.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="interests" className={`${colors.textPrimary} font-medium`}>Interests (comma-separated)</Label>
        <Input
          id="interests"
          {...register("interests")}
          placeholder="e.g., Career Growth, Leadership, Technology"
          className={classes.input}
        />
        {errors.interests && (
          <p className={`${colors.error} text-sm`}>{errors.interests.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="goals" className={`${colors.textPrimary} font-medium`}>Goals (comma-separated)</Label>
        <Textarea
          id="goals"
          {...register("goals")}
          placeholder="e.g., Improve leadership skills, Learn new technologies"
          className={classes.textarea}
        />
        {errors.goals && <p className={`${colors.error} text-sm`}>{errors.goals.message}</p>}
      </div>

      <div className="flex justify-between gap-4 pt-6">
        <Button 
          type="button" 
          onClick={onBack} 
          className={`flex-1 h-12 ${classes.secondaryButton}`}
        >
          ← Back
        </Button>
        <Button 
          type="submit" 
          className={`flex-1 h-12 ${classes.primaryButton}`}
        >
          Next Step →
        </Button>
      </div>
    </form>
  );
};

export default ConsulteePreferencesForm;
