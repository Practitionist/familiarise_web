import React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface AgreementProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  link: string;
}

const Agreement: React.FC<AgreementProps> = ({
  id,
  checked,
  onCheckedChange,
  label,
  link,
}) => (
  <div className="flex items-center space-x-2">
    <Checkbox
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      className="h-4 w-4 border-2 border-gray-300 rounded text-blue-600 focus:ring-blue-500"
    />
    <Label htmlFor={id} className="text-sm text-gray-700">
      I agree to the{" "}
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:underline"
      >
        {label}
      </a>
    </Label>
  </div>
);

interface TermsAndPrivacyAgreementProps {
  onTermsChange: (checked: boolean) => void;
  onPrivacyChange: (checked: boolean) => void;
  termsChecked: boolean;
  privacyChecked: boolean;
}

const TermsAndPrivacyAgreement: React.FC<TermsAndPrivacyAgreementProps> = ({
  onTermsChange,
  onPrivacyChange,
  termsChecked,
  privacyChecked,
}) => (
  <div className="space-y-4">
    <Agreement
      id="terms"
      checked={termsChecked}
      onCheckedChange={onTermsChange}
      label="Terms of Service"
      link="/terms"
    />
    <Agreement
      id="privacy"
      checked={privacyChecked}
      onCheckedChange={onPrivacyChange}
      label="Privacy Policy"
      link="/privacy"
    />
  </div>
);

export default TermsAndPrivacyAgreement;
