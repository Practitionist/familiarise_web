import { Button } from "@/components/ui/button";

import { StaffProfile, PersonalInfoAndRole } from "@/schemas/user";
import React, { useState } from "react";
import { Loader2, Pencil } from "lucide-react";

interface Props {
  onSubmit: (data: Partial<PersonalInfoAndRole & StaffProfile>) => void;
  onBack: () => void;
  formData: Partial<PersonalInfoAndRole> &
    Partial<StaffProfile> & {
      termsAccepted?: boolean;
      privacyAccepted?: boolean;
    };
  onGoToStep?: (step: number) => void;
}

const StaffReviewForm: React.FC<Props> = ({
  onSubmit,
  onBack,
  formData,
  onGoToStep,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const onSubmitForm = () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    onSubmit(formData);
  };

  const renderEditButton = (step: number, title: string) =>
    onGoToStep ? (
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => onGoToStep(step)}
        title={`Edit ${title}`}
      >
        <Pencil className="w-3.5 h-3.5" />
      </Button>
    ) : null;

  return (
    <div className="space-y-6">
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="flex items-center justify-between border-b pb-2">
            <h3 className="font-semibold text-lg">Personal Information</h3>
            {renderEditButton(0, "Personal Information")}
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <p className="text-muted-foreground">Name:</p>
            <p>{formData.name}</p>
            <p className="text-muted-foreground">Email:</p>
            <p>{formData.email}</p>
            {formData.phone && (
              <>
                <p className="text-muted-foreground">Phone:</p>
                <p>{formData.phone}</p>
              </>
            )}
            {formData.address && (
              <>
                <p className="text-muted-foreground">Address:</p>
                <p>{formData.address}</p>
              </>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between border-b pb-2">
            <h3 className="font-semibold text-lg">Staff Profile</h3>
            {renderEditButton(1, "Staff Profile")}
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <p className="text-muted-foreground">Department:</p>
            <p>{formData.department}</p>
            <p className="text-muted-foreground">Position:</p>
            <p>{formData.position}</p>
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="font-semibold text-lg border-b pb-2">Agreements</h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <p className="text-muted-foreground">Terms of Service:</p>
            <p>{formData.termsAccepted ? "Accepted" : "Not accepted"}</p>
            <p className="text-muted-foreground">Privacy Policy:</p>
            <p>{formData.privacyAccepted ? "Accepted" : "Not accepted"}</p>
          </div>
        </div>
      </div>

      <div className="flex justify-between">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          disabled={isSubmitting}
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={onSubmitForm}
          disabled={
            !formData.termsAccepted ||
            !formData.privacyAccepted ||
            isSubmitting
          }
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Submitting...
            </>
          ) : (
            "Complete Registration"
          )}
        </Button>
      </div>
    </div>
  );
};

export default StaffReviewForm;
