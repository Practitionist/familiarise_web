import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StaffProfile, PersonalInfoAndRole } from "@/schemas/UserSchema";
import { responsibilitiesAndPermissions } from "@/schemas/ResponsibilitiesAndPermissionsSchema";
import React from "react";
import { useFormContext } from "react-hook-form";

interface Props {
  onSubmit: (data: any) => void;  // Match parent component's type
  onBack: () => void;
  formData: PersonalInfoAndRole & Partial<StaffProfile> & {
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
  };
}

const StaffReviewForm: React.FC<Props> = ({ onSubmit, onBack, formData }) => {
  const { handleSubmit } = useFormContext();

  const getResponsibilitiesList = () => {
    if (!formData.department || !formData.position || !formData.responsibilities) return [];
    
    const departmentData = responsibilitiesAndPermissions.departments[formData.department];
    const positionData = departmentData?.positions[formData.position];
    if (!positionData) return [];

    const selectedResponsibilities: string[] = [];
    Object.entries(positionData.responsibilities).forEach(([category, items]) => {
      items.forEach(item => {
        if (formData.responsibilities?.[item]) {
          selectedResponsibilities.push(`${category}: ${item}`);
        }
      });
    });
    return selectedResponsibilities;
  };

  const getPermissionsList = () => {
    if (!formData.department || !formData.position || !formData.permissions) return [];
    
    const departmentData = responsibilitiesAndPermissions.departments[formData.department];
    const positionData = departmentData?.positions[formData.position];
    if (!positionData) return [];

    const selectedPermissions: string[] = [];
    Object.entries(positionData.permissions).forEach(([category, items]) => {
      items.forEach(item => {
        if (formData.permissions?.[item]) {
          selectedPermissions.push(`${category}: ${item}`);
        }
      });
    });
    return selectedPermissions;
  };

  const onSubmitForm = (data: any) => {
    onSubmit({
      ...formData,
      ...data,
      termsAccepted: formData.termsAccepted || false,
      privacyAccepted: formData.privacyAccepted || false,
    });
  };

  const responsibilitiesList = getResponsibilitiesList();
  const permissionsList = getPermissionsList();

  return (
    <div className="w-full max-w-md space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Review Your Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <h3 className="font-semibold text-lg">Personal Information</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <p className="text-muted-foreground">Name:</p>
              <p>{formData.name}</p>
              <p className="text-muted-foreground">Email:</p>
              <p>{formData.email}</p>
              {formData.phone && (
                <>
                  <p className="text-muted-foreground">Phone:</p>
                  <p>{formData.phone}</p>
                </>
              )}
              {formData.address && (
                <>
                  <p className="text-muted-foreground">Address:</p>
                  <p>{formData.address}</p>
                </>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold text-lg">Staff Profile</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <p className="text-muted-foreground">Department:</p>
              <p>{formData.department}</p>
              <p className="text-muted-foreground">Position:</p>
              <p>{formData.position}</p>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="font-semibold text-lg">Responsibilities and Permissions</h3>
            
            <div className="space-y-2">
              <h4 className="font-medium">Responsibilities:</h4>
              <ul className="list-disc list-inside text-sm space-y-1">
                {responsibilitiesList.map((responsibility, index) => (
                  <li key={index} className="text-muted-foreground">{responsibility}</li>
                ))}
              </ul>
            </div>

            <div className="space-y-2">
              <h4 className="font-medium">Permissions:</h4>
              <ul className="list-disc list-inside text-sm space-y-1">
                {permissionsList.map((permission, index) => (
                  <li key={index} className="text-muted-foreground">{permission}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold text-lg">Agreements</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <p className="text-muted-foreground">Terms of Service:</p>
              <p>{formData.termsAccepted ? "Accepted" : "Not accepted"}</p>
              <p className="text-muted-foreground">Privacy Policy:</p>
              <p>{formData.privacyAccepted ? "Accepted" : "Not accepted"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button 
          type="button" 
          onClick={handleSubmit(onSubmitForm)} 
          variant="night"
          disabled={!formData.termsAccepted || !formData.privacyAccepted}
        >
          Submit
        </Button>
      </div>
    </div>
  );
};

export default StaffReviewForm;
