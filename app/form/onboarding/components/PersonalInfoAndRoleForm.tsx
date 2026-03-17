import React, { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PersonalInfoAndRoleFormSchema } from "@/utils/onboarding";
import { useSession } from "@/lib/auth-client";
import { z } from "zod";
import { UserRole, Gender } from "@prisma/client";

type FormData = z.infer<typeof PersonalInfoAndRoleFormSchema>;

interface Props {
  onNext: (data: FormData) => void;
  initialData: Partial<FormData>;
}

const ROLE_INFO: Record<
  string,
  { title: string; description: string; disabled?: boolean }
> = {
  CONSULTANT: {
    title: "Consultant",
    description: "Share your expertise and mentor others",
  },
  CONSULTEE: {
    title: "Consultee",
    description: "Learn from experienced professionals",
  },
  STAFF: {
    title: "Staff",
    description: "Invite only — contact your administrator",
    disabled: true,
  },
};

const GENDER_OPTIONS = [
  { value: "MALE", label: "Male" },
  { value: "FEMALE", label: "Female" },
  { value: "NON_BINARY", label: "Non-binary" },
  { value: "PREFER_NOT_TO_SAY", label: "Prefer not to say" },
];

const PersonalInfoAndRoleForm: React.FC<Props> = ({ onNext, initialData }) => {
  const { data: session } = useSession();

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(PersonalInfoAndRoleFormSchema),
    mode: "onChange",
    defaultValues: {
      name: "",
      email: session?.user?.email || "",
      onlineStatus: false,
      onboardingCompleted: false,
      role: UserRole.CONSULTEE,
      gender: null,
      city: "",
      country: "",
      linkedinUrl: "",
      bio: "",
      ...initialData,
    },
  });

  // Sync form values when initialData changes (for back navigation)
  useEffect(() => {
    if (initialData && Object.keys(initialData).length > 0) {
      reset({
        name: "",
        email: session?.user?.email || "",
        onlineStatus: false,
        onboardingCompleted: false,
        role: UserRole.CONSULTEE,
        gender: null,
        city: "",
        country: "",
        linkedinUrl: "",
        bio: "",
        ...initialData,
      });
    }
  }, [initialData, reset, session?.user?.email]);

  // Sync email from session when it loads after form mount
  useEffect(() => {
    if (session?.user?.email) {
      reset((prev) => ({ ...prev, email: session.user.email }), {
        keepDirtyValues: true,
      });
    }
  }, [session?.user?.email, reset]);

  const selectedRole = watch("role");
  const bioLength = watch("bio")?.length || 0;

  const onSubmit = (data: FormData) => {
    const submissionData = {
      ...data,
      email: session?.user?.email || "",
    };
    onNext(submissionData);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Basic Information Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Basic Information
        </h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="name">
              Full Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              {...register("name")}
              placeholder="Enter your full name"
            />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={session?.user?.email || ""}
              disabled
              className="bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              Email cannot be changed
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="phone">Phone Number</Label>
            <Input
              id="phone"
              {...register("phone")}
              placeholder="+1 (555) 000-0000"
            />
            {errors.phone && (
              <p className="text-sm text-destructive">{errors.phone.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="gender">Gender</Label>
            <Controller
              name="gender"
              control={control}
              render={({ field }) => (
                <Select
                  value={field.value || undefined}
                  // Radix Select returns string; values are Gender enum members
                  onValueChange={(value) => field.onChange(value as Gender)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select gender" />
                  </SelectTrigger>
                  <SelectContent>
                    {GENDER_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </div>
      </div>

      {/* Location Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Location
        </h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="city">City</Label>
            <Input
              id="city"
              {...register("city")}
              placeholder="e.g., San Francisco"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="country">Country</Label>
            <Input
              id="country"
              {...register("country")}
              placeholder="e.g., United States"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="address">Full Address (Optional)</Label>
          <Input
            id="address"
            {...register("address")}
            placeholder="Street address, apt, city, state, zip"
          />
        </div>
      </div>

      {/* Profile Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Your Profile
        </h3>

        <div className="space-y-2">
          <Label htmlFor="bio">
            Short Bio <span className="text-muted-foreground">(Optional)</span>
          </Label>
          <Textarea
            id="bio"
            {...register("bio")}
            placeholder="Tell us a bit about yourself in one or two sentences..."
            className="resize-none"
            rows={2}
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>A brief tagline that appears on your profile</span>
            <span className={bioLength > 160 ? "text-destructive" : ""}>
              {bioLength}/160
            </span>
          </div>
          {errors.bio && (
            <p className="text-sm text-destructive">{errors.bio.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="linkedinUrl">
            LinkedIn Profile{" "}
            <span className="text-muted-foreground">(Optional)</span>
          </Label>
          <Input
            id="linkedinUrl"
            {...register("linkedinUrl")}
            placeholder="https://linkedin.com/in/yourprofile"
          />
          {errors.linkedinUrl && (
            <p className="text-sm text-destructive">
              {errors.linkedinUrl.message}
            </p>
          )}
        </div>
      </div>

      {/* Role Selection */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          I want to join as a... <span className="text-destructive">*</span>
        </h3>

        <Controller
          name="role"
          control={control}
          render={({ field }) => (
            <div className="grid gap-3 sm:grid-cols-3">
              {Object.entries(ROLE_INFO).map(([role, info]) => (
                <button
                  key={role}
                  type="button"
                  disabled={info.disabled}
                  // Object.entries types keys as string; role is a UserRole member
                  onClick={() => !info.disabled && field.onChange(role as UserRole)}
                  className={`p-4 rounded-lg border-2 text-left transition-all ${
                    info.disabled
                      ? "opacity-50 cursor-not-allowed bg-muted border-border"
                      : field.value === role
                        ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                        : "border-border hover:border-primary/50 hover:bg-muted/50"
                  }`}
                >
                  <div className="font-medium">{info.title}</div>
                  <div className="text-sm text-muted-foreground mt-1">
                    {info.description}
                  </div>
                </button>
              ))}
            </div>
          )}
        />
        {errors.role && (
          <p className="text-sm text-destructive">{errors.role.message}</p>
        )}
      </div>

      {/* Role-specific info */}
      {selectedRole && (
        <div className="bg-muted/50 rounded-lg p-4 text-sm">
          <p className="text-muted-foreground">
            {selectedRole === "CONSULTANT" && (
              <>
                As a <strong>Consultant</strong>, you'll be able to create
                consultation plans, set your availability, and connect with
                consultees who need your expertise.
              </>
            )}
            {selectedRole === "CONSULTEE" && (
              <>
                As a <strong>Consultee</strong>, you'll be able to browse
                consultants, book sessions, and get personalized guidance from
                experts in your field.
              </>
            )}
            {/* STAFF and ADMIN roles are invite-only via admin dashboard */}
          </p>
        </div>
      )}

      <Button type="submit" className="w-full" size="lg">
        Continue
      </Button>
    </form>
  );
};

export default PersonalInfoAndRoleForm;
