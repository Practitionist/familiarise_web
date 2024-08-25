import React from "react";
import { Button } from "@/components/ui/button";

interface Props {
  onSubmit: (data: any) => void;
  onBack: () => void;
  initialData: any;
}

const StaffReviewForm: React.FC<Props> = ({ onSubmit, onBack, initialData }) => {
  const handleSubmit = () => {
    onSubmit(initialData);
  };

  return (
    <div className="w-full max-w-md space-y-4">
      {/* Display review information */}
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