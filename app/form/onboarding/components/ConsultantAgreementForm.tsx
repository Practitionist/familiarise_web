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
    } else {
      alert(
        "Please accept both the Terms of Service and Privacy Policy to continue.",
      );
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-md space-y-4">
      <TermsAndPrivacyAgreement
        onTermsChange={setTermsChecked}
        onPrivacyChange={setPrivacyChecked}
        termsChecked={termsChecked}
        privacyChecked={privacyChecked}
      />
      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button
          type="submit"
          variant="night"
          disabled={!termsChecked || !privacyChecked}
        >
          Next
        </Button>
      </div>
    </form>
  );
};

export default ConsultantAgreementForm;
