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
  <div className="flex items-center space-x-3 p-4 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors">
    <Checkbox
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      className="border-white/30 data-[state=checked]:bg-purple-500 data-[state=checked]:border-purple-500 h-5 w-5"
    />
    <Label htmlFor={id} className="text-sm text-white cursor-pointer">
      I agree to the{" "}
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className="text-purple-300 hover:text-purple-200 underline transition-colors"
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
