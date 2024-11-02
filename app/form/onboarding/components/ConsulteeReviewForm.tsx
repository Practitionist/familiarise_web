import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ConsulteeProfile,
  ConsulteePreferences,
  PersonalInfoAndRole,
} from "@/schemas/UserSchema";

type OnboardingFormData = PersonalInfoAndRole &
  Partial<ConsulteeProfile> &
  Partial<ConsulteePreferences> & {
    preferredCommunicationMethod: "VIDEO" | "AUDIO" | "IN_PERSON";
    interests?: string[];
    goals?: string[];
  };

interface Props {
  onSubmit: (data: OnboardingFormData) => void;
  onBack: () => void;
  formData: OnboardingFormData;
}

const ConsulteeReviewForm: React.FC<Props> = ({
  onSubmit,
  onBack,
  formData,
}) => {
  const handleSubmit = () => {
    onSubmit(formData);
  };

  return (
    <div className="w-full max-w-md space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Review Your Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold">Personal Information</h3>
            <p>Name: {formData.name}</p>
            <p>Email: {formData.email}</p>
            <p>Phone: {formData.phone || "Not provided"}</p>
            <p>Address: {formData.address || "Not provided"}</p>
          </div>
          <div>
            <h3 className="font-semibold">Consultee Profile</h3>
            <p>Education: {formData.education || "Not provided"}</p>
            <p>Occupation: {formData.occupation || "Not provided"}</p>
            <p>About Me: {formData.aboutMe || "Not provided"}</p>
          </div>
          <div>
            <h3 className="font-semibold">Preferences</h3>
            <p>
              Preferred Communication Method:{" "}
              {formData.preferredCommunicationMethod}
            </p>
            <p>
              Preferred Language: {formData.preferredLanguage || "Not provided"}
            </p>
            <p>
              Special Requirements: {formData.specialRequirements || "None"}
            </p>
            <h3 className="font-semibold">Interests</h3>
            <ul className="list-disc pl-5">
              {formData.interests?.map((interest: string, index: number) => (
                <li key={index}>{interest}</li>
              ))}
              {(!formData.interests || formData.interests.length === 0) && (
                <li>No interests specified</li>
              )}
            </ul>
            <h3 className="font-semibold">Goals</h3>
            <ul className="list-disc pl-5">
              {formData.goals?.map((goal: string, index: number) => (
                <li key={index}>{goal}</li>
              ))}
              {(!formData.goals || formData.goals.length === 0) && (
                <li>No goals specified</li>
              )}
            </ul>
          </div>
        </CardContent>
      </Card>
      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="button" onClick={handleSubmit} variant="night">
          Submit
        </Button>
      </div>
    </div>
  );
};

export default ConsulteeReviewForm;
