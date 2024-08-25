import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  onSubmit: (data: any) => void;
  onBack: () => void;
  formData: any;
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
            <p>Location: {formData.location}</p>
          </div>
          <div>
            <h3 className="font-semibold">Preferences</h3>
            <p>Preferred Communication Method: {formData.preferredCommunicationMethod}</p>
            <p>Preferred Language: {formData.preferredLanguage}</p>
            <p>Special Requirements: {formData.specialRequirements}</p>
            <h4>Domains of Interest:</h4>
            <ul>
              {formData.domains?.map((domain: any, index: number) => (
                <li key={index}>
                  {domain.name} - Subdomains: {domain.subdomains?.join(", ")}
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