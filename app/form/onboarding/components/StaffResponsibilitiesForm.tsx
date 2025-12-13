import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { responsibilitiesAndPermissions } from "@/schemas/responsibbilities-permissions";
import { StaffProfile, PersonalInfoAndRole } from "@/schemas/user";
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
      <div className="bg-muted/50 rounded-lg p-6 text-center">
        <p className="text-muted-foreground">
          Please complete the Staff Profile form first.
        </p>
      </div>
    );
  }

  const departmentData = responsibilitiesAndPermissions.departments[department];
  const positionData = departmentData?.positions[position];

  if (!departmentData || !positionData) {
    return (
      <div className="bg-destructive/10 rounded-lg p-6 text-center">
        <p className="text-destructive">
          Invalid department or position. Please go back and select valid options.
        </p>
      </div>
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
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Responsibilities & Permissions
        </h3>
        <p className="text-sm text-muted-foreground">
          Select your responsibilities and permissions for the {position} role in {department}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Accordion type="single" collapsible className="w-full">
          <AccordionItem value="responsibilities" className="border rounded-lg">
            <AccordionTrigger className="px-4 font-medium hover:no-underline">
              Responsibilities
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="space-y-4">
                {Object.entries(positionData.responsibilities).map(
                  ([category, items]) => (
                    <div
                      key={category}
                      className="space-y-3 p-3 rounded-lg bg-muted/50"
                    >
                      <Label className="font-semibold text-sm">{category}</Label>
                      {items.map((item, index) => (
                        <div
                          key={index}
                          className="flex items-center space-x-3 p-2 rounded-lg hover:bg-muted transition-colors"
                        >
                          <Checkbox
                            id={`responsibility-${category}-${index}`}
                            checked={!!responsibilities[item]}
                            onCheckedChange={(checked) =>
                              handleResponsibilityChange(item, checked as boolean)
                            }
                          />
                          <Label
                            htmlFor={`responsibility-${category}-${index}`}
                            className="text-sm cursor-pointer"
                          >
                            {item}
                          </Label>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
              {errors.responsibilities && (
                <p className="text-destructive text-sm mt-2">
                  Please select at least one responsibility
                </p>
              )}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="permissions" className="border rounded-lg mt-4">
            <AccordionTrigger className="px-4 font-medium hover:no-underline">
              Permissions
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="space-y-4">
                {Object.entries(positionData.permissions).map(
                  ([category, items]) => (
                    <div
                      key={category}
                      className="space-y-3 p-3 rounded-lg bg-muted/50"
                    >
                      <Label className="font-semibold text-sm">{category}</Label>
                      {items.map((item, index) => (
                        <div
                          key={index}
                          className="flex items-center space-x-3 p-2 rounded-lg hover:bg-muted transition-colors"
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
                            className="text-sm cursor-pointer"
                          >
                            {item}
                          </Label>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
              {errors.permissions && (
                <p className="text-destructive text-sm mt-2">
                  Please select at least one permission
                </p>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        {/* Navigation */}
        <div className="flex gap-4 pt-4">
          <Button
            type="button"
            onClick={onBack}
            variant="outline"
            className="flex-1"
          >
            Back
          </Button>
          <Button type="submit" className="flex-1">
            Continue
          </Button>
        </div>
      </form>
    </div>
  );
};

export default StaffResponsibilitiesForm;
