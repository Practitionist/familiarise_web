import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConsulteeProfile } from "@/schemas/user";
import { Textarea } from "@/components/ui/textarea";
import { ConsulteeProfileFormSchema } from "@/utils/onboarding";
import { z } from "zod";

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
  } = useForm<z.infer<typeof ConsulteeProfileFormSchema>>({
    resolver: zodResolver(ConsulteeProfileFormSchema),
    mode: "onChange",
    defaultValues: {
      education: initialData.education || "",
      occupation: initialData.occupation || "",
      aboutMe: initialData.aboutMe || "",
      preferredCommunicationMethod: initialData.preferredCommunicationMethod || "VIDEO",
      preferredLanguage: initialData.preferredLanguage || "",
      specialRequirements: initialData.specialRequirements || "",
      interests: initialData.interests || [],
      goals: initialData.goals || [],
    },
  });

  const onSubmit = (data: z.infer<typeof ConsulteeProfileFormSchema>) => {
    onNext(data as Partial<ConsulteeProfile>);
  };

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Consultee profile</CardTitle>
        <CardDescription>Help us tailor recommendations and match you with the right expert.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="education">Education</Label>
              <Input id="education" placeholder="e.g., B.Tech in CS" {...register("education")} />
              {errors.education && (
                <p className="text-sm text-destructive">{errors.education.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="occupation">Occupation</Label>
              <Input id="occupation" placeholder="e.g., Founder at Acme" {...register("occupation")} />
              {errors.occupation && (
                <p className="text-sm text-destructive">{errors.occupation.message}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="aboutMe">About me</Label>
            <Textarea id="aboutMe" placeholder="What are you building or learning? What kind of help would be most useful right now?" {...register("aboutMe")} />
            {errors.aboutMe && (
              <p className="text-sm text-destructive">{errors.aboutMe.message}</p>
            )}
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button type="button" onClick={onBack} variant="outline">
              Back
            </Button>
            <Button type="submit" variant="night" disabled={isSubmitting}>
              {isSubmitting ? "Submitting..." : "Next"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
};

export default ConsulteeProfileForm;
