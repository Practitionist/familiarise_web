import React, { useEffect, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  ConsultantProfile,
  ConsultantProfileSchema,
  PersonalInfoAndRole,
} from "@/schemas/UserSchema";
import { Domain, SubDomain, Tag } from "@/schemas/PlanSchema";

interface Props {
  onNext: (data: FormData) => void;
  onBack: () => void;
  initialData: FormData;
}

type FormData = PersonalInfoAndRole &
  Partial<ConsultantProfile> & {
    domain?: Domain;
    subDomains?: SubDomain[];
    tags?: Tag[];
  };

const ConsultantProfileForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
}) => {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [subDomains, setSubDomains] = useState<SubDomain[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [filteredSubDomains, setFilteredSubDomains] = useState<SubDomain[]>([]);
  const [filteredTags, setFilteredTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(ConsultantProfileSchema),
    defaultValues: initialData,
  });

  const selectedDomain = watch("domain");

  useEffect(() => {
    const fetchMetadata = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/user/consultants/meta");
        if (!response.ok) {
          throw new Error("Failed to fetch metadata");
        }
        const { data } = await response.json();
        setDomains(data.domains);
        setSubDomains(data.subdomains);
        setTags(data.tags);
        setFilteredSubDomains(data.subdomains);
        setFilteredTags(data.tags);
      } catch (error) {
        console.error("Error fetching metadata:", error);
        setError("Failed to load form data. Please try again.");
      } finally {
        setIsLoading(false);
      }
    };
    fetchMetadata();
  }, []);

  useEffect(() => {
    if (selectedDomain) {
      const filteredSubs = subDomains.filter(
        (sub) => sub.domainId === selectedDomain.id,
      );
      const filteredTgs = tags.filter(
        (tag) => tag.domainId === selectedDomain.id,
      );
      setFilteredSubDomains(filteredSubs);
      setFilteredTags(filteredTgs);

      // Clear selected subdomains and tags that are no longer valid
      setValue(
        "subDomains",
        (watch("subDomains") || []).filter((sd) =>
          filteredSubs.some((fs) => fs.id === sd.id),
        ),
      );
      setValue(
        "tags",
        (watch("tags") || []).filter((t) =>
          filteredTgs.some((ft) => ft.id === t.id),
        ),
      );
    } else {
      setFilteredSubDomains(subDomains);
      setFilteredTags(tags);
    }
  }, [selectedDomain, subDomains, tags, setValue, watch]);

  const onSubmit = (data: FormData) => {
    onNext(data);
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div className="text-red-500">{error}</div>;
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full max-w-md space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" {...register("description")} />
        {errors.description && (
          <p className="text-red-500">{errors.description?.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="qualifications">Qualifications</Label>
        <Input id="qualifications" {...register("qualifications")} />
        {errors.qualifications && (
          <p className="text-red-500">{errors.qualifications?.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="specialization">Specialization</Label>
        <Input id="specialization" {...register("specialization")} />
        {errors.specialization && (
          <p className="text-red-500">{errors.specialization?.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="experience">Experience</Label>
        <Input id="experience" {...register("experience")} />
        {errors.experience && (
          <p className="text-red-500">{errors.experience?.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="domain">Domain</Label>
        <Controller
          name="domain"
          control={control}
          render={({ field }) => (
            <Select
              onValueChange={(value) => {
                const selectedDomain = domains.find((d) => d.id === value);
                field.onChange(selectedDomain);
              }}
              value={field.value?.id ?? ""}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a domain" />
              </SelectTrigger>
              <SelectContent>
                {domains.map((domain) => (
                  <SelectItem key={domain.id} value={domain.id!}>
                    {domain.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.domain && (
          <p className="text-red-500">{errors.domain?.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label>Sub-Domains</Label>
        <Controller
          name="subDomains"
          control={control}
          render={({ field }) => (
            <div className="space-y-2">
              {filteredSubDomains.map((subDomain) => (
                <div key={subDomain.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`subDomain-${subDomain.id}`}
                    checked={
                      field.value?.some((sd) => sd.id === subDomain.id) || false
                    }
                    onCheckedChange={(checked) => {
                      const updatedSubDomains = checked
                        ? [...(field.value || []), subDomain]
                        : (field.value || []).filter(
                            (sd) => sd.id !== subDomain.id,
                          );
                      field.onChange(updatedSubDomains);
                    }}
                  />
                  <Label htmlFor={`subDomain-${subDomain.id}`}>
                    {subDomain.name}
                  </Label>
                </div>
              ))}
            </div>
          )}
        />
        {errors.subDomains && (
          <p className="text-red-500">{errors.subDomains?.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label>Tags</Label>
        <Controller
          name="tags"
          control={control}
          render={({ field }) => (
            <div className="space-y-2">
              {filteredTags.map((tag) => (
                <div key={tag.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`tag-${tag.id}`}
                    checked={field.value?.some((t) => t.id === tag.id) || false}
                    onCheckedChange={(checked) => {
                      const updatedTags = checked
                        ? [...(field.value || []), tag]
                        : (field.value || []).filter((t) => t.id !== tag.id);
                      field.onChange(updatedTags);
                    }}
                  />
                  <Label htmlFor={`tag-${tag.id}`}>{tag.name}</Label>
                </div>
              ))}
            </div>
          )}
        />
        {errors.tags && <p className="text-red-500">{errors.tags?.message}</p>}
      </div>

      <div className="space-y-2">
        <Label>Schedule Type</Label>
        <Controller
          name="scheduleType"
          control={control}
          render={({ field }) => (
            <div className="flex space-x-2">
              {["WEEKLY", "CUSTOM"].map((type) => (
                <Button
                  key={type}
                  type="button"
                  variant={field.value === type ? "night" : "outline"}
                  onClick={() => field.onChange(type)}
                  className="flex-1"
                >
                  {type.charAt(0) + type.slice(1).toLowerCase()}
                </Button>
              ))}
            </div>
          )}
        />
        {errors.scheduleType && (
          <p className="text-red-500">{errors.scheduleType?.message}</p>
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

export default ConsultantProfileForm;
