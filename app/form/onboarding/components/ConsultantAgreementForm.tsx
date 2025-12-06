import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import TermsAndPrivacyAgreement from "./TermsAndPrivacyAgreement";

interface Props {
  onNext: (
    data: Partial<{ termsAccepted: boolean; privacyAccepted: boolean }>,
  ) => void;
  onBack: () => void;
  initialData: Partial<{ termsAccepted: boolean; privacyAccepted: boolean }>;
}

const ConsultantAgreementForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const [termsChecked, setTermsChecked] = useState(
    initialData.termsAccepted || false,
  );
  const [privacyChecked, setPrivacyChecked] = useState(
    initialData.privacyAccepted || false,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (termsChecked && privacyChecked) {
      onNext({ termsAccepted: true, privacyAccepted: true });
    }
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
          onTermsChange={setTermsChecked}
          onPrivacyChange={setPrivacyChecked}
          termsChecked={termsChecked}
          privacyChecked={privacyChecked}
        />
        {(!termsChecked || !privacyChecked) && (
          <p className="text-sm text-muted-foreground">
            You must accept both agreements to continue.
          </p>
        )}
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
          disabled={!termsChecked || !privacyChecked}
          className="flex-1"
        >
          Continue
        </Button>
      </div>
    </form>
  );
};

export default ConsultantAgreementForm;
