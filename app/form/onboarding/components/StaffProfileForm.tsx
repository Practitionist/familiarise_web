import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { responsibilitiesAndPermissions } from "@/schemas/responsibbilities-permissions";
import { StaffProfile, PersonalInfoAndRole } from "@/schemas/user";
import React, { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";

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
  } = useForm<StaffProfile & PersonalInfoAndRole>({
    defaultValues: {
      department: initialData.department || "",
      position: initialData.position || "",
    },
  });

  const watchDepartment = watch("department");

  useEffect(() => {
    // Initialize departments from the schema
    setDepartments(Object.keys(responsibilitiesAndPermissions.departments));
  }, []);

  useEffect(() => {
    if (watchDepartment) {
      // Update available positions when department changes
      const departmentData =
        responsibilitiesAndPermissions.departments[watchDepartment];
      if (departmentData) {
        setPositions(Object.keys(departmentData.positions));
      } else {
        setPositions([]);
      }
    } else {
      setPositions([]);
    }
  }, [watchDepartment]);

  const onSubmit = (data: any) => {
    // Initialize empty responsibilities and permissions objects
    onNext({
      department: data.department,
      position: data.position,
      responsibilities: {},
      permissions: {},
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Staff Role Details
        </h3>

        <div className="space-y-2">
          <Label htmlFor="department">
            Department <span className="text-destructive">*</span>
          </Label>
          <Controller
            name="department"
            control={control}
            rules={{ required: "Department is required" }}
            render={({ field }) => (
              <Select onValueChange={field.onChange} value={field.value}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a department" />
                </SelectTrigger>
                <SelectContent>
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
            <p className="text-sm text-destructive">
              {errors.department.message as string}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="position">
            Position <span className="text-destructive">*</span>
          </Label>
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
                <SelectTrigger
                  className={
                    !watchDepartment ? "opacity-50 cursor-not-allowed" : ""
                  }
                >
                  <SelectValue
                    placeholder={
                      !watchDepartment
                        ? "Select a department first"
                        : "Select a position"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
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
            <p className="text-sm text-destructive">
              {errors.position.message as string}
            </p>
          )}
        </div>
      </div>

      {/* Help text */}
      {watchDepartment && (
        <div className="bg-muted/50 rounded-lg p-4 text-sm text-muted-foreground">
          <p>
            After selecting your department and position, you'll be able to
            choose your specific responsibilities and permissions in the next
            step.
          </p>
        </div>
      )}

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
  );
};

export default StaffProfileForm;
