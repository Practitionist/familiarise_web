import { Button } from "@/components/ui/button";
import { StaffResponsibilities, staffResponsibilitiesSchema } from "@/schemas/UserSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import React from "react";
import { useForm } from "react-hook-form";

interface Props {
  onNext: (data: Partial<StaffResponsibilities>) => void;
  onBack: () => void;
  initialData: Partial<StaffResponsibilities>;
}

const StaffResponsibilitiesForm: React.FC<Props> = ({ onNext, onBack, initialData }) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<StaffResponsibilities>({
    resolver: zodResolver(staffResponsibilitiesSchema),
    defaultValues: initialData,
  });

  const onSubmit = (data: StaffResponsibilities) => {
    onNext(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-full max-w-md space-y-4">
      {/* Add form fields for staff responsibilities */}
      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="submit" variant="night">
          Next
        </Button>
      </div>
    </form>
  );
};

export default StaffResponsibilitiesForm;