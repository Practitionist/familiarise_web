import React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useThemeClasses } from "../useTheme";

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
  const { classes, colors } = useThemeClasses();
  return (
    <div
      className={`flex items-center space-x-3 p-4 rounded-lg ${colors.glassBg} ${colors.glassBorder} hover:${colors.secondaryBg} transition-colors`}
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className={`${classes.checkbox} h-5 w-5`}
      />
      <Label
        htmlFor={id}
        className={`text-sm ${colors.textPrimary} cursor-pointer`}
      >
        I agree to the{" "}
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className={`${colors.linkColor} ${colors.linkHover} underline transition-colors`}
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
