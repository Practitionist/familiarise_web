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
import { ConsultantProfileFormSchema } from "@/utils/onboarding";
import { z } from "zod";
import { useThemeClasses } from "../useTheme";

interface Props {
  onNext: (data: FormData) => void;
  onBack: () => void;
  initialData: Partial<ConsultantProfile>;
  personalInfo: PersonalInfoAndRole;
}

type FormData = z.infer<typeof ConsultantProfileFormSchema>;

const ConsultantProfileForm: React.FC<Props> = ({
  onNext,
  onBack,
  initialData,
  personalInfo,
}) => {
  const { classes, colors } = useThemeClasses();
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
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(ConsultantProfileFormSchema),
    mode: "onChange",
    defaultValues: {
      description: "",
      qualifications: "",
      specialization: "",
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
          <p className={colors.textSecondary}>Loading form data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center space-y-4 p-8">
        <p className={`${colors.error} text-lg`}>{error}</p>
        <Button
          onClick={() => window.location.reload()}
          className={classes.primaryButton}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-full space-y-6">
      <div className="space-y-3">
        <Label
          htmlFor="description"
          className={`${colors.textPrimary} font-medium`}
        >
          Description
        </Label>
        <Textarea
          id="description"
          {...register("description")}
          className={classes.textarea}
          placeholder="Tell us about your expertise and what you can offer"
          rows={4}
        />
        {errors.description && (
          <p className={`${colors.error} text-sm`}>
            {errors.description.message}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label
          htmlFor="qualifications"
          className={`${colors.textPrimary} font-medium`}
        >
          Qualifications
        </Label>
        <Textarea
          id="qualifications"
          {...register("qualifications")}
          className={classes.textarea}
          placeholder="Your education, certifications, and relevant qualifications"
          rows={3}
        />
        {errors.qualifications && (
          <p className={`${colors.error} text-sm`}>
            {errors.qualifications.message}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label
          htmlFor="specialization"
          className={`${colors.textPrimary} font-medium`}
        >
          Specialization
        </Label>
        <Input
          id="specialization"
          {...register("specialization")}
          className={classes.input}
          placeholder="Your area of specialization"
        />
        {errors.specialization && (
          <p className={`${colors.error} text-sm`}>
            {errors.specialization.message}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label
          htmlFor="experience"
          className={`${colors.textPrimary} font-medium`}
        >
          Years of Experience
        </Label>
        <Input
          id="experience"
          type="number"
          min="0"
          max="100"
          step="0.5"
          {...register("experience", { valueAsNumber: true })}
          className={classes.input}
          placeholder="0"
        />
        {errors.experience && (
          <p className={`${colors.error} text-sm`}>
            {errors.experience.message}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Label className={`${colors.textPrimary} font-medium`}>Domain</Label>
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
              <SelectTrigger className={classes.dropdown}>
                <SelectValue placeholder="Select a domain" />
              </SelectTrigger>
              <SelectContent>
                {domains.map((domain) => (
                  <SelectItem
                    key={domain.id}
                    value={domain.id || ""}
                    className={classes.dropdownItem}
                  >
                    {domain.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.domain && (
          <p className={`${colors.error} text-sm`}>{errors.domain.message}</p>
        )}
      </div>

      {selectedDomain?.id && (
        <div className="space-y-3">
          <Label className={`${colors.textPrimary} font-medium`}>
            Sub-domains
          </Label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-40 overflow-y-auto p-2 border rounded-md">
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
                            field.onChange([...(field.value || []), subDomain]);
                          } else {
                            field.onChange(
                              field.value?.filter(
                                (s) => s.id !== subDomain.id,
                              ) || [],
                            );
                          }
                        }}
                        className={classes.checkbox}
                      />
                      <Label
                        htmlFor={`subdomain-${subDomain.id}`}
                        className={`${colors.textSecondary} text-sm cursor-pointer`}
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
            <p className={`${colors.error} text-sm`}>
              {errors.subDomains.message}
            </p>
          )}
        </div>
      )}

      {selectedDomain?.id && (
        <div className="space-y-3">
          <Label className={`${colors.textPrimary} font-medium`}>Tags</Label>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-40 overflow-y-auto p-2 border rounded-md">
            <Controller
              name="tags"
              control={control}
              render={({ field }) => (
                <>
                  {filteredTags.map((tag) => (
                    <div key={tag.id} className="flex items-center space-x-2">
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
                              field.value?.filter((t) => t.id !== tag.id) || [],
                            );
                          }
                        }}
                        className={classes.checkbox}
                      />
                      <Label
                        htmlFor={`tag-${tag.id}`}
                        className={`${colors.textSecondary} text-sm cursor-pointer`}
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
            <p className={`${colors.error} text-sm`}>{errors.tags.message}</p>
          )}
        </div>
      )}

      <div className="space-y-3">
        <Label className={`${colors.textPrimary} font-medium`}>
          Schedule Type
        </Label>
        <Controller
          name="scheduleType"
          control={control}
          render={({ field }) => (
            <div className="flex gap-4">
              <Button
                type="button"
                onClick={() => field.onChange("WEEKLY")}
                variant={field.value === "WEEKLY" ? "default" : "outline"}
                className={`${classes.secondaryButton} flex-1`}
              >
                Weekly
              </Button>
              <Button
                type="button"
                onClick={() => field.onChange("CUSTOM")}
                variant={field.value === "CUSTOM" ? "default" : "outline"}
                className={`${classes.secondaryButton} flex-1`}
              >
                Custom
              </Button>
            </div>
          )}
        />
        {errors.scheduleType && (
          <p className={`${colors.error} text-sm`}>
            {errors.scheduleType.message}
          </p>
        )}
      </div>

      <div className="flex gap-4">
        <Button
          type="button"
          onClick={onBack}
          variant="outline"
          className={`${classes.secondaryButton} flex-1`}
        >
          Back
        </Button>
        <Button type="submit" className={`${classes.primaryButton} flex-1`}>
          Next
        </Button>
      </div>
    </form>
  );
};

export default ConsultantProfileForm;
