import React from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { z } from "zod";
import { PersonalInfoAndRole, PersonalInfoAndRoleSchema } from "@/schemas/user";

// Define the input type for the form, using z.input
type PersonalInfoAndRoleFormInput = z.input<typeof PersonalInfoAndRoleSchema>;
import { useSession } from "next-auth/react";

interface Props {
  onNext: (data: PersonalInfoAndRole) => void;
  initialData: Partial<PersonalInfoAndRole>;
}

const PersonalInfoAndRoleForm: React.FC<Props> = ({ onNext, initialData }) => {
  const { data: session } = useSession();

  // Prepare defaultValues ensuring they strictly conform to PersonalInfoAndRole
  // Prepare defaultValues ensuring they strictly conform to PersonalInfoAndRoleFormInput
  const prepareDefaultValues = (): PersonalInfoAndRoleFormInput => {
    const baseValues = {
      ...initialData,
      email: session?.user?.email || initialData.email,
    };

    const parseResult = PersonalInfoAndRoleSchema.safeParse(baseValues);

    if (parseResult.success) {
      // Ensure session email overrides if it exists and is different from parsed email
      if (session?.user?.email && session.user.email !== parseResult.data.email) {
        return { ...parseResult.data, email: session.user.email };
      }
      return parseResult.data; // This has Zod defaults applied
    } else {
      console.error(
        "[PersonalInfoAndRoleForm] Failed to parse initialData with schema for defaults:",
        parseResult.error.flatten(),
      );
      // Fallback to manual construction if safeParse fails
      const schemaShapeDefaults = PersonalInfoAndRoleSchema.shape;
      const manualDefaults: PersonalInfoAndRoleFormInput = {
        name: initialData.name ?? "",
        email: session?.user?.email ?? initialData.email ?? "",
        emailVerified: initialData.emailVerified ?? undefined,
        image: initialData.image ?? undefined,
        phone: initialData.phone ?? undefined,
        address: initialData.address ?? undefined,
        onlineStatus: initialData.onlineStatus ?? schemaShapeDefaults.onlineStatus._def.defaultValue(),
        currentTimezone: initialData.currentTimezone ?? undefined,
        onboardingCompleted: initialData.onboardingCompleted ?? schemaShapeDefaults.onboardingCompleted._def.defaultValue(),
        role: initialData.role ?? "CONSULTEE",
      };
      if (session?.user?.email) {
        manualDefaults.email = session.user.email;
      }
      return manualDefaults;
    }
  };

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<PersonalInfoAndRoleFormInput>({
    resolver: zodResolver(PersonalInfoAndRoleSchema),
    defaultValues: prepareDefaultValues(),
  });

  const onSubmit = (formData: PersonalInfoAndRoleFormInput) => {
    // formData is of type z.input. zodResolver should parse it to z.infer before calling onNext.
    // The 'data' passed by handleSubmit to this onSubmit function IS ALREADY PARSED by zodResolver.
    // So, its actual type here is PersonalInfoAndRole (z.infer), despite typing parameter as z.input.
    // This is a common pattern with react-hook-form + zodResolver.
    // We type `formData` as `PersonalInfoAndRoleFormInput` to match `useForm`'s generic,
    // but the object received has already been processed by the resolver.
    const data = formData as unknown as PersonalInfoAndRole; // Cast to z.infer type for onNext
    // Ensure email from session is used
    // 'data' is already parsed by Zod and should conform to PersonalInfoAndRole.
    // The email field in the form is disabled and shows session email.
    // Ensure the final submission uses the session email if available, otherwise form's email.
    const finalEmail = session?.user?.email || data.email; // data is now PersonalInfoAndRole
    const submissionData = {
      ...data,
      email: finalEmail,
    };
    onNext(submissionData);
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full max-w-md space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="name">Full Name</Label>
        <Input id="name" {...register("name")} />
        {errors.name && <p className="text-red-500">{errors.name.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={session?.user?.email || ""}
          disabled
          className="bg-gray-100"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone">Phone</Label>
        <Input id="phone" {...register("phone")} />
        {errors.phone && <p className="text-red-500">{errors.phone.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="address">Address</Label>
        <Input id="address" {...register("address")} />
        {errors.address && (
          <p className="text-red-500">{errors.address.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label>Role</Label>
        <Controller
          name="role"
          control={control}
          render={({ field }) => (
            <div className="flex space-x-2">
              {["CONSULTEE", "CONSULTANT", "STAFF"].map((role) => (
                <Button
                  key={role}
                  type="button"
                  variant={field.value === role ? "night" : "outline"}
                  onClick={() => field.onChange(role)}
                  className="flex-1"
                >
                  {role.charAt(0) + role.slice(1).toLowerCase()}
                </Button>
              ))}
            </div>
          )}
        />
        {errors.role && <p className="text-red-500">{errors.role.message}</p>}
      </div>

      <Button type="submit" variant="night" className="w-full">
        Next
      </Button>
    </form>
  );
};

export default PersonalInfoAndRoleForm;
