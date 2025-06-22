import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ConsulteeProfile,
  ConsulteePreferences,
  PersonalInfoAndRole,
} from "@/schemas/user";
import { useThemeClasses } from "../useTheme";

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
  const { classes, colors } = useThemeClasses();
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
      <div
        className={`glassmorphism2 rounded-2xl p-6 ${colors.glassBorder} shadow-2xl`}
      >
        <div className="mb-6">
          <h3 className={`text-2xl font-bold ${colors.textPrimary} mb-2`}>
            Terms and Conditions
          </h3>
          <p className={colors.textSecondary}>
            Please review and accept our terms to continue
          </p>
        </div>
        <div className="space-y-4">
          <div className="space-y-4">
            <div
              className={`flex items-center space-x-3 p-4 rounded-lg ${colors.glassBg} ${colors.glassBorder} hover:${colors.secondaryBg} transition-colors`}
            >
              <Checkbox
                id="terms"
                checked={termsAccepted}
                onCheckedChange={(checked) =>
                  setTermsAccepted(checked as boolean)
                }
                className={`${classes.checkbox} h-5 w-5`}
              />
              <label
                htmlFor="terms"
                className={`text-sm ${colors.textPrimary} cursor-pointer font-medium`}
              >
                I accept the{" "}
                <a
                  href="/terms"
                  target="_blank"
                  className={`${colors.linkColor} ${colors.linkHover} underline transition-colors`}
                >
                  terms and conditions
                </a>
              </label>
            </div>
            <div
              className={`flex items-center space-x-3 p-4 rounded-lg ${colors.glassBg} ${colors.glassBorder} hover:${colors.secondaryBg} transition-colors`}
            >
              <Checkbox
                id="privacy"
                checked={privacyAccepted}
                onCheckedChange={(checked) =>
                  setPrivacyAccepted(checked as boolean)
                }
                className={`${classes.checkbox} h-5 w-5`}
              />
              <label
                htmlFor="privacy"
                className={`text-sm ${colors.textPrimary} cursor-pointer font-medium`}
              >
                I accept the{" "}
                <a
                  href="/privacy"
                  target="_blank"
                  className={`${colors.linkColor} ${colors.linkHover} underline transition-colors`}
                >
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
          className={`flex-1 h-12 ${classes.secondaryButton}`}
        >
          ← Back
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={!termsAccepted || !privacyAccepted}
          className={`flex-1 h-12 ${classes.primaryButton} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          Complete Onboarding ✓
        </Button>
      </div>
    </div>
  );
};

export default ConsulteeAgreementForm;
