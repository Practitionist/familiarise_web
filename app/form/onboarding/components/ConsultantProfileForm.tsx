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
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConsultantProfile, PersonalInfoAndRole } from "@/schemas/user";
import { Domain, SubDomain, Tag } from "@/schemas/plans";
import { ConsultantProfileFormSchema } from "@/utils/onboarding";
import { z } from "zod";

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
  } = useForm<z.infer<typeof ConsultantProfileFormSchema>>({
    resolver: zodResolver(ConsultantProfileFormSchema),
    mode: "onChange",
    defaultValues: {
      description: initialData.description || "",
      qualifications: initialData.qualifications || "",
      specialization: initialData.specialization || "",
      experience: initialData.experience || 0,
      scheduleType: initialData.scheduleType || "WEEKLY",
      domain: initialData.domain,
      subDomains: initialData.subDomains || [],
      tags: initialData.tags || [],
    },
  });

  const selectedDomain = watch("domain");
  const currentSubDomains = watch("subDomains") || [];
  const currentTags = watch("tags") || [];

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

  // Update filtered lists when domain changes
  useEffect(() => {
    if (!selectedDomain) {
      setFilteredSubDomains(subDomains);
      setFilteredTags(tags);
      return;
    }

    const newFilteredSubs = subDomains.filter(
      (sub) => sub.domainId === selectedDomain.id,
    );
    const newFilteredTags = tags.filter(
      (tag) => tag.domainId === selectedDomain.id,
    );

    setFilteredSubDomains(newFilteredSubs);
    setFilteredTags(newFilteredTags);

    // Update selected values only if they're invalid for the new domain
    const validSubDomains = currentSubDomains.filter((sd) =>
      newFilteredSubs.some((fs) => fs.id === sd.id),
    );
    const validTags = currentTags.filter((t) =>
      newFilteredTags.some((ft) => ft.id === t.id),
    );

    if (validSubDomains.length !== currentSubDomains.length) {
      setValue("subDomains", validSubDomains, { shouldDirty: true });
    }
    if (validTags.length !== currentTags.length) {
      setValue("tags", validTags, { shouldDirty: true });
    }
  }, [selectedDomain?.id]); // Only depend on the domain ID

  const onSubmit = (data: z.infer<typeof ConsultantProfileFormSchema>) => {
    onNext(data as FormData);
  };

  if (isLoading) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Consultant profile</CardTitle>
          <CardDescription>Tell consultees about your expertise and availability.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
          <Skeleton className="h-32 w-full" />
        </CardContent>
        <CardFooter>
          <Skeleton className="h-10 w-32" />
        </CardFooter>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription className="text-destructive">{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Consultant profile</CardTitle>
        <CardDescription>Share your background so consultees can quickly understand your strengths.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" placeholder="Brief summary about your expertise, approach, and outcomes." {...register("description")} />
            {errors.description && (
              <p className="text-sm text-destructive">{errors.description?.message}</p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="qualifications">Qualifications</Label>
              <Input id="qualifications" placeholder="Degrees, certifications, notable credentials" {...register("qualifications")} />
              {errors.qualifications && (
                <p className="text-sm text-destructive">{errors.qualifications?.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="specialization">Specialization</Label>
              <Input id="specialization" placeholder="Primary focus areas (e.g., AI, Product, Marketing)" {...register("specialization")} />
              {errors.specialization && (
                <p className="text-sm text-destructive">{errors.specialization?.message}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="experience">Years of Experience</Label>
              <Input 
                id="experience" 
                type="number" 
                min="0" 
                max="50" 
                step="0.5"
                placeholder="e.g., 7"
                {...register("experience", { valueAsNumber: true })} 
              />
              {errors.experience && (
                <p className="text-sm text-destructive">{errors.experience?.message}</p>
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
                <p className="text-sm text-destructive">{errors.domain?.message}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Sub-domains</Label>
              <Controller
                name="subDomains"
                control={control}
                render={({ field }) => (
                  <div className="rounded-md border bg-card text-card-foreground p-3 max-h-40 overflow-auto space-y-2">
                    {filteredSubDomains.map((subDomain) => (
                      <div key={subDomain.id} className="flex items-center gap-2">
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
                        <Label htmlFor={`subDomain-${subDomain.id}`} className="font-normal">
                          {subDomain.name}
                        </Label>
                      </div>
                    ))}
                  </div>
                )}
              />
              {errors.subDomains && (
                <p className="text-sm text-destructive">{errors.subDomains?.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Tags</Label>
              <Controller
                name="tags"
                control={control}
                render={({ field }) => (
                  <div className="rounded-md border bg-card text-card-foreground p-3 max-h-40 overflow-auto space-y-2">
                    {filteredTags.map((tag) => (
                      <div key={tag.id} className="flex items-center gap-2">
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
                        <Label htmlFor={`tag-${tag.id}`} className="font-normal">{tag.name}</Label>
                      </div>
                    ))}
                  </div>
                )}
              />
              {errors.tags && (
                <p className="text-sm text-destructive">{errors.tags?.message}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Schedule type</Label>
            <Controller
              name="scheduleType"
              control={control}
              render={({ field }) => (
                <div className="bg-muted p-1 rounded-lg grid grid-cols-2 gap-1">
                  {["WEEKLY", "CUSTOM"].map((type) => (
                    <Button
                      key={type}
                      type="button"
                      size="sm"
                      variant={field.value === type ? "night" : "outline"}
                      onClick={() => field.onChange(type)}
                      className="w-full"
                    >
                      {type.charAt(0) + type.slice(1).toLowerCase()}
                    </Button>
                  ))}
                </div>
              )}
            />
            {errors.scheduleType && (
              <p className="text-sm text-destructive">{errors.scheduleType?.message}</p>
            )}
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button type="button" onClick={onBack} variant="outline">
              Back
            </Button>
            <Button type="submit" variant="night">
              Next
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
};

export default ConsultantProfileForm;
