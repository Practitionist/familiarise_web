import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Pencil } from "lucide-react";
import {
  ConsulteeProfile,
  ConsulteePreferences,
  PersonalInfoAndRole,
} from "@/schemas/user";

type ConsulteeFormData = Partial<PersonalInfoAndRole> &
  Partial<ConsulteeProfile> &
  Partial<ConsulteePreferences> & {
    interests?: string[];
    goals?: string;
  };

interface Props {
  onSubmit: (data: ConsulteeFormData) => void;
  onBack: () => void;
  formData: ConsulteeFormData;
  onGoToStep?: (step: number) => void;
}

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
          {renderField("Occupation", formData.occupation)}
          {renderField("Company", formData.currentCompany)}
          {renderField("Industry", formData.industry)}
          {renderField("Career Stage", formData.careerStage?.replace("_", " "))}
          {renderField("About Me", formData.aboutMe)}
        </div>,
        1,
      )}

      {renderSection(
        "Preferences",
        <div className="bg-muted/50 rounded-lg p-4">
          {renderField("Language", formData.preferredLanguage)}
        </div>,
        1,
      )}

      {(formData.interests?.length || formData.goals) &&
        renderSection(
          "Interests & Goals",
          <div className="bg-muted/50 rounded-lg p-4 space-y-4">
            {formData.interests && formData.interests.length > 0 && (
              <div>
                <p className="text-sm text-muted-foreground mb-2">Interests</p>
                <div className="flex flex-wrap gap-2">
                  {formData.interests.map((interest, index) => (
                    <span
                      key={index}
                      className="px-2 py-1 bg-primary/10 text-primary rounded text-sm"
                    >
                      {interest}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {formData.goals && (
              <div>
                <p className="text-sm text-muted-foreground mb-2">Goals</p>
                <p className="text-sm">{formData.goals}</p>
              </div>
            )}
          </div>,
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
