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
}) => {
  return (
    <div className="flex items-center space-x-3 p-4 rounded-lg bg-muted/50 border hover:bg-muted transition-colors">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="h-5 w-5"
      />
      <Label htmlFor={id} className="text-sm cursor-pointer">
        I agree to the{" "}
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline transition-colors"
        >
          {label}
        </a>
      </Label>
    </div>
  );
};

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
