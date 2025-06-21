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
      className="w-full space-y-6"
    >
      <div className="space-y-3">
        <Label htmlFor="education" className="text-white font-medium">Education</Label>
        <Input 
          id="education" 
          {...register("education")} 
          className="bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-purple-400 focus:ring-purple-400/20 backdrop-blur-sm h-12 rounded-lg"
          placeholder="Your educational background"
        />
        {errors.education && (
          <p className="text-red-400 text-sm">{errors.education.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="occupation" className="text-white font-medium">Occupation</Label>
        <Input 
          id="occupation" 
          {...register("occupation")} 
          className="bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-purple-400 focus:ring-purple-400/20 backdrop-blur-sm h-12 rounded-lg"
          placeholder="Your current occupation"
        />
        {errors.occupation && (
          <p className="text-red-400 text-sm">{errors.occupation.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="aboutMe" className="text-white font-medium">About Me</Label>
        <Textarea 
          id="aboutMe" 
          {...register("aboutMe")} 
          className="bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-purple-400 focus:ring-purple-400/20 backdrop-blur-sm rounded-lg min-h-[120px] resize-none"
          placeholder="Tell us about yourself, your interests, and goals..."
        />
        {errors.aboutMe && (
          <p className="text-red-400 text-sm">{errors.aboutMe.message}</p>
        )}
      </div>

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
          disabled={isSubmitting}
          className="flex-1 h-12 bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold rounded-lg shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 transition-all duration-200 border-0 disabled:opacity-50"
        >
          {isSubmitting ? "Processing..." : "Next Step →"}
        </Button>
      </div>
    </form>
  );
};

export default ConsulteeProfileForm;
