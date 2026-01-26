import React from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ConsulteeProfileFormSchema,
  OnboardingFormData,
} from "@/utils/onboarding";
import { z } from "zod";
import { CareerStage, BudgetPreference } from "@prisma/client";

type FormData = z.infer<typeof ConsulteeProfileFormSchema>;

interface Props {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  initialData: Partial<OnboardingFormData>;
}

const CAREER_STAGE_OPTIONS = [
  { value: "STUDENT", label: "Student" },
  { value: "EARLY_CAREER", label: "Early Career (0-3 years)" },
  { value: "MID_CAREER", label: "Mid Career (3-10 years)" },
  { value: "SENIOR", label: "Senior (10+ years)" },
  { value: "EXECUTIVE", label: "Executive / C-Level" },
];

const BUDGET_OPTIONS = [
  { value: "BUDGET", label: "Budget-friendly options" },
  { value: "MODERATE", label: "Mid-range pricing" },
  { value: "PREMIUM", label: "Premium services" },
  { value: "FLEXIBLE", label: "Flexible / No preference" },
];

const ConsulteeProfileForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(ConsulteeProfileFormSchema),
    mode: "onChange",
    defaultValues: {
      occupation: "",
      aboutMe: "",
      preferredCommunicationMethod: "VIDEO",
      preferredLanguage: "English",
      goals: [],
      careerStage: null,
      currentCompany: "",
      industry: "",
      skillsToDevelop: [],
      linkedinUrl: "",
      budgetPreference: null,
      ...initialData,
    },
  });

  const onSubmit = (data: FormData) => {
    onNext(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Career Information */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Career Information
        </h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="occupation">
              Current Role <span className="text-destructive">*</span>
            </Label>
            <Input
              id="occupation"
              {...register("occupation")}
              placeholder="e.g., Software Engineer"
            />
            {errors.occupation && (
              <p className="text-sm text-destructive">
                {errors.occupation.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="currentCompany">Company / Organization</Label>
            <Input
              id="currentCompany"
              {...register("currentCompany")}
              placeholder="e.g., Google, Startup, Freelance"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="careerStage">Career Stage</Label>
            <Controller
              name="careerStage"
              control={control}
              render={({ field }) => (
                <Select
                  value={field.value || undefined}
                  onValueChange={(value) =>
                    field.onChange(value as CareerStage)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select your career stage" />
                  </SelectTrigger>
                  <SelectContent>
                    {CAREER_STAGE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="industry">Industry</Label>
            <Input
              id="industry"
              {...register("industry")}
              placeholder="e.g., Technology, Healthcare, Finance"
            />
          </div>
        </div>
      </div>

      {/* About You */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          About You
        </h3>

        <div className="space-y-2">
          <Label htmlFor="aboutMe">
            Tell us about yourself <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="aboutMe"
            {...register("aboutMe")}
            placeholder="What are you working on? What challenges are you facing? What are you hoping to achieve?"
            rows={4}
          />
          {errors.aboutMe && (
            <p className="text-sm text-destructive">{errors.aboutMe.message}</p>
          )}
        </div>

      </div>

      {/* Goals & Preferences */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Goals & Preferences
        </h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="preferredLanguage">Preferred Language</Label>
            <Input
              id="preferredLanguage"
              {...register("preferredLanguage")}
              placeholder="e.g., English, Spanish"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="budgetPreference">Budget Preference</Label>
            <Controller
              name="budgetPreference"
              control={control}
              render={({ field }) => (
                <Select
                  value={field.value || undefined}
                  onValueChange={(value) =>
                    field.onChange(value as BudgetPreference)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select budget range" />
                  </SelectTrigger>
                  <SelectContent>
                    {BUDGET_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="linkedinUrl">
            LinkedIn Profile{" "}
            <span className="text-muted-foreground">(Optional)</span>
          </Label>
          <Input
            id="linkedinUrl"
            {...register("linkedinUrl")}
            placeholder="https://linkedin.com/in/yourprofile"
          />
          {errors.linkedinUrl && (
            <p className="text-sm text-destructive">
              {errors.linkedinUrl.message}
            </p>
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

export default ConsulteeProfileForm;
