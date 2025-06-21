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
      <div className="glassmorphism2 rounded-2xl p-6 border border-white/20 shadow-2xl w-full">
        <p className="text-center text-white">
          Please complete the Staff Profile form first.
        </p>
      </div>
    );
  }

  const departmentData = responsibilitiesAndPermissions.departments[department];
  const positionData = departmentData?.positions[position];

  if (!departmentData || !positionData) {
    return (
      <div className="glassmorphism2 rounded-2xl p-6 border border-white/20 shadow-2xl w-full">
        <p className="text-center text-white">
          Invalid department or position. Please go back and select valid
          options.
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
    <div className="glassmorphism2 rounded-2xl p-6 border border-white/20 shadow-2xl w-full space-y-6">
      <div>
        <h3 className="text-2xl font-bold text-white mb-2">Staff Responsibilities</h3>
        <p className="text-white/70">
          Select your responsibilities and permissions
        </p>
      </div>
      <div>
        <form onSubmit={handleSubmit} className="space-y-6">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="responsibilities" className="border-white/20">
              <AccordionTrigger className="text-white font-medium hover:text-purple-300 transition-colors">
                📼 Responsibilities
              </AccordionTrigger>
              <AccordionContent className="pb-4">
                <div className="space-y-4">
                  {Object.entries(positionData.responsibilities).map(
                    ([category, items]) => (
                      <div key={category} className="space-y-3 p-3 rounded-lg bg-white/5 border border-white/10">
                        <Label className="font-semibold text-white text-sm">{category}</Label>
                        {items.map((item, index) => (
                          <div
                            key={index}
                            className="flex items-center space-x-3 p-2 rounded-lg hover:bg-white/5 transition-colors"
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
                              className="border-white/30 data-[state=checked]:bg-purple-500 data-[state=checked]:border-purple-500"
                            />
                            <Label
                              htmlFor={`responsibility-${category}-${index}`}
                              className="text-sm text-white cursor-pointer"
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
                  <p className="text-red-400 text-sm mt-2">
                    Please select at least one responsibility
                  </p>
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="permissions" className="border-white/20">
              <AccordionTrigger className="text-white font-medium hover:text-purple-300 transition-colors">
                🔐 Permissions
              </AccordionTrigger>
              <AccordionContent className="pb-4">
                <div className="space-y-4">
                  {Object.entries(positionData.permissions).map(
                    ([category, items]) => (
                      <div key={category} className="space-y-3 p-3 rounded-lg bg-white/5 border border-white/10">
                        <Label className="font-semibold text-white text-sm">{category}</Label>
                        {items.map((item, index) => (
                          <div
                            key={index}
                            className="flex items-center space-x-3 p-2 rounded-lg hover:bg-white/5 transition-colors"
                          >
                            <Checkbox
                              id={`permission-${category}-${index}`}
                              checked={!!permissions[item]}
                              onCheckedChange={(checked) =>
                                handlePermissionChange(item, checked as boolean)
                              }
                              className="border-white/30 data-[state=checked]:bg-purple-500 data-[state=checked]:border-purple-500"
                            />
                            <Label
                              htmlFor={`permission-${category}-${index}`}
                              className="text-sm text-white cursor-pointer"
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
                  <p className="text-red-400 text-sm mt-2">
                    Please select at least one permission
                  </p>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </form>
      </div>
      <div className="flex justify-between gap-4 pt-6 border-t border-white/20">
        <Button 
          type="button" 
          onClick={onBack} 
          className="flex-1 h-12 bg-white/10 border-white/20 text-white hover:bg-white/20 hover:border-white/30 rounded-lg font-medium transition-all duration-200"
        >
          ← Back
        </Button>
        <Button 
          type="submit" 
          onClick={handleSubmit}
          className="flex-1 h-12 bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold rounded-lg shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 transition-all duration-200 border-0"
        >
          Next Step →
        </Button>
      </div>
    </div>
  );
};

export default StaffResponsibilitiesForm;
