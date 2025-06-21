import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import TermsAndPrivacyAgreement from "./TermsAndPrivacyAgreement";
import { useThemeClasses } from "../useTheme";

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
  const { classes } = useThemeClasses();
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
    <form onSubmit={handleSubmit} className="w-full space-y-6">
      <TermsAndPrivacyAgreement
        onTermsChange={setTermsChecked}
        onPrivacyChange={setPrivacyChecked}
        termsChecked={termsChecked}
        privacyChecked={privacyChecked}
      />
      <div className="flex justify-between gap-4 pt-6">
        <Button 
          type="button" 
          onClick={onBack} 
          className={`flex-1 h-12 ${classes.secondaryButton}`}
        >
          ← Back
        </Button>
        <Button
          type="submit"
          disabled={!termsChecked || !privacyChecked}
          className={`flex-1 h-12 ${classes.primaryButton} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          Next Step →
        </Button>
      </div>
    </form>
  );
};

export default ConsultantAgreementForm;
