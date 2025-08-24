import React from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PersonalInfoAndRole } from "@/schemas/user";
import { PersonalInfoAndRoleFormSchema } from "@/utils/onboarding";
import { useSession } from "next-auth/react";
import { z } from "zod";

interface Props {
  onNext: (data: PersonalInfoAndRole) => void;
  initialData: Partial<PersonalInfoAndRole>;
}

const PersonalInfoAndRoleForm: React.FC<Props> = ({ onNext, initialData }) => {
  const { data: session } = useSession();
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
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Personal details</CardTitle>
        <CardDescription>We’ll use this to personalize your onboarding.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Full name</Label>
              <Input id="name" placeholder="Your full name" {...register("name")} />
              {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={session?.user?.email || ""}
                disabled
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" placeholder="Optional" {...register("phone")} />
              {errors.phone && <p className="text-sm text-destructive">{errors.phone.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="address">Address</Label>
              <Input id="address" placeholder="City, Country" {...register("address")} />
              {errors.address && (
                <p className="text-sm text-destructive">{errors.address.message}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Role</Label>
            <Controller
              name="role"
              control={control}
              render={({ field }) => (
                <div className="bg-muted p-1 rounded-lg grid grid-cols-3 gap-1">
                  {["CONSULTEE", "CONSULTANT", "STAFF"].map((role) => (
                    <Button
                      key={role}
                      type="button"
                      size="sm"
                      variant={field.value === role ? "night" : "outline"}
                      onClick={() => field.onChange(role)}
                      className="w-full"
                    >
                      {role.charAt(0) + role.slice(1).toLowerCase()}
                    </Button>
                  ))}
                </div>
              )}
            />
            {errors.role && <p className="text-sm text-destructive">{errors.role.message}</p>}
          </div>

          <Button type="submit" variant="night" className="w-full">
            Next
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

export default PersonalInfoAndRoleForm;
