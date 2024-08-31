import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { ConsulteeProfile, ConsulteePreferences, PersonalInfoAndRole } from "@/schemas/UserSchema";

interface Props {
  onSubmit: (data: ConsulteeProfile & ConsulteePreferences & PersonalInfoAndRole) => void;
  onBack: () => void;
  formData: ConsulteeProfile & ConsulteePreferences & PersonalInfoAndRole;
}

const ConsulteeReviewForm: React.FC<Props> = ({ onSubmit, onBack, formData }) => {
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
            <p>Phone: {formData.phone}</p>
            <p>Address: {formData.address}</p>
          </div>
          <div>
            <h3 className="font-semibold">Consultee Profile</h3>
            <p>Education: {formData.education}</p>
            <p>Occupation: {formData.occupation}</p>
            <p>About Me: {formData.aboutMe}</p>
          </div>
          <div>
            <h3 className="font-semibold">Preferences</h3>
            <p>Preferred Communication Method: {formData.preferredCommunicationMethod}</p>
            <p>Preferred Language: {formData.preferredLanguage}</p>
            <p>Special Requirements: {formData.specialRequirements}</p>
            <h3 className="font-semibold">Interests</h3>
            <ul>
              {formData.interests?.map((interest, index) => (
                <li key={index}>
                  <p>Name: {interest.name}</p>
                  <p>Skills: {interest.skills}</p>
                </li>
              ))}
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