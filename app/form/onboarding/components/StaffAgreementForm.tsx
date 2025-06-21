import React from "react";
import { Button } from "@/components/ui/button";
import { StaffProfile, PersonalInfoAndRole } from "@/schemas/user";
import { useFormContext } from "react-hook-form";
import TermsAndPrivacyAgreement from "./TermsAndPrivacyAgreement";

interface Props {
  onNext: (data: any) => void;
  onBack: () => void;
  initialData: Partial<
    StaffProfile &
      PersonalInfoAndRole & {
        termsAccepted?: boolean;
        privacyAccepted?: boolean;
      }
  >;
}

const StaffAgreementForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const {
    setValue,
    watch,
    handleSubmit,
    formState: { errors },
  } = useFormContext();

  const termsAccepted = watch("termsAccepted", initialData.termsAccepted);
  const privacyAccepted = watch("privacyAccepted", initialData.privacyAccepted);

  const onSubmit = (data: any) => {
    if (!termsAccepted || !privacyAccepted) {
      return;
    }
    onNext({
      ...data,
      termsAccepted: true,
      privacyAccepted: true,
    });
  };

  const handleTermsChange = (checked: boolean) => {
    setValue("termsAccepted", checked, { shouldValidate: true });
  };

  const handlePrivacyChange = (checked: boolean) => {
    setValue("privacyAccepted", checked, { shouldValidate: true });
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full space-y-6"
    >
      <TermsAndPrivacyAgreement
        onTermsChange={handleTermsChange}
        onPrivacyChange={handlePrivacyChange}
        termsChecked={termsAccepted || false}
        privacyChecked={privacyAccepted || false}
      />
      {(errors.termsAccepted || errors.privacyAccepted) && (
        <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          Please accept both the Terms of Service and Privacy Policy to
          continue.
        </p>
      )}
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
          disabled={!termsAccepted || !privacyAccepted}
          className="flex-1 h-12 bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold rounded-lg shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 transition-all duration-200 border-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next Step →
        </Button>
      </div>
    </form>
  );
};

export default StaffAgreementForm;
