import React from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PersonalInfoAndRole } from "@/schemas/user";
import { PersonalInfoAndRoleFormSchema } from "@/utils/onboarding";
import { useSession } from "next-auth/react";
import { z } from "zod";
import { useThemeClasses } from "../useTheme";

interface Props {
  onNext: (data: PersonalInfoAndRole) => void;
  initialData: Partial<PersonalInfoAndRole>;
}

const PersonalInfoAndRoleForm: React.FC<Props> = ({ onNext, initialData }) => {
  const { data: session } = useSession();
  const { classes, colors } = useThemeClasses();
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<z.infer<typeof PersonalInfoAndRoleFormSchema>>({
    resolver: zodResolver(PersonalInfoAndRoleFormSchema),
    mode: "onChange",
    defaultValues: {
      name: "",
      email: session?.user?.email || "",
      onlineStatus: false,
      onboardingCompleted: false,
      role: "CONSULTEE",
      ...initialData,
    },
  });

  const onSubmit = (data: z.infer<typeof PersonalInfoAndRoleFormSchema>) => {
    // Ensure email from session is used
    const submissionData = {
      ...data,
      email: session?.user?.email || "",
    };
    onNext(submissionData as PersonalInfoAndRole);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-full space-y-6">
      <div className="space-y-3">
        <Label htmlFor="name" className={`${colors.textPrimary} font-medium`}>
          Full Name
        </Label>
        <Input
          id="name"
          {...register("name")}
          className={classes.input}
          placeholder="Enter your full name"
        />
        {errors.name && (
          <p className={`${colors.error} text-sm`}>{errors.name.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label htmlFor="email" className={`${colors.textPrimary} font-medium`}>
          Email
        </Label>
        <Input
          id="email"
          type="email"
          value={session?.user?.email || ""}
          disabled
          className={`${classes.input} opacity-70`}
        />
      </div>

      <div className="space-y-3">
        <Label htmlFor="phone" className={`${colors.textPrimary} font-medium`}>
          Phone
        </Label>
        <Input
          id="phone"
          {...register("phone")}
          className={classes.input}
          placeholder="Enter your phone number"
        />
        {errors.phone && (
          <p className={`${colors.error} text-sm`}>{errors.phone.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label
          htmlFor="address"
          className={`${colors.textPrimary} font-medium`}
        >
          Address
        </Label>
        <Input
          id="address"
          {...register("address")}
          className={classes.input}
          placeholder="Enter your address"
        />
        {errors.address && (
          <p className={`${colors.error} text-sm`}>{errors.address.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label className={`${colors.textPrimary} font-medium`}>Role</Label>
        <Controller
          name="role"
          control={control}
          render={({ field }) => (
            <div className="flex flex-col space-y-2">
              {["CONSULTANT", "CONSULTEE", "STAFF"].map((role) => (
                <Button
                  key={role}
                  type="button"
                  onClick={() => field.onChange(role)}
                  variant={field.value === role ? "default" : "outline"}
                  className={
                    field.value === role
                      ? classes.primaryButton
                      : classes.secondaryButton
                  }
                >
                  {role.charAt(0).toUpperCase() + role.slice(1).toLowerCase()}
                </Button>
              ))}
            </div>
          )}
        />
        {errors.role && (
          <p className={`${colors.error} text-sm`}>{errors.role.message}</p>
        )}
      </div>

      <Button type="submit" className={`${classes.primaryButton} w-full`}>
        Next
      </Button>
    </form>
  );
};

export default PersonalInfoAndRoleForm;
