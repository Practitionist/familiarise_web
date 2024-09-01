import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { responsibilitiesAndPermissions } from "@/schemas/ResponsibilitiesAndPermissionsSchema";
import { StaffResponsibilities, StaffResponsibilitiesSchema } from "@/schemas/UserSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import React, { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";

interface Props {
  onNext: (data: Partial<StaffResponsibilities>) => void;
  onBack: () => void;
  initialData: Partial<StaffResponsibilities> & {
    department?: string;
    position?: string;
  };
}

const StaffResponsibilitiesForm: React.FC<Props> = ({ onNext, onBack, initialData }) => {
  const [department, setDepartment] = useState<string | null>(null);
  const [position, setPosition] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<StaffResponsibilities>({
    resolver: zodResolver(StaffResponsibilitiesSchema),
    defaultValues: initialData,
  });

  useEffect(() => {
    if (initialData.department && initialData.position) {
      setDepartment(initialData.department);
      setPosition(initialData.position);
    }
  }, [initialData]);

  const onSubmit = (data: StaffResponsibilities) => {
    onNext(data);
  };

  if (!department || !position) {
    return (
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <p className="text-center text-gray-600">Please complete the Staff Profile form first.</p>
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
          <p className="text-center text-gray-600">Invalid department or position. Please go back and select valid options.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Staff Responsibilities</CardTitle>
        <CardDescription>Select your responsibilities and permissions</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="responsibilities">
              <AccordionTrigger>Responsibilities</AccordionTrigger>
              <AccordionContent>
                <Controller
                  name="responsibilities"
                  control={control}
                  render={({ field }) => (
                    <div className="space-y-4">
                      {Object.entries(positionData.responsibilities).map(([category, items]) => (
                        <div key={category} className="space-y-2">
                          <Label className="font-semibold">{category}</Label>
                          {items.map((item, index) => (
                            <div key={index} className="flex items-center space-x-2">
                              <Checkbox
                                id={`responsibility-${category}-${index}`}
                                checked={Array.isArray(field.value) && field.value.includes(item)}
                                onCheckedChange={(checked) => {
                                  const updatedValue = Array.isArray(field.value)
                                    ? checked
                                      ? [...field.value, item]
                                      : field.value.filter((i) => i !== item)
                                    : checked ? [item] : [];
                                  field.onChange(updatedValue);
                                }}
                              />
                              <Label htmlFor={`responsibility-${category}-${index}`} className="text-sm">{item}</Label>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                />
                {errors.responsibilities && (
                  <p className="text-red-500 text-sm mt-2">{errors.responsibilities.message}</p>
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="permissions">
              <AccordionTrigger>Permissions</AccordionTrigger>
              <AccordionContent>
                <Controller
                  name="permissions"
                  control={control}
                  render={({ field }) => (
                    <div className="space-y-4">
                      {Object.entries(positionData.permissions).map(([category, items]) => (
                        <div key={category} className="space-y-2">
                          <Label className="font-semibold">{category}</Label>
                          {items.map((item, index) => (
                            <div key={index} className="flex items-center space-x-2">
                              <Checkbox
                                id={`permission-${category}-${index}`}
                                checked={Array.isArray(field.value) && field.value.includes(item)}
                                onCheckedChange={(checked) => {
                                  const updatedValue = Array.isArray(field.value)
                                    ? checked
                                      ? [...field.value, item]
                                      : field.value.filter((i) => i !== item)
                                    : checked ? [item] : [];
                                  field.onChange(updatedValue);
                                }}
                              />
                              <Label htmlFor={`permission-${category}-${index}`} className="text-sm">{item}</Label>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                />
                {errors.permissions && (
                  <p className="text-red-500 text-sm mt-2">{errors.permissions.message}</p>
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
        <Button type="submit" variant="night" onClick={handleSubmit(onSubmit)}>
          Next
        </Button>
      </CardFooter>
    </Card>
  );
};

export default StaffResponsibilitiesForm;