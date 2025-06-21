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
          className="flex-1 h-12 bg-white/10 border-white/20 text-white hover:bg-white/20 hover:border-white/30 rounded-lg font-medium transition-all duration-200"
        >
          ← Back
        </Button>
        <Button
          type="submit"
          disabled={!termsChecked || !privacyChecked}
          className="flex-1 h-12 bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold rounded-lg shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 transition-all duration-200 border-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next Step →
        </Button>
      </div>
    </form>
  );
};

export default ConsultantAgreementForm;
