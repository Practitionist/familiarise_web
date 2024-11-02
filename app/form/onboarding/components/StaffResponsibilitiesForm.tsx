import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { responsibilitiesAndPermissions } from "@/schemas/ResponsibilitiesAndPermissionsSchema";
import { StaffProfile, PersonalInfoAndRole } from "@/schemas/UserSchema";
import React, { useEffect, useState } from "react";
import { useFormContext } from "react-hook-form";

interface Props {
  onNext: (data: any) => void;
  onBack: () => void;
  initialData: Partial<StaffProfile & PersonalInfoAndRole>;
}

const StaffResponsibilitiesForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const [department, setDepartment] = useState<string | null>(null);
  const [position, setPosition] = useState<string | null>(null);

  const {
    setValue,
    watch,
    formState: { errors },
  } = useFormContext();

  const responsibilities = watch("responsibilities", {});
  const permissions = watch("permissions", {});

  useEffect(() => {
    if (initialData.department && initialData.position) {
      setDepartment(initialData.department);
      setPosition(initialData.position);
    }
  }, [initialData]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate that at least one responsibility and permission is selected
    if (Object.keys(responsibilities).length === 0) {
      setValue("responsibilities", {}, { shouldValidate: true });
      return;
    }
    if (Object.keys(permissions).length === 0) {
      setValue("permissions", {}, { shouldValidate: true });
      return;
    }

    onNext({
      responsibilities,
      permissions,
      department: department || "",
      position: position || "",
    });
  };

  if (!department || !position) {
    return (
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <p className="text-center text-gray-600">
            Please complete the Staff Profile form first.
          </p>
        </CardContent>
      </Card>
    );
  }

  const departmentData = responsibilitiesAndPermissions.departments[department];
  const positionData = departmentData?.positions[position];

  if (!departmentData || !positionData) {
    return (
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <p className="text-center text-gray-600">
            Invalid department or position. Please go back and select valid
            options.
          </p>
        </CardContent>
      </Card>
    );
  }

  const handleResponsibilityChange = (item: string, checked: boolean) => {
    const newResponsibilities = { ...responsibilities };
    if (checked) {
      newResponsibilities[item] = true;
    } else {
      delete newResponsibilities[item];
    }
    setValue("responsibilities", newResponsibilities, { shouldValidate: true });
  };

  const handlePermissionChange = (item: string, checked: boolean) => {
    const newPermissions = { ...permissions };
    if (checked) {
      newPermissions[item] = true;
    } else {
      delete newPermissions[item];
    }
    setValue("permissions", newPermissions, { shouldValidate: true });
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Staff Responsibilities</CardTitle>
        <CardDescription>
          Select your responsibilities and permissions
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="responsibilities">
              <AccordionTrigger>Responsibilities</AccordionTrigger>
              <AccordionContent>
                <div className="space-y-4">
                  {Object.entries(positionData.responsibilities).map(
                    ([category, items]) => (
                      <div key={category} className="space-y-2">
                        <Label className="font-semibold">{category}</Label>
                        {items.map((item, index) => (
                          <div
                            key={index}
                            className="flex items-center space-x-2"
                          >
                            <Checkbox
                              id={`responsibility-${category}-${index}`}
                              checked={!!responsibilities[item]}
                              onCheckedChange={(checked) =>
                                handleResponsibilityChange(
                                  item,
                                  checked as boolean,
                                )
                              }
                            />
                            <Label
                              htmlFor={`responsibility-${category}-${index}`}
                              className="text-sm"
                            >
                              {item}
                            </Label>
                          </div>
                        ))}
                      </div>
                    ),
                  )}
                </div>
                {errors.responsibilities && (
                  <p className="text-red-500 text-sm mt-2">
                    Please select at least one responsibility
                  </p>
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="permissions">
              <AccordionTrigger>Permissions</AccordionTrigger>
              <AccordionContent>
                <div className="space-y-4">
                  {Object.entries(positionData.permissions).map(
                    ([category, items]) => (
                      <div key={category} className="space-y-2">
                        <Label className="font-semibold">{category}</Label>
                        {items.map((item, index) => (
                          <div
                            key={index}
                            className="flex items-center space-x-2"
                          >
                            <Checkbox
                              id={`permission-${category}-${index}`}
                              checked={!!permissions[item]}
                              onCheckedChange={(checked) =>
                                handlePermissionChange(item, checked as boolean)
                              }
                            />
                            <Label
                              htmlFor={`permission-${category}-${index}`}
                              className="text-sm"
                            >
                              {item}
                            </Label>
                          </div>
                        ))}
                      </div>
                    ),
                  )}
                </div>
                {errors.permissions && (
                  <p className="text-red-500 text-sm mt-2">
                    Please select at least one permission
                  </p>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </form>
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="submit" variant="night" onClick={handleSubmit}>
          Next
        </Button>
      </CardFooter>
    </Card>
  );
};

export default StaffResponsibilitiesForm;
