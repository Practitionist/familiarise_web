import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import React from "react";

interface Props {
  onTermsChange: (checked: boolean) => void;
  onPrivacyChange: (checked: boolean) => void;
  termsChecked: boolean;
  privacyChecked: boolean;
}

const TermsAndPrivacyAgreement: React.FC<Props> = ({
  onTermsChange,
  onPrivacyChange,
  termsChecked,
  privacyChecked,
}) => {
  return (
    <div className="space-y-4">
      <div className="flex items-center space-x-2">
        <Checkbox
          id="terms"
          checked={termsChecked}
          onCheckedChange={onTermsChange}
        />
        <Label htmlFor="terms">
          I agree to the <a href="/terms" className="text-blue-600 hover:underline">Terms of Service</a>
        </Label>
      </div>
      <div className="flex items-center space-x-2">
        <Checkbox
          id="privacy"
          checked={privacyChecked}
          onCheckedChange={onPrivacyChange}
        />
        <Label htmlFor="privacy">
          I agree to the <a href="/privacy" className="text-blue-600 hover:underline">Privacy Policy</a>
        </Label>
      </div>
    </div>
  );
};

export default TermsAndPrivacyAgreement;