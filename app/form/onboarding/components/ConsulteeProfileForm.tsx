import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConsulteeProfile, ConsulteeProfileSchema } from "@/schemas/user";
import { Textarea } from "@/components/ui/textarea";
import { useThemeClasses } from "../useTheme";

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
  const { classes, colors } = useThemeClasses();
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
      className="w-full space-y-6"
    >
      <div className="space-y-3">
        <Label htmlFor="education" className={`${colors.textPrimary} font-medium`}>Education</Label>
        <Input 
          id="education" 
          {...register("education")} 
          className={classes.input}
          placeholder="Your educational background"
        />
        {errors.education && (
          <p className={`${colors.error} text-sm`}>{errors.education.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="occupation" className={`${colors.textPrimary} font-medium`}>Occupation</Label>
        <Input 
          id="occupation" 
          {...register("occupation")} 
          className={classes.input}
          placeholder="Your current occupation"
        />
        {errors.occupation && (
          <p className={`${colors.error} text-sm`}>{errors.occupation.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="aboutMe" className={`${colors.textPrimary} font-medium`}>About Me</Label>
        <Textarea 
          id="aboutMe" 
          {...register("aboutMe")} 
          className={classes.textarea}
          placeholder="Tell us about yourself, your interests, and goals..."
        />
        {errors.aboutMe && (
          <p className={`${colors.error} text-sm`}>{errors.aboutMe.message}</p>
        )}
      </div>

      <div className="flex justify-between gap-4 pt-6">
        <Button 
          type="button" 
          onClick={onBack} 
          className={`flex-1 h-12 ${classes.secondaryButton}`}
        >
          ← Back
        </Button>
        <Button 
          type="submit" 
          disabled={isSubmitting}
          className={`flex-1 h-12 ${classes.primaryButton} disabled:opacity-50`}
        >
          {isSubmitting ? "Processing..." : "Next Step →"}
        </Button>
      </div>
    </form>
  );
};

export default ConsulteeProfileForm;
