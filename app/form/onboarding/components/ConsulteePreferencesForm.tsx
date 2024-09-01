import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ConsulteePreferences, ConsulteePreferencesSchema } from "@/schemas/UserSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import React from "react";
import { useFieldArray, useForm } from "react-hook-form";

interface Props {
  onNext: (data: Partial<ConsulteePreferences>) => void;
  onBack: () => void;
  initialData: Partial<ConsulteePreferences>;
}

const ConsulteePreferencesForm: React.FC<Props> = ({ onNext, onBack, initialData }) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
    control,
    setValue,
  } = useForm<ConsulteePreferences>({
    resolver: zodResolver(ConsulteePreferencesSchema),
    defaultValues: initialData,
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "interests",
  });

  const onSubmit = (data: ConsulteePreferences) => {
    onNext(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-full max-w-md space-y-4">
      <div className="space-y-2">
        <Label htmlFor="preferredCommunicationMethod">Preferred Communication Method</Label>
        <Select
          onValueChange={(value) => setValue("preferredCommunicationMethod", value as "VIDEO" | "AUDIO" | "IN_PERSON")}
          defaultValue={initialData.preferredCommunicationMethod}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select communication method" />
          </SelectTrigger>
          <SelectContent className="bg-slate-100">
            <SelectItem value="VIDEO">Video</SelectItem>
            <div className="border-t border-gray-300 my-1"></div>
            <SelectItem value="AUDIO">Audio</SelectItem>
            <div className="border-t border-gray-300 my-1"></div>
            <SelectItem value="IN_PERSON">In Person</SelectItem>
          </SelectContent>
        </Select>
        {errors.preferredCommunicationMethod && (
          <p className="text-red-500">{errors.preferredCommunicationMethod.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="preferredLanguage">Preferred Language</Label>
        <Input id="preferredLanguage" {...register("preferredLanguage")} />
        {errors.preferredLanguage && (
          <p className="text-red-500">{errors.preferredLanguage.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="specialRequirements">Special Requirements (Optional)</Label>
        <Textarea id="specialRequirements" {...register("specialRequirements")} />
        {errors.specialRequirements && (
          <p className="text-red-500">{errors.specialRequirements.message}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label>Domains of Interest</Label>
        {fields.map((field, index) => (
          <div key={field.id} className="flex space-x-2">
            <Input
              placeholder="Domain"
              {...register(`interests.${index}.name`)}
              defaultValue={field.name}
            />
            <Input
              placeholder="Subdomains (comma-separated)"
              {...register(`interests.${index}.skills`)}
              defaultValue={Array.isArray(field.skills) ? field.skills.join(", ") : field.skills}
            />
            <Button type="button" variant="outline" onClick={() => remove(index)}>
              Remove
            </Button>
          </div>
        ))}
        <Button type="button" variant="night" onClick={() => append({ name: "", skills: "" })}>
          Add Domain
        </Button>
        {errors.interests && <p className="text-red-500">{errors.interests.message}</p>}
        {fields.length === 0 && <p className="text-gray-500">No interests added</p>}
        {fields.length > 0 && (
          <p className="text-gray-500">
            {fields.length} domain{fields.length > 1 ? "s" : ""} added
          </p>
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

export default ConsulteePreferencesForm;