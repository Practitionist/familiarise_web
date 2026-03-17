import React, { useEffect } from "react";
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
import { CareerStage } from "@prisma/client";

type FormData = z.infer<typeof ConsulteeProfileFormSchema>;

interface Props {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  initialData: Partial<OnboardingFormData>;
}

const LANGUAGE_OPTIONS = [
  "English",
  "Hindi",
  "Spanish",
  "French",
  "German",
  "Mandarin",
  "Japanese",
  "Portuguese",
  "Arabic",
  "Korean",
  "Tamil",
  "Telugu",
  "Bengali",
  "Marathi",
  "Gujarati",
];

const CAREER_STAGE_OPTIONS = [
  { value: "STUDENT", label: "Student" },
  { value: "EARLY_CAREER", label: "Early Career (0-3 years)" },
  { value: "MID_CAREER", label: "Mid Career (3-10 years)" },
  { value: "SENIOR", label: "Senior (10+ years)" },
  { value: "EXECUTIVE", label: "Executive / C-Level" },
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
    reset,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(ConsulteeProfileFormSchema),
    mode: "onChange",
    defaultValues: {
      occupation: "",
      aboutMe: "",
      preferredLanguage: "English",
      goals: "",
      careerStage: null,
      currentCompany: "",
      industry: "",
      skillsToDevelop: [],
      ...initialData,
    },
  });

  // Sync form values when initialData changes (for back navigation)
  useEffect(() => {
    if (initialData && Object.keys(initialData).length > 0) {
      reset({
        occupation: "",
        aboutMe: "",
        preferredLanguage: "English",
        goals: "",
        careerStage: null,
        currentCompany: "",
        industry: "",
        skillsToDevelop: [],
        ...initialData,
      });
    }
  }, [initialData, reset]);

  const onSubmit = (data: FormData) => {
    onNext({ ...initialData, ...data });
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
                  // Radix Select returns string; values are CareerStage enum members
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

      {/* Preferences */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Preferences
        </h3>

        <div className="space-y-2">
          <Label htmlFor="preferredLanguage">Preferred Language</Label>
          <Controller
            name="preferredLanguage"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value || "English"}
                onValueChange={field.onChange}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((lang) => (
                    <SelectItem key={lang} value={lang}>
                      {lang}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>

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

export default ConsulteeProfileForm;
