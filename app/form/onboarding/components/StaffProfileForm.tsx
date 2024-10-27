import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { responsibilitiesAndPermissions } from "@/schemas/ResponsibilitiesAndPermissionsSchema";
import { StaffProfile, PersonalInfoAndRole } from "@/schemas/UserSchema";
import React, { useEffect, useState } from "react";
import { Controller, useFormContext } from "react-hook-form";

interface Props {
  onNext: (data: any) => void;
  onBack: () => void;
  initialData: Partial<StaffProfile & PersonalInfoAndRole>;
}

const StaffProfileForm: React.FC<Props> = ({ onNext, onBack, initialData }) => {
  const [departments, setDepartments] = useState<string[]>([]);
  const [positions, setPositions] = useState<string[]>([]);

  const {
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext();

  const watchDepartment = watch("department");

  useEffect(() => {
    // Initialize departments from the schema
    setDepartments(Object.keys(responsibilitiesAndPermissions.departments));

    // Initialize with initial data if available
    if (initialData.department) {
      setValue("department", initialData.department);
      if (initialData.position) {
        setValue("position", initialData.position);
      }
    }
  }, [initialData, setValue]);

  useEffect(() => {
    if (watchDepartment) {
      // Update available positions when department changes
      const departmentData = responsibilitiesAndPermissions.departments[watchDepartment];
      if (departmentData) {
        setPositions(Object.keys(departmentData.positions));
      } else {
        setPositions([]);
      }
    } else {
      setPositions([]);
    }
  }, [watchDepartment]);

  const onSubmit = (data: Partial<StaffProfile>) => {
    // Initialize empty responsibilities and permissions objects
    onNext({
      ...data,
      responsibilities: {},
      permissions: {},
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-full max-w-md space-y-4">
      <div className="space-y-2">
        <Label htmlFor="department">Department</Label>
        <Controller
          name="department"
          control={control}
          rules={{ required: "Department is required" }}
          render={({ field }) => (
            <Select
              onValueChange={field.onChange}
              value={field.value}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a department" />
              </SelectTrigger>
              <SelectContent className="bg-slate-100">
                {departments.map((department) => (
                  <SelectItem key={department} value={department}>
                    {department}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.department && (
          <p className="text-red-500 text-sm">{errors.department.message as string}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="position">Position</Label>
        <Controller
          name="position"
          control={control}
          rules={{ required: "Position is required" }}
          render={({ field }) => (
            <Select
              onValueChange={field.onChange}
              value={field.value}
              disabled={!watchDepartment}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a position" />
              </SelectTrigger>
              <SelectContent className="bg-slate-100">
                {positions.map((position) => (
                  <SelectItem key={position} value={position}>
                    {position}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.position && (
          <p className="text-red-500 text-sm">{errors.position.message as string}</p>
        )}
      </div>

      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="submit" variant="night">
          Next
        </Button>
      </div>
    </form>
  );
};

export default StaffProfileForm;
