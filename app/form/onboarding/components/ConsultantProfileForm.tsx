import React, { useState, useEffect, useMemo } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConsultantProfile, PersonalInfoAndRole } from "@/schemas/user";
import { Domain, SubDomain, Tag } from "@/schemas/plans";
import {
  ConsultantProfileFormSchema,
  OnboardingFormData,
} from "@/utils/onboarding";
import { z } from "zod";

interface Props {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  initialData: Partial<OnboardingFormData>;
  personalInfo: PersonalInfoAndRole;
}

type FormData = z.infer<typeof ConsultantProfileFormSchema>;

const ConsultantProfileForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
  personalInfo,
}) => {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [subDomains, setSubDomains] = useState<SubDomain[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(ConsultantProfileFormSchema) as any,
    mode: "onChange",
    defaultValues: {
      description: "",
      headline: "",
      experience: 0,
      scheduleType: "WEEKLY",
      domain: { id: "", name: "" },
      subDomains: [],
      tags: [],
      weeklySlots: [],
      customSlots: [],
      ...initialData,
    },
  });

  const selectedDomain = watch("domain");

  // Filter subdomains and tags based on selected domain
  const filteredSubDomains = useMemo(() => {
    return subDomains.filter((sub) => sub.domainId === selectedDomain?.id);
  }, [subDomains, selectedDomain]);

  const filteredTags = useMemo(() => {
    return tags.filter((tag) => tag.domainId === selectedDomain?.id);
  }, [tags, selectedDomain]);

  // Sync form values when initialData changes (for back navigation)
  useEffect(() => {
    if (initialData && Object.keys(initialData).length > 0) {
      reset({
        description: "",
        headline: "",
        experience: 0,
        scheduleType: "WEEKLY",
        domain: { id: "", name: "" },
        subDomains: [],
        tags: [],
        weeklySlots: [],
        customSlots: [],
        ...initialData,
      });
    }
  }, [initialData, reset]);

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
      } catch (error) {
        console.error("Error fetching metadata:", error);
        setError("Failed to load form data. Please try again.");
      } finally {
        setIsLoading(false);
      }
    };
    fetchMetadata();
  }, []);

  const onSubmit = (data: FormData) => {
    onNext(data);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="text-muted-foreground">Loading form data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center space-y-4 p-8">
        <p className="text-destructive text-lg">{error}</p>
        <Button onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Professional Summary */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Professional Summary
        </h3>

        <div className="space-y-2">
          <Label htmlFor="description">
            About Your Expertise <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="description"
            {...register("description")}
            placeholder="Tell us about your expertise and what you can offer to consultees"
            rows={4}
          />
          {errors.description && (
            <p className="text-sm text-destructive">
              {errors.description.message}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="headline">Professional Headline</Label>
          <Input
            id="headline"
            {...register("headline")}
            placeholder="e.g., Senior Software Engineer | Career Coach | 10+ Years Experience"
          />
          {errors.headline && (
            <p className="text-sm text-destructive">
              {errors.headline.message}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            A brief tagline that appears on your profile
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="experience">
            Years of Experience <span className="text-destructive">*</span>
          </Label>
          <Input
            id="experience"
            type="number"
            min="0"
            max="100"
            step="0.5"
            {...register("experience", { valueAsNumber: true })}
            placeholder="0"
          />
          {errors.experience && (
            <p className="text-sm text-destructive">
              {errors.experience.message}
            </p>
          )}
        </div>
      </div>

      {/* Domain & Expertise */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Domain & Expertise
        </h3>

        <div className="space-y-2">
          <Label>
            Primary Domain <span className="text-destructive">*</span>
          </Label>
          <Controller
            name="domain"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value?.id || ""}
                onValueChange={(value) => {
                  const domain = domains.find((d) => d.id === value);
                  field.onChange(domain || { id: "", name: "" });
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a domain" />
                </SelectTrigger>
                <SelectContent>
                  {domains.map((domain) => (
                    <SelectItem key={domain.id} value={domain.id || ""}>
                      {domain.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          {errors.domain && (
            <p className="text-sm text-destructive">{errors.domain.message}</p>
          )}
        </div>

        {selectedDomain?.id && (
          <>
            <div className="space-y-2">
              <Label>Sub-domains</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-40 overflow-y-auto p-3 rounded-lg bg-muted/50 border">
                <Controller
                  name="subDomains"
                  control={control}
                  render={({ field }) => (
                    <>
                      {filteredSubDomains.map((subDomain) => (
                        <div
                          key={subDomain.id}
                          className="flex items-center space-x-2"
                        >
                          <Checkbox
                            id={`subdomain-${subDomain.id}`}
                            checked={
                              field.value?.some((s) => s.id === subDomain.id) ||
                              false
                            }
                            onCheckedChange={(checked) => {
                              if (checked) {
                                field.onChange([
                                  ...(field.value || []),
                                  subDomain,
                                ]);
                              } else {
                                field.onChange(
                                  field.value?.filter(
                                    (s) => s.id !== subDomain.id,
                                  ) || [],
                                );
                              }
                            }}
                          />
                          <Label
                            htmlFor={`subdomain-${subDomain.id}`}
                            className="text-sm cursor-pointer"
                          >
                            {subDomain.name}
                          </Label>
                        </div>
                      ))}
                    </>
                  )}
                />
              </div>
              {errors.subDomains && (
                <p className="text-sm text-destructive">
                  {errors.subDomains.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Tags / Skills</Label>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-40 overflow-y-auto p-3 rounded-lg bg-muted/50 border">
                <Controller
                  name="tags"
                  control={control}
                  render={({ field }) => (
                    <>
                      {filteredTags.map((tag) => (
                        <div
                          key={tag.id}
                          className="flex items-center space-x-2"
                        >
                          <Checkbox
                            id={`tag-${tag.id}`}
                            checked={
                              field.value?.some((t) => t.id === tag.id) || false
                            }
                            onCheckedChange={(checked) => {
                              if (checked) {
                                field.onChange([...(field.value || []), tag]);
                              } else {
                                field.onChange(
                                  field.value?.filter((t) => t.id !== tag.id) ||
                                    [],
                                );
                              }
                            }}
                          />
                          <Label
                            htmlFor={`tag-${tag.id}`}
                            className="text-sm cursor-pointer"
                          >
                            {tag.name}
                          </Label>
                        </div>
                      ))}
                    </>
                  )}
                />
              </div>
              {errors.tags && (
                <p className="text-sm text-destructive">
                  {errors.tags.message}
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {/* Schedule Type */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Schedule Preference
        </h3>

        <Controller
          name="scheduleType"
          control={control}
          render={({ field }) => (
            <div className="flex gap-4 flex-wrap">
              <Button
                type="button"
                onClick={() => field.onChange("WEEKLY")}
                variant={field.value === "WEEKLY" ? "default" : "outline"}
                className="flex-1"
              >
                Weekly Schedule
              </Button>
              <Button
                type="button"
                onClick={() => field.onChange("CUSTOM")}
                variant={field.value === "CUSTOM" ? "default" : "outline"}
                className="flex-1"
              >
                Custom Schedule
              </Button>
            </div>
          )}
        />
        <p className="text-sm text-muted-foreground">
          {watch("scheduleType") === "WEEKLY"
            ? "Set recurring weekly availability (e.g., Mondays 9am-5pm)"
            : "Set specific dates and times for availability"}
        </p>
        {errors.scheduleType && (
          <p className="text-sm text-destructive">
            {errors.scheduleType.message}
          </p>
        )}
      </div>

      {/* Navigation */}
      <div className="flex gap-4 pt-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className="flex-1"
        >
          Back
        </Button>
        <Button type="submit" className="flex-1">
          Continue
        </Button>
      </div>
    </form>
  );
};

export default ConsultantProfileForm;
