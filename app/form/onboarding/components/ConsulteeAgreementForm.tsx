import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import TermsAndPrivacyAgreement from "./TermsAndPrivacyAgreement";
import { ConsulteeProfile, PersonalInfoAndRole } from "@/schemas/UserSchema";

interface Props {
  onSubmit: (data: FormData) => void;
  onBack: () => void;
  formData: FormData;
}

type FormData = PersonalInfoAndRole & 
  Partial<ConsulteeProfile> & {
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
  };

const ConsulteeAgreementForm: React.FC<Props> = ({ onSubmit, onBack, formData }) => {
  const [termsChecked, setTermsChecked] = useState(formData.termsAccepted || false);
  const [privacyChecked, setPrivacyChecked] = useState(formData.privacyAccepted || false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (termsChecked && privacyChecked) {
      onSubmit({
        ...formData,
        termsAccepted: true,
        privacyAccepted: true,
        preferredCommunicationMethod: formData.preferredCommunicationMethod || "VIDEO",
      });
    } else {
      alert("Please accept both the Terms of Service and Privacy Policy to continue.");
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
        <Button type="submit" variant="night" disabled={!termsChecked || !privacyChecked}>
          Submit
        </Button>
      </div>
    </form>
  );
};

export default ConsulteeAgreementForm;
