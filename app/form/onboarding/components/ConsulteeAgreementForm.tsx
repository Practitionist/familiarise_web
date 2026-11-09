import React from "react";
import { Button } from "@/components/ui/button";
import {
  ConsulteeProfile,
  ConsulteePreferences,
  PersonalInfoAndRole,
} from "@/schemas/user";
import { DataProtectionNotice } from "@/components/compliance/DataProtectionNotice";
import { SignupConsentCheckboxes } from "@/components/compliance/SignupConsentCheckboxes";

type ConsulteeFormData = Partial<PersonalInfoAndRole> &
  Partial<ConsulteeProfile> &
  Partial<ConsulteePreferences> & {
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
    marketingConsent?: boolean;
    interests?: string[];
    goals?: string;
  };

interface Props {
  onNext: (data: ConsulteeFormData) => void;
  onBack: () => void;
  formData: ConsulteeFormData;
  /** A final submit is in flight (consultee path). */
  isSubmitting?: boolean;
}

const ConsulteeAgreementForm: React.FC<Props> = ({
  onNext,
  onBack,
  formData,
  isSubmitting = false,
}) => {
  const [termsAccepted, setTermsAccepted] = React.useState(
    formData.termsAccepted || false,
  );
  const [privacyAccepted, setPrivacyAccepted] = React.useState(
    formData.privacyAccepted || false,
  );
  // Recorded server-side with the completion, never before it.
  const [marketingAccepted, setMarketingAccepted] = React.useState(
    formData.marketingConsent || false,
  );

  const handleSubmit = () => {
    if (isSubmitting) return;
    onNext({
      ...formData,
      termsAccepted,
      privacyAccepted,
      marketingConsent: marketingAccepted,
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Terms and privacy
        </h3>
        <p className="text-sm text-muted-foreground">
          Please review how we use your information and accept our terms to
          complete your registration
        </p>
      </div>

      <DataProtectionNotice audience="consultee" />

      <div className="space-y-4">
        <SignupConsentCheckboxes
          termsChecked={termsAccepted}
          privacyChecked={privacyAccepted}
          marketingChecked={marketingAccepted}
          onTermsChange={setTermsAccepted}
          onPrivacyChange={setPrivacyAccepted}
          onMarketingChange={setMarketingAccepted}
        />
        {(!termsAccepted || !privacyAccepted) && (
          <p className="text-sm text-muted-foreground">
            Accept both required agreements to complete your registration.
          </p>
        )}
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
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting || !termsAccepted || !privacyAccepted}
          className="flex-1"
        >
          {isSubmitting ? "Completing…" : "Complete Registration"}
        </Button>
      </div>
    </div>
  );
};

export default ConsulteeAgreementForm;
