import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { responsibilitiesAndPermissions } from "@/schemas/ResponsibilitiesAndPermissionsSchema";
import { StaffProfile, StaffProfileSchema } from "@/schemas/UserSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import React, { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";

interface Props {
  onNext: (data: Partial<StaffProfile>) => void;
  onBack: () => void;
  initialData: Partial<StaffProfile>;
}

const StaffProfileForm: React.FC<Props> = ({ onNext, onBack, initialData }) => {
  const [departments, setDepartments] = useState<string[]>([]);
  const [positions, setPositions] = useState<string[]>([]);

  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<StaffProfile>({
    resolver: zodResolver(StaffProfileSchema),
    defaultValues: initialData,
  });

  const watchDepartment = watch("department");

  useEffect(() => {
    setDepartments(Object.keys(responsibilitiesAndPermissions.departments));
  }, []);

  useEffect(() => {
    if (watchDepartment) {
      setPositions(Object.keys(responsibilitiesAndPermissions.departments[watchDepartment].positions));
    }
  }, [watchDepartment]);

  const onSubmit = (data: StaffProfile) => {
    onNext(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-full max-w-md space-y-4">
      <div className="space-y-2">
        <Label htmlFor="department">Department</Label>
        <Controller
          name="department"
          control={control}
          render={({ field }) => (
            <Select onValueChange={field.onChange} value={field.value}>
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
          <p className="text-red-500">{errors.department.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="position">Position</Label>
        <Controller
          name="position"
          control={control}
          render={({ field }) => (
            <Select onValueChange={field.onChange} value={field.value} disabled={!watchDepartment}>
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
          <p className="text-red-500">{errors.position.message}</p>
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