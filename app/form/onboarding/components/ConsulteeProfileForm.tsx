import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConsulteeProfile } from "@/schemas/user";
import { Textarea } from "@/components/ui/textarea";
import { ConsulteeProfileFormSchema } from "@/utils/onboarding";
import { z } from "zod";
import { useThemeClasses } from "../useTheme";

interface Props {
  onNext: (data: Partial<ConsulteeProfile>) => void;
  onBack: () => void;
  initialData: Partial<ConsulteeProfile>;
}

const ConsulteeProfileForm: React.FC<Props> = ({ onNext, onBack, initialData }) => {
  const { classes, colors } = useThemeClasses();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof ConsulteeProfileFormSchema>>({
    resolver: zodResolver(ConsulteeProfileFormSchema),
    mode: "onChange",
    defaultValues: {
      education: "",
      occupation: "",
      aboutMe: "",
      preferredCommunicationMethod: "VIDEO",
      preferredLanguage: "English",
      specialRequirements: "",
      interests: [],
      goals: [],
      ...initialData,
    },
  });

  const onSubmit = (data: z.infer<typeof ConsulteeProfileFormSchema>) => {
    onNext(data as Partial<ConsulteeProfile>);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-full space-y-6">
      <div className="space-y-3">
        <Label
          htmlFor="education"
          className={`${colors.textPrimary} font-medium`}
        >
          Education
        </Label>
        <Input
          id="education"
          {...register("education")}
          className={classes.input}
          placeholder="Your educational background"
        />
        {errors.education && (
          <p className={`${colors.error} text-sm`}>
            {errors.education.message}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label
          htmlFor="occupation"
          className={`${colors.textPrimary} font-medium`}
        >
          Occupation
        </Label>
        <Input
          id="occupation"
          {...register("occupation")}
          className={classes.input}
          placeholder="Your current occupation"
        />
        {errors.occupation && (
          <p className={`${colors.error} text-sm`}>
            {errors.occupation.message}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label
          htmlFor="aboutMe"
          className={`${colors.textPrimary} font-medium`}
        >
          About Me
        </Label>
        <Textarea
          id="aboutMe"
          {...register("aboutMe")}
          className={classes.textarea}
          placeholder="Tell us about yourself"
          rows={4}
        />
        {errors.aboutMe && (
          <p className={`${colors.error} text-sm`}>
            {errors.aboutMe.message}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label
          htmlFor="preferredLanguage"
          className={`${colors.textPrimary} font-medium`}
        >
          Preferred Language
        </Label>
        <Input
          id="preferredLanguage"
          {...register("preferredLanguage")}
          className={classes.input}
          placeholder="Your preferred language"
        />
        {errors.preferredLanguage && (
          <p className={`${colors.error} text-sm`}>
            {errors.preferredLanguage.message}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label
          htmlFor="specialRequirements"
          className={`${colors.textPrimary} font-medium`}
        >
          Special Requirements
        </Label>
        <Textarea
          id="specialRequirements"
          {...register("specialRequirements")}
          className={classes.textarea}
          placeholder="Any special requirements or accommodations"
          rows={3}
        />
        {errors.specialRequirements && (
          <p className={`${colors.error} text-sm`}>
            {errors.specialRequirements.message}
          </p>
        )}
      </div>

      <div className="flex gap-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className={`${classes.secondaryButton} flex-1`}
        >
          Back
        </Button>
        <Button
          type="submit"
          className={`${classes.primaryButton} flex-1`}
        >
          Next
        </Button>
      </div>
    </form>
  );
};

export default ConsulteeProfileForm;