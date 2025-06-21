import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ConsulteeProfile,
  ConsulteePreferences,
  PersonalInfoAndRole,
} from "@/schemas/user";

type OnboardingFormData = PersonalInfoAndRole &
  Partial<ConsulteeProfile> &
  Partial<ConsulteePreferences> & {
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
    preferredCommunicationMethod: "VIDEO" | "AUDIO" | "IN_PERSON";
    interests?: string[];
    goals?: string[];
  };

interface Props {
  onSubmit: (data: OnboardingFormData) => void;
  onBack: () => void;
  formData: OnboardingFormData;
}

const ConsulteeAgreementForm: React.FC<Props> = ({
  onSubmit,
  onBack,
  formData,
}) => {
  const [termsAccepted, setTermsAccepted] = React.useState(
    formData.termsAccepted || false,
  );
  const [privacyAccepted, setPrivacyAccepted] = React.useState(
    formData.privacyAccepted || false,
  );

  const handleSubmit = () => {
    onSubmit({
      ...formData,
      termsAccepted,
      privacyAccepted,
      preferredCommunicationMethod:
        formData.preferredCommunicationMethod || "VIDEO",
    });
  };

  return (
    <div className="w-full space-y-6">
      <div className="glassmorphism2 rounded-2xl p-6 border border-white/20 shadow-2xl">
        <div className="mb-6">
          <h3 className="text-2xl font-bold text-white mb-2">Terms and Conditions</h3>
          <p className="text-white/70">Please review and accept our terms to continue</p>
        </div>
        <div className="space-y-4">
          <div className="space-y-4">
            <div className="flex items-center space-x-3 p-4 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors">
              <Checkbox
                id="terms"
                checked={termsAccepted}
                onCheckedChange={(checked) =>
                  setTermsAccepted(checked as boolean)
                }
                className="border-white/30 data-[state=checked]:bg-purple-500 data-[state=checked]:border-purple-500 h-5 w-5"
              />
              <label
                htmlFor="terms"
                className="text-sm text-white cursor-pointer font-medium"
              >
                I accept the{" "}
                <a href="/terms" target="_blank" className="text-purple-300 hover:text-purple-200 underline transition-colors">
                  terms and conditions
                </a>
              </label>
            </div>
            <div className="flex items-center space-x-3 p-4 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors">
              <Checkbox
                id="privacy"
                checked={privacyAccepted}
                onCheckedChange={(checked) =>
                  setPrivacyAccepted(checked as boolean)
                }
                className="border-white/30 data-[state=checked]:bg-purple-500 data-[state=checked]:border-purple-500 h-5 w-5"
              />
              <label
                htmlFor="privacy"
                className="text-sm text-white cursor-pointer font-medium"
              >
                I accept the{" "}
                <a href="/privacy" target="_blank" className="text-purple-300 hover:text-purple-200 underline transition-colors">
                  privacy policy
                </a>
              </label>
            </div>
          </div>
        </div>
      </div>
      <div className="flex justify-between gap-4">
        <Button 
          type="button" 
          onClick={onBack} 
          className="flex-1 h-12 bg-white/10 border-white/20 text-white hover:bg-white/20 hover:border-white/30 rounded-lg font-medium transition-all duration-200"
        >
          ← Back
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={!termsAccepted || !privacyAccepted}
          className="flex-1 h-12 bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold rounded-lg shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 transition-all duration-200 border-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Complete Onboarding ✓
        </Button>
      </div>
    </div>
  );
};

export default ConsulteeAgreementForm;
