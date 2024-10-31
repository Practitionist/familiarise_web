import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConsulteeProfile, ConsulteePreferences, PersonalInfoAndRole } from "@/schemas/UserSchema";

type OnboardingFormData = PersonalInfoAndRole &
  Partial<ConsulteeProfile> &
  Partial<ConsulteePreferences> & {
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
    preferredCommunicationMethod: "VIDEO" | "AUDIO" | "IN_PERSON";
    interests?: string[];
    goals?: string[];
  };

interface Props {
  onSubmit: (data: OnboardingFormData) => void;
  onBack: () => void;
  formData: OnboardingFormData;
}

const ConsulteeAgreementForm: React.FC<Props> = ({ onSubmit, onBack, formData }) => {
  const [termsAccepted, setTermsAccepted] = React.useState(formData.termsAccepted || false);
  const [privacyAccepted, setPrivacyAccepted] = React.useState(formData.privacyAccepted || false);

  const handleSubmit = () => {
    onSubmit({
      ...formData,
      termsAccepted,
      privacyAccepted,
      preferredCommunicationMethod: formData.preferredCommunicationMethod || "VIDEO",
    });
  };

  return (
    <div className="w-full max-w-md space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Terms and Conditions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-4">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="terms"
                checked={termsAccepted}
                onCheckedChange={(checked) => setTermsAccepted(checked as boolean)}
              />
              <label
                htmlFor="terms"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                I accept the terms and conditions
              </label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="privacy"
                checked={privacyAccepted}
                onCheckedChange={(checked) => setPrivacyAccepted(checked as boolean)}
              />
              <label
                htmlFor="privacy"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                I accept the privacy policy
              </label>
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          variant="night"
          disabled={!termsAccepted || !privacyAccepted}
        >
          Submit
        </Button>
      </div>
    </div>
  );
};

export default ConsulteeAgreementForm;
