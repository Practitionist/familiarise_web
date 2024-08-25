import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  onSubmit: (data: any) => void;
  onBack: () => void;
  formData: any;
}

const StaffReviewForm: React.FC<Props> = ({ onSubmit, onBack, formData }) => {
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
            <h3 className="font-semibold">Staff Profile</h3>
            <p>Department: {formData.department}</p>
            <p>Position: {formData.position}</p>
          </div>
          <div>
            <h3 className="font-semibold">Responsibilities</h3>
            {/* Add staff responsibilities here once they are defined in the StaffResponsibilitiesForm */}
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

export default StaffReviewForm;