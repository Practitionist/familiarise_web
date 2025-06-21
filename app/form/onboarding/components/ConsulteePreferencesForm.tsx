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
        <Label htmlFor="preferredCommunicationMethod" className="text-white font-medium">
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
              <SelectTrigger className="bg-white/10 border-white/20 text-white h-12 rounded-lg focus:border-purple-400 focus:ring-purple-400/20">
                <SelectValue placeholder="Select communication method" className="text-white/70" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-white/20">
                <SelectItem value="VIDEO" className="text-white focus:bg-white/10">📹 Video</SelectItem>
                <SelectItem value="AUDIO" className="text-white focus:bg-white/10">🎙️ Audio</SelectItem>
                <SelectItem value="IN_PERSON" className="text-white focus:bg-white/10">👥 In Person</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        {errors.preferredCommunicationMethod && (
          <p className="text-red-400 text-sm">
            {errors.preferredCommunicationMethod.message}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="preferredLanguage" className="text-white font-medium">Preferred Language</Label>
        <Input 
          id="preferredLanguage" 
          {...register("preferredLanguage")} 
          className="bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-purple-400 focus:ring-purple-400/20 backdrop-blur-sm h-12 rounded-lg"
          placeholder="e.g., English, Spanish, French"
        />
        {errors.preferredLanguage && (
          <p className="text-red-400 text-sm">{errors.preferredLanguage.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="specialRequirements" className="text-white font-medium">
          Special Requirements (Optional)
        </Label>
        <Textarea
          id="specialRequirements"
          {...register("specialRequirements")}
          className="bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-purple-400 focus:ring-purple-400/20 backdrop-blur-sm rounded-lg min-h-[100px] resize-none"
          placeholder="Any accessibility needs or special accommodations..."
        />
        {errors.specialRequirements && (
          <p className="text-red-400 text-sm">{errors.specialRequirements.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="interests" className="text-white font-medium">Interests (comma-separated)</Label>
        <Input
          id="interests"
          {...register("interests")}
          placeholder="e.g., Career Growth, Leadership, Technology"
          className="bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-purple-400 focus:ring-purple-400/20 backdrop-blur-sm h-12 rounded-lg"
        />
        {errors.interests && (
          <p className="text-red-400 text-sm">{errors.interests.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="goals" className="text-white font-medium">Goals (comma-separated)</Label>
        <Textarea
          id="goals"
          {...register("goals")}
          placeholder="e.g., Improve leadership skills, Learn new technologies"
          className="bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-purple-400 focus:ring-purple-400/20 backdrop-blur-sm rounded-lg min-h-[100px] resize-none"
        />
        {errors.goals && <p className="text-red-400 text-sm">{errors.goals.message}</p>}
      </div>

      <div className="flex justify-between gap-4 pt-6">
        <Button 
          type="button" 
          onClick={onBack} 
          className="flex-1 h-12 bg-white/10 border-white/20 text-white hover:bg-white/20 hover:border-white/30 rounded-lg font-medium transition-all duration-200"
        >
          ← Back
        </Button>
        <Button 
          type="submit" 
          className="flex-1 h-12 bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold rounded-lg shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 transition-all duration-200 border-0"
        >
          Next Step →
        </Button>
      </div>
    </form>
  );
};

export default ConsulteePreferencesForm;
