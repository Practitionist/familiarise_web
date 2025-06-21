import React from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PersonalInfoAndRole, PersonalInfoAndRoleSchema } from "@/schemas/user";
import { useSession } from "next-auth/react";

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
  } = useForm<PersonalInfoAndRole>({
    resolver: zodResolver(PersonalInfoAndRoleSchema),
    defaultValues: {
      ...initialData,
      email: session?.user?.email || "",
    },
  });

  const onSubmit = (data: PersonalInfoAndRole) => {
    // Ensure email from session is used
    const submissionData = {
      ...data,
      email: session?.user?.email || "",
    };
    onNext(submissionData);
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full space-y-6"
    >
      <div className="space-y-3">
        <Label htmlFor="name" className="text-white font-medium">Full Name</Label>
        <Input 
          id="name" 
          {...register("name")} 
          className="bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-purple-400 focus:ring-purple-400/20 backdrop-blur-sm h-12 rounded-lg"
          placeholder="Enter your full name"
        />
        {errors.name && <p className="text-red-400 text-sm">{errors.name.message}</p>}
      </div>

      <div className="space-y-3">
        <Label htmlFor="email" className="text-white font-medium">Email</Label>
        <Input
          id="email"
          type="email"
          value={session?.user?.email || ""}
          disabled
          className="bg-white/5 border-white/20 text-white h-12 rounded-lg opacity-70"
        />
      </div>

      <div className="space-y-3">
        <Label htmlFor="phone" className="text-white font-medium">Phone</Label>
        <Input 
          id="phone" 
          {...register("phone")} 
          className="bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-purple-400 focus:ring-purple-400/20 backdrop-blur-sm h-12 rounded-lg"
          placeholder="Enter your phone number"
        />
        {errors.phone && <p className="text-red-400 text-sm">{errors.phone.message}</p>}
      </div>

      <div className="space-y-3">
        <Label htmlFor="address" className="text-white font-medium">Address</Label>
        <Input 
          id="address" 
          {...register("address")} 
          className="bg-white/10 border-white/20 text-white placeholder:text-white/50 focus:border-purple-400 focus:ring-purple-400/20 backdrop-blur-sm h-12 rounded-lg"
          placeholder="Enter your address"
        />
        {errors.address && (
          <p className="text-red-400 text-sm">{errors.address.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label className="text-white font-medium">Role</Label>
        <Controller
          name="role"
          control={control}
          render={({ field }) => (
            <div className="grid grid-cols-3 gap-2">
              {["CONSULTEE", "CONSULTANT", "STAFF"].map((role) => (
                <Button
                  key={role}
                  type="button"
                  variant={field.value === role ? "default" : "outline"}
                  onClick={() => field.onChange(role)}
                  className={`h-12 rounded-lg font-medium transition-all duration-200 ${
                    field.value === role 
                      ? "bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-lg shadow-purple-500/25 border-0" 
                      : "bg-white/10 border-white/20 text-white hover:bg-white/20 hover:border-white/30"
                  }`}
                >
                  {role.charAt(0) + role.slice(1).toLowerCase()}
                </Button>
              ))}
            </div>
          )}
        />
        {errors.role && <p className="text-red-400 text-sm">{errors.role.message}</p>}
      </div>

      <Button 
        type="submit" 
        className="w-full h-12 bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold rounded-lg shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 transition-all duration-200 border-0 mt-8"
      >
        Next Step →
      </Button>
    </form>
  );
};

export default PersonalInfoAndRoleForm;
