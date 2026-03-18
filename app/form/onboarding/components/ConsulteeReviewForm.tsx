import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Pencil } from "lucide-react";
import {
  ConsulteeProfile,
  PersonalInfoAndRole,
} from "@/schemas/user";

type ConsulteeFormData = Partial<PersonalInfoAndRole> &
  Partial<ConsulteeProfile> & {
    goals?: string;
    consulteeInlineEducation?: {
      institution?: string;
      institutionDomain?: string;
      fieldOfStudy?: string;
      endYear?: number;
    };
    consulteeInlineWorkExperience?: {
      title?: string;
      company?: string;
      companyDomain?: string;
    };
  };

interface Props {
  onSubmit: (data: ConsulteeFormData) => void;
  onBack: () => void;
  formData: ConsulteeFormData;
  onGoToStep?: (step: number) => void;
}

const CAREER_STAGE_LABELS: Record<string, string> = {
  SCHOOL_STUDENT: "School Student",
  STUDENT: "Student",
  EARLY_CAREER: "Early Career (0-3 years)",
  MID_CAREER: "Mid Career (3-10 years)",
  SENIOR: "Senior (10+ years)",
  EXECUTIVE: "Executive / C-Level",
};

const ConsulteeReviewForm: React.FC<Props> = ({
  onSubmit,
  onBack,
  formData,
  onGoToStep,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    onSubmit(formData);
  };

  const renderSection = (
    title: string,
    content: React.ReactNode,
    editStep?: number,
  ) => (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {title}
        </h3>
        {onGoToStep && editStep !== undefined && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onGoToStep(editStep)}
            title={`Edit ${title}`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
      {content}
    </div>
  );

  const renderField = (label: string, value: string | undefined) => (
    <div className="grid grid-cols-3 gap-2 py-2 border-b last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="col-span-2 text-sm">{value || "Not provided"}</span>
    </div>
  );

  const isStudent = formData.careerStage === "STUDENT";
  const isProfessional =
    formData.careerStage === "EARLY_CAREER" ||
    formData.careerStage === "MID_CAREER" ||
    formData.careerStage === "SENIOR" ||
    formData.careerStage === "EXECUTIVE";

  return (
    <div className="space-y-6">
      {renderSection(
        "Personal Information",
        <div className="bg-muted/50 rounded-lg p-4">
          {renderField("Name", formData.name)}
          {renderField("Email", formData.email)}
          {renderField("Phone", formData.phone)}
          {renderField("City", formData.city)}
          {renderField("Country", formData.country)}
        </div>,
        0,
      )}

      {renderSection(
        "Profile Details",
        <div className="bg-muted/50 rounded-lg p-4">
          {renderField(
            "Career Stage",
            formData.careerStage
              ? CAREER_STAGE_LABELS[formData.careerStage] ||
                  formData.careerStage
              : undefined,
          )}
          {isStudent && (
            <>
              {renderField(
                "Institution",
                formData.consulteeInlineEducation?.institution,
              )}
              {renderField(
                "Field of Study",
                formData.consulteeInlineEducation?.fieldOfStudy,
              )}
              {renderField(
                "Expected Graduation",
                formData.consulteeInlineEducation?.endYear?.toString(),
              )}
            </>
          )}
          {isProfessional && (
            <>
              {renderField(
                "Current Role",
                formData.consulteeInlineWorkExperience?.title,
              )}
              {renderField(
                "Company",
                formData.consulteeInlineWorkExperience?.company,
              )}
            </>
          )}
          {renderField("About Me", formData.aboutMe)}
        </div>,
        1,
      )}

      {(formData.goals || formData.preferredLanguage) &&
        renderSection(
          "Preferences",
          <div className="bg-muted/50 rounded-lg p-4">
            {renderField("Language", formData.preferredLanguage)}
            {formData.goals && renderField("Goals", formData.goals)}
          </div>,
          1,
        )}

      {/* Navigation */}
      <div className="flex gap-4 pt-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className="flex-1"
          disabled={isSubmitting}
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          className="flex-1"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Submitting...
            </>
          ) : (
            "Complete Registration"
          )}
        </Button>
      </div>
    </div>
  );
};

export default ConsulteeReviewForm;
