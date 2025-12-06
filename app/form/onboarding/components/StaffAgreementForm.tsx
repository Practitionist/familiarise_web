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
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Terms and Conditions
        </h3>
        <p className="text-sm text-muted-foreground">
          Please review and accept our terms to continue
        </p>
        <TermsAndPrivacyAgreement
          onTermsChange={handleTermsChange}
          onPrivacyChange={handlePrivacyChange}
          termsChecked={termsAccepted || false}
          privacyChecked={privacyAccepted || false}
        />
      </div>

      {(errors.termsAccepted || errors.privacyAccepted) && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-lg p-3">
          Please accept both the Terms of Service and Privacy Policy to
          continue.
        </p>
      )}

      <div className="flex gap-4 pt-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className="flex-1"
        >
          Back
        </Button>
        <Button
          type="submit"
          disabled={!termsAccepted || !privacyAccepted}
          className="flex-1"
        >
          Continue
        </Button>
      </div>
    </form>
  );
};

export default StaffAgreementForm;
