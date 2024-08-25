import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ConsulteePreferences, consulteePreferencesSchema } from "@/schemas/UserSchema";
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
    resolver: zodResolver(consulteePreferencesSchema),
    defaultValues: initialData,
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "domains",
  });

  const onSubmit = (data: ConsulteePreferences) => {
    onNext(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-full max-w-md space-y-4">
      <div className="space-y-2">
        <Label htmlFor="preferredConsultationMode">Preferred Consultation Mode</Label>
        <Select
          onValueChange={(value) => setValue("preferredConsultationMode", value as "VIDEO" | "AUDIO" | "IN_PERSON")}
          defaultValue={initialData.preferredConsultationMode}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select consultation mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="VIDEO">Video</SelectItem>
            <SelectItem value="AUDIO">Audio</SelectItem>
            <SelectItem value="IN_PERSON">In Person</SelectItem>
          </SelectContent>
        </Select>
        {errors.preferredConsultationMode && (
          <p className="text-red-500">{errors.preferredConsultationMode.message}</p>
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
              {...register(`domains.${index}.name`)}
              defaultValue={field.name}
            />
            <Input
              placeholder="Subdomains (comma-separated)"
              {...register(`domains.${index}.subdomains`)}
              defaultValue={Array.isArray(field.subdomains) ? field.subdomains.join(", ") : field.subdomains}
            />
            <Button type="button" variant="outline" onClick={() => remove(index)}>
              Remove
            </Button>
          </div>
        ))}
        <Button type="button" variant="night" onClick={() => append({ name: "", subdomains: [] })}>
          Add Domain
        </Button>
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