import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConsulteeProfile, ConsulteeProfileSchema } from "@/schemas/user";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  onNext: (data: Partial<ConsulteeProfile>) => void;
  onBack: () => void;
  initialData: Partial<ConsulteeProfile>;
}

const ConsulteeProfileForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ConsulteeProfile>({
    resolver: zodResolver(ConsulteeProfileSchema),
    defaultValues: initialData,
  });

  const onSubmit = (data: ConsulteeProfile) => {
    onNext(data);
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full max-w-md space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="education">Education</Label>
        <Input id="education" {...register("education")} />
        {errors.education && (
          <p className="text-red-500">{errors.education.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="occupation">Occupation</Label>
        <Input id="occupation" {...register("occupation")} />
        {errors.occupation && (
          <p className="text-red-500">{errors.occupation.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="aboutMe">About Me</Label>
        <Textarea id="aboutMe" {...register("aboutMe")} />
        {errors.aboutMe && (
          <p className="text-red-500">{errors.aboutMe.message}</p>
        )}
      </div>

      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="submit" variant="night" disabled={isSubmitting}>
          {isSubmitting ? "Submitting..." : "Next"}
        </Button>
      </div>
    </form>
  );
};

export default ConsulteeProfileForm;
