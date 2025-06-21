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
import { Controller, useFormContext } from "react-hook-form";
import { useThemeClasses } from "../useTheme";

interface Props {
  onNext: (data: any) => void;
  onBack: () => void;
  initialData: Partial<StaffProfile & PersonalInfoAndRole>;
}

const StaffProfileForm: React.FC<Props> = ({ onNext, onBack, initialData }) => {
  const { classes, colors } = useThemeClasses();
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

  const onSubmit = (data: Partial<StaffProfile>) => {
    // Initialize empty responsibilities and permissions objects
    onNext({
      ...data,
      responsibilities: {},
      permissions: {},
    });
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full space-y-6"
    >
      <div className="space-y-3">
        <Label htmlFor="department" className={`${colors.textPrimary} font-medium`}>Department</Label>
        <Controller
          name="department"
          control={control}
          rules={{ required: "Department is required" }}
          render={({ field }) => (
            <Select onValueChange={field.onChange} value={field.value}>
              <SelectTrigger className={`${colors.inputBg} ${colors.inputBorder} ${colors.textPrimary} h-12 rounded-lg ${colors.inputFocus}`}>
                <SelectValue placeholder="Select a department" className={colors.textSecondary} />
              </SelectTrigger>
              <SelectContent className={`${colors.glassBg} ${colors.glassBorder}`}>
                {departments.map((department) => (
                  <SelectItem key={department} value={department} className={`${colors.textPrimary} focus:${colors.secondaryBg}`}>
                    {department}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.department && (
          <p className={`${colors.error} text-sm`}>
            {errors.department.message as string}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="position" className={`${colors.textPrimary} font-medium`}>Position</Label>
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
              <SelectTrigger className={`${colors.inputBg} ${colors.inputBorder} ${colors.textPrimary} h-12 rounded-lg ${colors.inputFocus} ${!watchDepartment ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <SelectValue placeholder={!watchDepartment ? "Select a department first" : "Select a position"} className={colors.textSecondary} />
              </SelectTrigger>
              <SelectContent className={`${colors.glassBg} ${colors.glassBorder}`}>
                {positions.map((position) => (
                  <SelectItem key={position} value={position} className={`${colors.textPrimary} focus:${colors.secondaryBg}`}>
                    {position}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.position && (
          <p className={`${colors.error} text-sm`}>
            {errors.position.message as string}
          </p>
        )}
      </div>

      <div className="flex justify-between gap-4 pt-6">
        <Button 
          type="button" 
          onClick={onBack} 
          className={`flex-1 h-12 ${classes.secondaryButton}`}
        >
          ← Back
        </Button>
        <Button 
          type="submit" 
          className={`flex-1 h-12 ${classes.primaryButton}`}
        >
          Next Step →
        </Button>
      </div>
    </form>
  );
};

export default StaffProfileForm;
