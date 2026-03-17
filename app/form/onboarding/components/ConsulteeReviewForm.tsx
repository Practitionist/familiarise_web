import React from "react";
import { Button } from "@/components/ui/button";
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
}

const ConsulteeReviewForm: React.FC<Props> = ({
  onSubmit,
  onBack,
  formData,
}) => {
  const handleSubmit = () => {
    onSubmit(formData);
  };

  const renderSection = (title: string, content: React.ReactNode) => (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        {title}
      </h3>
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
      )}

      {renderSection(
        "Preferences",
        <div className="bg-muted/50 rounded-lg p-4">
          {renderField("Language", formData.preferredLanguage)}
        </div>,
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
        >
          Back
        </Button>
        <Button type="button" onClick={handleSubmit} className="flex-1">
          Complete Registration
        </Button>
      </div>
    </div>
  );
};

export default ConsulteeReviewForm;
