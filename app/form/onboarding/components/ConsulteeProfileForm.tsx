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
  type OnboardingFormData,
} from "@/utils/onboarding";
import { z } from "zod";
import { CareerStage } from "@prisma/client";
import { CompanyLogo, lookupCompanyDomain } from "@/components/ui/company-logo";
import {
  InstitutionLogo,
  lookupInstitutionDomain,
} from "@/components/ui/institution-logo";
import {
  GraduationCap,
  Briefcase,
  BookOpen,
  TrendingUp,
  Crown,
  Rocket,
} from "lucide-react";

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
  {
    value: "STUDENT" as const,
    label: "Student",
    description: "Currently pursuing education",
    icon: GraduationCap,
  },
  {
    value: "EARLY_CAREER" as const,
    label: "Early Career",
    description: "0-3 years experience",
    icon: Rocket,
  },
  {
    value: "MID_CAREER" as const,
    label: "Mid Career",
    description: "3-10 years experience",
    icon: Briefcase,
  },
  {
    value: "SENIOR" as const,
    label: "Senior",
    description: "10+ years experience",
    icon: TrendingUp,
  },
  {
    value: "EXECUTIVE" as const,
    label: "Executive",
    description: "C-Level / Leadership",
    icon: Crown,
  },
];

const isStudentStage = (stage: string | null | undefined) =>
  stage === "STUDENT";

const isProfessionalStage = (stage: string | null | undefined) =>
  stage === "EARLY_CAREER" ||
  stage === "MID_CAREER" ||
  stage === "SENIOR" ||
  stage === "EXECUTIVE";

/** Extract only the consultee-relevant fields from the mega OnboardingFormData */
function pickConsulteeDefaults(
  data: Partial<OnboardingFormData>,
): Partial<FormData> {
  const picked: Partial<FormData> = {
    aboutMe: data.aboutMe ?? "",
    preferredLanguage: data.preferredLanguage ?? "English",
    goals: data.goals ?? "",
    skillsToDevelop: data.skillsToDevelop ?? [],
    budgetPreference: data.budgetPreference,
  };
  // Only set careerStage if it's a valid non-null value
  if (data.careerStage) {
    picked.careerStage = data.careerStage;
  }
  if (data.consulteeInlineEducation) {
    picked.consulteeInlineEducation = data.consulteeInlineEducation;
  }
  if (data.consulteeInlineWorkExperience) {
    picked.consulteeInlineWorkExperience = data.consulteeInlineWorkExperience;
  }
  return picked;
}

const ConsulteeProfileForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const defaults = pickConsulteeDefaults(initialData);

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(ConsulteeProfileFormSchema),
    mode: "onChange",
    defaultValues: defaults,
  });

  const selectedStage = watch("careerStage");

  useEffect(() => {
    if (initialData && Object.keys(initialData).length > 0) {
      reset(pickConsulteeDefaults(initialData));
    }
  }, [initialData, reset]);

  const onSubmit = (data: FormData) => {
    onNext({ ...initialData, ...data });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Career Stage Selector */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">
          Where are you in your career?{" "}
          <span className="text-destructive">*</span>
        </Label>
        <Controller
          name="careerStage"
          control={control}
          render={({ field }) => (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {CAREER_STAGE_OPTIONS.map((option) => {
                const Icon = option.icon;
                const isSelected = field.value === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() =>
                      field.onChange(option.value as CareerStage)
                    }
                    className={`flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all ${
                      isSelected
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-muted hover:border-muted-foreground/30 hover:bg-muted/50"
                    }`}
                  >
                    <Icon
                      className={`w-5 h-5 mt-0.5 flex-shrink-0 ${isSelected ? "text-primary" : "text-muted-foreground"}`}
                    />
                    <div>
                      <p
                        className={`font-medium text-sm ${isSelected ? "text-primary" : "text-foreground"}`}
                      >
                        {option.label}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {option.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        />
        {errors.careerStage && (
          <p className="text-sm text-destructive">
            Please select your career stage
          </p>
        )}
      </div>

      {/* Adaptive Section: STUDENT */}
      {isStudentStage(selectedStage) && (
        <div className="space-y-4 p-4 rounded-lg bg-muted/30 border">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <BookOpen className="w-4 h-4" />
            Education Details
            <span className="text-xs font-normal">(optional)</span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="institution">Institution</Label>
            <Controller
              name="consulteeInlineEducation.institution"
              control={control}
              render={({ field }) => (
                <div className="flex items-center gap-3">
                  {field.value && (
                    <InstitutionLogo
                      institutionName={field.value}
                      institutionDomain={watch(
                        "consulteeInlineEducation.institutionDomain",
                      )}
                      size={36}
                    />
                  )}
                  <Input
                    id="institution"
                    value={field.value || ""}
                    onChange={(e) => {
                      const name = e.target.value;
                      field.onChange(name);
                      const domain = lookupInstitutionDomain(name);
                      if (domain) {
                        setValue(
                          "consulteeInlineEducation.institutionDomain",
                          domain,
                        );
                      }
                    }}
                    placeholder="e.g., IIT Bombay, Stanford University"
                  />
                </div>
              )}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="fieldOfStudy">Field of Study</Label>
              <Input
                id="fieldOfStudy"
                {...register("consulteeInlineEducation.fieldOfStudy")}
                placeholder="e.g., Computer Science"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="endYear">Expected Graduation</Label>
              <Controller
                name="consulteeInlineEducation.endYear"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value?.toString() || ""}
                    onValueChange={(v) =>
                      field.onChange(v ? parseInt(v) : undefined)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Year" />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 10 }, (_, i) => {
                        const year = new Date().getFullYear() + 5 - i;
                        return (
                          <SelectItem key={year} value={year.toString()}>
                            {year}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>
        </div>
      )}

      {/* Adaptive Section: PROFESSIONAL */}
      {isProfessionalStage(selectedStage) && (
        <div className="space-y-4 p-4 rounded-lg bg-muted/30 border">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Briefcase className="w-4 h-4" />
            Current Position
            <span className="text-xs font-normal">(optional)</span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="title">Current Role</Label>
              <Input
                id="title"
                {...register("consulteeInlineWorkExperience.title")}
                placeholder="e.g., Software Engineer"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company">Company</Label>
              <Controller
                name="consulteeInlineWorkExperience.company"
                control={control}
                render={({ field }) => (
                  <div className="flex items-center gap-3">
                    {field.value && (
                      <CompanyLogo
                        companyName={field.value}
                        companyDomain={watch(
                          "consulteeInlineWorkExperience.companyDomain",
                        )}
                        size={36}
                      />
                    )}
                    <Input
                      id="company"
                      value={field.value || ""}
                      onChange={(e) => {
                        const name = e.target.value;
                        field.onChange(name);
                        const domain = lookupCompanyDomain(name);
                        if (domain) {
                          setValue(
                            "consulteeInlineWorkExperience.companyDomain",
                            domain,
                          );
                        }
                      }}
                      placeholder="e.g., Google, Startup"
                    />
                  </div>
                )}
              />
            </div>
          </div>
        </div>
      )}

      {/* About You */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          About You
        </h3>

        <div className="space-y-2">
          <Label htmlFor="aboutMe">Tell us about yourself</Label>
          <Textarea
            id="aboutMe"
            {...register("aboutMe")}
            placeholder="What are you working on? What challenges are you facing?"
            rows={3}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="goals">What do you hope to achieve?</Label>
          <Textarea
            id="goals"
            {...register("goals")}
            placeholder="e.g., Improve leadership skills, Learn new technologies, Career transition"
            rows={2}
          />
        </div>

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
      </div>

      <p className="text-xs text-muted-foreground text-center">
        You can add more details later in Settings
      </p>

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
