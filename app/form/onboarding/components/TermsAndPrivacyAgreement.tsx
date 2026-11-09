import React from "react";
import { DataProtectionNotice } from "@/components/compliance/DataProtectionNotice";
import { SignupConsentCheckboxes } from "@/components/compliance/SignupConsentCheckboxes";

interface TermsAndPrivacyAgreementProps {
  onTermsChange: (checked: boolean) => void;
  onPrivacyChange: (checked: boolean) => void;
  onMarketingChange: (checked: boolean) => void;
  termsChecked: boolean;
  privacyChecked: boolean;
  /** Optional marketing-emails consent, recorded with the onboarding submit. */
  marketingChecked: boolean;
}

const TermsAndPrivacyAgreement: React.FC<TermsAndPrivacyAgreementProps> = ({
  onTermsChange,
  onPrivacyChange,
  onMarketingChange,
  termsChecked,
  privacyChecked,
  marketingChecked,
}) => (
  <div className="space-y-4">
    <DataProtectionNotice audience="consultant" />
    <SignupConsentCheckboxes
      termsChecked={termsChecked}
      privacyChecked={privacyChecked}
      marketingChecked={marketingChecked}
      onTermsChange={onTermsChange}
      onPrivacyChange={onPrivacyChange}
      onMarketingChange={onMarketingChange}
    />
  </div>
);

export default TermsAndPrivacyAgreement;
