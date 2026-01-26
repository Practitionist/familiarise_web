import React from "react";
import { Button } from "@/components/ui/button";
import { StaffProfile, PersonalInfoAndRole } from "@/schemas/user";

import TermsAndPrivacyAgreement from "./TermsAndPrivacyAgreement";

interface Props {
  onNext: (data: any) => void;
  onBack: () => void;
  initialData: Partial<
    StaffProfile &
    PersonalInfoAndRole & {
      termsAccepted?: boolean;
      privacyAccepted?: boolean;
    }
  >;
}

const StaffAgreementForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const [termsAccepted, setTermsAccepted] = React.useState(
    initialData.termsAccepted || false,
  );
  const [privacyAccepted, setPrivacyAccepted] = React.useState(
    initialData.privacyAccepted || false,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!termsAccepted || !privacyAccepted) {
      return;
    }
    // Only pass the fields this form is responsible for
    onNext({
      termsAccepted: true,
      privacyAccepted: true,
    });
  };

  const handleTermsChange = (checked: boolean) => {
    setTermsAccepted(checked);
  };

  const handlePrivacyChange = (checked: boolean) => {
    setPrivacyAccepted(checked);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Terms and Conditions
        </h3>
        <p className="text-sm text-muted-foreground">
          Please review and accept our terms to continue
        </p>
        <TermsAndPrivacyAgreement
          onTermsChange={handleTermsChange}
          onPrivacyChange={handlePrivacyChange}
          termsChecked={termsAccepted}
          privacyChecked={privacyAccepted}
        />
      </div>

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
          type="submit"
          disabled={!termsAccepted || !privacyAccepted}
          className="flex-1"
        >
          Continue
        </Button>
      </div>
    </form>
  );
};

export default StaffAgreementForm;
