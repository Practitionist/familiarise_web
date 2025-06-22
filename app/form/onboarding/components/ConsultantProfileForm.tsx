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
} from "@/schemas/user";
import { Domain, SubDomain, Tag } from "@/schemas/plans";
import { useThemeClasses } from "../useTheme";

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
  const { classes, colors } = useThemeClasses();
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

  const onSubmit = (data: FormData) => {
    onNext(data);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className={`animate-spin rounded-full h-8 w-8 border-b-2 ${colors.textPrimary}`}></div>
        <span className={`ml-3 ${colors.textPrimary}`}>Loading...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`p-4 ${colors.glassBg} ${colors.glassBorder} rounded-lg`}>
        <p className={colors.error}>{error}</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="w-full space-y-6"
    >
      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left Column - Basic Information */}
        <div className="space-y-6">
          <div className="space-y-3">
            <Label htmlFor="description" className={`${colors.textPrimary} font-medium`}>Description</Label>
            <Textarea 
              id="description" 
              {...register("description")} 
              className={classes.textarea}
              placeholder="Tell us about yourself and your expertise..."
            />
            {errors.description && (
              <p className={`${colors.error} text-sm`}>{errors.description?.message}</p>
            )}
          </div>

          <div className="space-y-3">
            <Label htmlFor="qualifications" className={`${colors.textPrimary} font-medium`}>Qualifications</Label>
            <Input 
              id="qualifications" 
              {...register("qualifications")} 
              className={classes.input}
              placeholder="Your educational background and certifications"
            />
            {errors.qualifications && (
              <p className={`${colors.error} text-sm`}>{errors.qualifications?.message}</p>
            )}
          </div>

          <div className="space-y-3">
            <Label htmlFor="specialization" className={`${colors.textPrimary} font-medium`}>Specialization</Label>
            <Input 
              id="specialization" 
              {...register("specialization")} 
              className={classes.input}
              placeholder="Your area of expertise"
            />
            {errors.specialization && (
              <p className={`${colors.error} text-sm`}>{errors.specialization?.message}</p>
            )}
          </div>

          <div className="space-y-3">
            <Label htmlFor="experience" className={`${colors.textPrimary} font-medium`}>Experience (Years)</Label>
            <Input
              id="experience"
              type="number"
              min="0"
              max="100"
              step="0.5"
              placeholder="Years of experience"
              {...register("experience", { valueAsNumber: true })}
              className={classes.input}
            />
            {errors.experience && (
              <p className={`${colors.error} text-sm`}>{errors.experience?.message}</p>
            )}
          </div>

          <div className="space-y-3">
            <Label className={`${colors.textPrimary} font-medium`}>Schedule Type</Label>
            <Controller
              name="scheduleType"
              control={control}
              render={({ field }) => (
                <div className="grid grid-cols-2 gap-3">
                  {["WEEKLY", "CUSTOM"].map((type) => (
                    <Button
                      key={type}
                      type="button"
                      onClick={() => field.onChange(type)}
                      className={`h-12 rounded-lg font-medium transition-all duration-200 ${
                        field.value === type 
                          ? classes.primaryButton 
                          : classes.secondaryButton
                      }`}
                    >
                      {type.charAt(0) + type.slice(1).toLowerCase()}
                    </Button>
                  ))}
                </div>
              )}
            />
            {errors.scheduleType && (
              <p className={`${colors.error} text-sm`}>{errors.scheduleType?.message}</p>
            )}
          </div>
        </div>

        {/* Right Column - Domain, Sub-Domains, Tags */}
        <div className="space-y-6">
          <div className="space-y-3">
            <Label htmlFor="domain" className={`${colors.textPrimary} font-medium`}>Domain</Label>
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
                  <SelectTrigger className={`${colors.inputBg} ${colors.inputBorder} ${colors.textPrimary} h-12 rounded-lg ${colors.inputFocus}`}>
                    <SelectValue placeholder="Select your domain" className={colors.textSecondary} />
                  </SelectTrigger>
                  <SelectContent className={classes.dropdown}>
                    {domains.map((domain) => (
                      <SelectItem key={domain.id} value={domain.id!} className={classes.dropdownItem}>
                        {domain.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.domain && (
              <p className={`${colors.error} text-sm`}>{errors.domain?.message}</p>
            )}
          </div>

          <div className="space-y-3">
            <Label className={`${colors.textPrimary} font-medium`}>Sub-Domains</Label>
            <Controller
              name="subDomains"
              control={control}
              render={({ field }) => (
                <div className={`space-y-3 max-h-48 overflow-y-auto p-4 ${colors.glassBg} ${colors.glassBorder} rounded-lg`}>
                  {filteredSubDomains.map((subDomain) => (
                    <div key={subDomain.id} className={`flex items-center space-x-3 p-2 rounded-lg hover:${colors.secondaryBg} transition-colors`}>
                      <Checkbox
                        id={`subDomain-${subDomain.id}`}
                        checked={
                          field.value?.some((sd) => sd.id === subDomain.id) ?? false
                        }
                        onCheckedChange={(checked) => {
                          const updatedSubDomains = checked
                            ? [...(field.value ?? []), subDomain]
                            : (field.value ?? []).filter(
                                (sd) => sd.id !== subDomain.id,
                              );
                          field.onChange(updatedSubDomains);
                        }}
                        className={classes.checkbox}
                      />
                      <Label htmlFor={`subDomain-${subDomain.id}`} className={`${colors.textPrimary} cursor-pointer text-sm`}>
                        {subDomain.name}
                      </Label>
                    </div>
                  ))}
                  {filteredSubDomains.length === 0 && (
                    <p className={`${colors.textMuted} text-sm italic text-center py-4`}>No sub-domains available for selected domain</p>
                  )}
                </div>
              )}
            />
            {errors.subDomains && (
              <p className={`${colors.error} text-sm`}>{errors.subDomains?.message}</p>
            )}
          </div>

          <div className="space-y-3">
            <Label className={`${colors.textPrimary} font-medium`}>Tags</Label>
            <Controller
              name="tags"
              control={control}
              render={({ field }) => (
                <div className={`space-y-3 max-h-48 overflow-y-auto p-4 ${colors.glassBg} ${colors.glassBorder} rounded-lg`}>
                  {filteredTags.map((tag) => (
                    <div key={tag.id} className={`flex items-center space-x-3 p-2 rounded-lg hover:${colors.secondaryBg} transition-colors`}>
                      <Checkbox
                        id={`tag-${tag.id}`}
                        checked={field.value?.some((t) => t.id === tag.id) ?? false}
                        onCheckedChange={(checked) => {
                          const updatedTags = checked
                            ? [...(field.value ?? []), tag]
                            : (field.value ?? []).filter((t) => t.id !== tag.id);
                          field.onChange(updatedTags);
                        }}
                        className={classes.checkbox}
                      />
                      <Label htmlFor={`tag-${tag.id}`} className={`${colors.textPrimary} cursor-pointer text-sm`}>{tag.name}</Label>
                    </div>
                  ))}
                  {filteredTags.length === 0 && (
                    <p className={`${colors.textMuted} text-sm italic text-center py-4`}>No tags available for selected domain</p>
                  )}
                </div>
              )}
            />
            {errors.tags && <p className={`${colors.error} text-sm`}>{errors.tags?.message}</p>}
          </div>
        </div>
      </div>


      <div className="flex justify-between gap-4 pt-6">
        <Button 
          type="button" 
          onClick={onBack} 
          className={`flex-1 h-12 ${classes.secondaryButton}`}
        >
          ← Back
        </Button>
        <Button 
          type="submit" 
          className={`flex-1 h-12 ${classes.primaryButton}`}
        >
          Next Step →
        </Button>
      </div>
    </form>
  );
};

export default ConsultantProfileForm;
