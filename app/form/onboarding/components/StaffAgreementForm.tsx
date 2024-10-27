import React from "react";
import { Button } from "@/components/ui/button";
import { StaffProfile, PersonalInfoAndRole } from "@/schemas/UserSchema";
import { useFormContext } from "react-hook-form";
import TermsAndPrivacyAgreement from "./TermsAndPrivacyAgreement";

interface Props {
  onNext: (data: any) => void;
  onBack: () => void;
  initialData: Partial<StaffProfile & PersonalInfoAndRole & {
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
  }>;
}

const StaffAgreementForm: React.FC<Props> = ({ onNext, onBack, initialData }) => {
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
    <form onSubmit={handleSubmit(onSubmit)} className="w-full max-w-md space-y-4">
      <TermsAndPrivacyAgreement
        onTermsChange={handleTermsChange}
        onPrivacyChange={handlePrivacyChange}
        termsChecked={termsAccepted || false}
        privacyChecked={privacyAccepted || false}
      />
      {(errors.termsAccepted || errors.privacyAccepted) && (
        <p className="text-red-500 text-sm">
          Please accept both the Terms of Service and Privacy Policy to continue.
        </p>
      )}
      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button 
          type="submit" 
          variant="night" 
          disabled={!termsAccepted || !privacyAccepted}
        >
          Next
        </Button>
      </div>
    </form>
  );
};

export default StaffAgreementForm;
