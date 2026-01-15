"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  FileText,
  DollarSign,
  Settings,
  GraduationCap,
  Calendar,
  BookOpen,
  Trash2,
  Plus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { ClassPlanSchema } from "@/schemas/plans";

import {
  FormSection,
  LearningOutcomesField,
  PriceField,
  LanguageLevelFields,
  SubmitButton,
  FormConfirmationDialog,
} from "./form-fields";
import { TopicsMultiSelect } from "./TopicsMultiSelect";
import { PlannerService } from "../services/planner";
import { ClassEvent, ClassPlannerProps } from "../types/event";

export function EventPlannerForClass({
  isOpen,
  onClose,
  onSave,
  initialData,
  isSaving: externalIsSaving,
  consultantId,
}: Readonly<ClassPlannerProps>) {
  const [internalIsSaving, setInternalIsSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [availableTopics, setAvailableTopics] = useState<
    { id: string; name: string; createdAt: Date; updatedAt: Date }[]
  >([]);
  const [isLoadingTopics, setIsLoadingTopics] = useState(false);
  const { toast } = useToast();

  const isSaving = externalIsSaving ?? internalIsSaving;

  // Fetch available topics
  useEffect(() => {
    const fetchTopics = async () => {
      try {
        setIsLoadingTopics(true);
        const fetchedTopics = await PlannerService.getTopics("");
        setAvailableTopics(fetchedTopics);
      } catch (error) {
        console.error("Failed to fetch topics:", error);
        toast({
          title: "Error",
          description: "Failed to load topics. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsLoadingTopics(false);
      }
    };

    if (isOpen) {
      fetchTopics();
    }
  }, [isOpen, toast]);

  const form = useForm({
    resolver: zodResolver(ClassPlanSchema),
    defaultValues: initialData?.classPlan
      ? {
          title: initialData.classPlan.title,
          description: initialData.classPlan.description ?? "",
          price: initialData.classPlan.price,
          priceCurrency: initialData.classPlan.priceCurrency ?? "INR",
          durationInMonths: initialData.classPlan.durationInMonths,
          maxParticipants: initialData.classPlan.maxParticipants,
          language: initialData.classPlan.language ?? "English",
          level: initialData.classPlan.level ?? "Beginner",
          prerequisites: initialData.classPlan.prerequisites ?? "",
          materialProvided: initialData.classPlan.materialProvided ?? "",
          learningOutcomes: initialData.classPlan.learningOutcomes,
          topics: initialData.classPlan.topics ?? [],
          certificateProvided: initialData.classPlan.certificateProvided,
          meetingsPerWeek: initialData.classPlan.meetingsPerWeek,
          emailSupport: initialData.classPlan.emailSupport,
          consultantProfileId: initialData.classPlan.consultantProfileId,
          classContents: initialData.classPlan.classContents ?? [],
          planType: "class",
        }
      : {
          title: "",
          description: "",
          price: 0,
          priceCurrency: "INR",
          durationInMonths: 1,
          maxParticipants: 30,
          language: "English",
          level: "Beginner",
          prerequisites: "",
          materialProvided: "",
          learningOutcomes: [],
          topics: [],
          certificateProvided: false,
          meetingsPerWeek: 2,
          emailSupport: "GENERAL" as const,
          classContents: [],
          planType: "class",
        },
    mode: "onChange",
  });

  useEffect(() => {
    if (initialData?.classPlan) {
      form.reset({
        title: initialData.classPlan.title,
        description: initialData.classPlan.description ?? "",
        price: initialData.classPlan.price,
        priceCurrency: initialData.classPlan.priceCurrency ?? "INR",
        durationInMonths: initialData.classPlan.durationInMonths,
        maxParticipants: initialData.classPlan.maxParticipants,
        language: initialData.classPlan.language ?? "English",
        level: initialData.classPlan.level ?? "Beginner",
        prerequisites: initialData.classPlan.prerequisites ?? "",
        materialProvided: initialData.classPlan.materialProvided ?? "",
        learningOutcomes: initialData.classPlan.learningOutcomes,
        topics: initialData.classPlan.topics ?? [],
        certificateProvided: initialData.classPlan.certificateProvided,
        meetingsPerWeek: initialData.classPlan.meetingsPerWeek,
        emailSupport: initialData.classPlan.emailSupport,
        consultantProfileId: initialData.classPlan.consultantProfileId,
        classContents: initialData.classPlan.classContents ?? [],
        planType: "class",
      });
    }
  }, [initialData, form, consultantId]);

  // Watch duration to calculate max topics
  const durationInMonths = form.watch("durationInMonths");
  const currentTopics = form.watch("topics");

  let maxTopics: number;
  if (durationInMonths <= 2) {
    maxTopics = 5;
  } else if (durationInMonths <= 6) {
    maxTopics = 8;
  } else {
    maxTopics = Infinity;
  }

  const currentTopicCount = currentTopics?.length ?? 0;
  const canAddMoreTopics = currentTopicCount < maxTopics;

  const handleFormSubmit = form.handleSubmit(
    async () => {
      setShowConfirmation(true);
    },
    (errors) => {
      console.log("Form validation failed with errors:", errors);
      toast({
        title: "Validation Error",
        description: "Please check the form for errors",
        variant: "destructive",
      });
    },
  );

  const handleConfirmedSubmit = async () => {
    const formData = form.getValues();

    try {
      setInternalIsSaving(true);
      setShowConfirmation(false);

      // Check for duplicate title
      const planId = initialData?.classPlan?.id ?? "";
      try {
        const isDuplicate = await PlannerService.checkDuplicateTitle(
          formData.title,
          consultantId,
          "class",
          planId,
        );

        if (isDuplicate) {
          toast({
            title: "Duplicate Title",
            description: `A class with title "${formData.title}" already exists.`,
            variant: "destructive",
          });
          form.setError("title", {
            type: "manual",
            message: "This title is already in use.",
          });
          setInternalIsSaving(false);
          return;
        }
      } catch {
        // Continue - service layer will check
      }

      const now = new Date();

      const classData: Partial<ClassEvent> = {
        type: "class" as const,
        id: initialData?.id,
        classPlan: {
          id: initialData?.classPlan?.id ?? "",
          title: formData.title,
          description: formData.description || "",
          price: formData.price,
          priceCurrency: formData.priceCurrency ?? "INR",
          durationInMonths: formData.durationInMonths,
          maxParticipants: formData.maxParticipants,
          language: formData.language ?? "English",
          level: formData.level ?? "Beginner",
          prerequisites: formData.prerequisites ?? null,
          materialProvided: formData.materialProvided ?? null,
          learningOutcomes: formData.learningOutcomes,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          topics: formData.topics as any,
          consultantProfileId: consultantId,
          consultantProfile: null,
          certificateProvided: formData.certificateProvided ?? false,
          sessionDurationInHours:
            initialData?.classPlan?.sessionDurationInHours ?? 1,
          meetingsPerWeek: formData.meetingsPerWeek,
          totalSessions: formData.meetingsPerWeek * formData.durationInMonths * 4,
          totalHours:
            formData.meetingsPerWeek *
            formData.durationInMonths *
            4 *
            (initialData?.classPlan?.sessionDurationInHours ?? 1),
          emailSupport: formData.emailSupport ?? "GENERAL",
          classContents: (formData.classContents ?? []).map((content) => ({
            ...content,
            id: content.id || "",
            createdAt: content.createdAt || now,
            updatedAt: content.updatedAt || now,
            classPlanId: content.classPlanId || "",
            contentType: content.contentType || null,
            contentUrl: content.contentUrl || null,
          })),
          createdAt: initialData?.classPlan?.createdAt ?? now,
          updatedAt: now,
        },
      };

      // Await onSave to ensure API call completes before showing success
      await onSave(classData);

      toast({
        title: "Success",
        description: `${initialData ? "Updated" : "Created"} class "${formData.title}" successfully`,
        variant: "default",
      });
      onClose();
    } catch (error) {
      console.error("Error saving class:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to save class. Please try again.",
        variant: "destructive",
      });
    } finally {
      setInternalIsSaving(false);
    }
  };

  const addClassContent = () => {
    const currentContents = form.getValues("classContents") ?? [];
    const newContent = {
      title: "",
      description: "",
      contentType: null,
      contentUrl: null,
      order: currentContents.length + 1,
      hoursAllotted: 1,
    };
    form.setValue("classContents", [...currentContents, newContent], {
      shouldValidate: true,
    });
  };

  const removeClassContent = (index: number) => {
    const currentContents = form.getValues("classContents") ?? [];
    const newContents = currentContents.filter((_, i) => i !== index);
    // Re-order remaining contents
    const reorderedContents = newContents.map((content, i) => ({
      ...content,
      order: i + 1,
    }));
    form.setValue("classContents", reorderedContents, { shouldValidate: true });
  };

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl">
              {initialData ? "Edit" : "Create New"} Class
            </DialogTitle>
            <DialogDescription>
              {initialData
                ? "Update the details of your class."
                : "Create a structured multi-session course for your students."}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={handleFormSubmit} className="space-y-6 py-4">
              {/* Basic Information Section */}
              <FormSection
                title="Basic Information"
                description="Define your class content and topics"
                icon={FileText}
              >
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Title</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g., Full-Stack Web Development Bootcamp"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        A clear, descriptive title for your class
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          value={field.value ?? ""}
                          className="min-h-[100px] resize-none"
                          placeholder="Describe what students will learn throughout this class..."
                        />
                      </FormControl>
                      <FormDescription>
                        Comprehensive overview of the class curriculum
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="topics"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <TopicsMultiSelect
                          initialTopics={field.value}
                          onTopicsChange={(topics) => field.onChange(topics)}
                          availableTopics={availableTopics}
                          isLoading={isLoadingTopics}
                          label="Topics"
                          error={form.formState.errors.topics?.message}
                          helpText={
                            isFinite(maxTopics)
                              ? `Select topics (up to ${maxTopics} based on duration). ${currentTopicCount}/${maxTopics} added.`
                              : "Select or create topics for your class"
                          }
                        />
                      </FormControl>
                      {!canAddMoreTopics && isFinite(maxTopics) && (
                        <p className="text-sm text-destructive mt-1">
                          Topic limit ({maxTopics}) reached for the selected
                          duration.
                        </p>
                      )}
                    </FormItem>
                  )}
                />
              </FormSection>

              {/* Pricing & Duration Section */}
              <FormSection
                title="Pricing & Duration"
                description="Set your class pricing and capacity"
                icon={DollarSign}
              >
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <PriceField
                    control={form.control}
                    priceName="price"
                    currencyName="priceCurrency"
                    description="Total class price"
                  />

                  <FormField
                    control={form.control}
                    name="durationInMonths"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Duration (months)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="1"
                            min="1"
                            placeholder="1"
                            {...field}
                            onChange={(e) => {
                              const value = e.target.value;
                              field.onChange(
                                value === "" ? 0 : Number.parseFloat(value),
                              );
                            }}
                          />
                        </FormControl>
                        <FormDescription>Course length</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="maxParticipants"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Max Students</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="1"
                            placeholder="30"
                            {...field}
                            onChange={(e) =>
                              field.onChange(Number.parseInt(e.target.value))
                            }
                          />
                        </FormControl>
                        <FormDescription>Class size limit</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </FormSection>

              {/* Schedule & Support Section */}
              <FormSection
                title="Schedule & Support"
                description="Define meeting frequency and support options"
                icon={Calendar}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="meetingsPerWeek"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Meetings Per Week</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="1"
                            max="7"
                            placeholder="2"
                            {...field}
                            onChange={(e) =>
                              field.onChange(Number.parseInt(e.target.value))
                            }
                          />
                        </FormControl>
                        <FormDescription>
                          Number of sessions per week
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="emailSupport"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email Support Level</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select support level" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="GENERAL">
                              General (48h response)
                            </SelectItem>
                            <SelectItem value="PRIORITY">
                              Priority (24h response)
                            </SelectItem>
                            <SelectItem value="DEDICATED">
                              Dedicated (Same day)
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormDescription>
                          Expected email response time
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </FormSection>

              {/* Session Details Section */}
              <FormSection
                title="Session Details"
                description="Language, level, and certificate options"
                icon={Settings}
              >
                <LanguageLevelFields control={form.control} />

                <FormField
                  control={form.control}
                  name="certificateProvided"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 mt-4">
                      <div className="space-y-0.5">
                        <FormLabel className="text-base">
                          Certificate of Completion
                        </FormLabel>
                        <FormDescription>
                          Provide students with a certificate upon completion
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </FormSection>

              {/* Learning Content Section */}
              <FormSection
                title="Learning Content"
                description="Define prerequisites and outcomes"
                icon={GraduationCap}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="prerequisites"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Prerequisites</FormLabel>
                        <FormControl>
                          <Textarea
                            {...field}
                            placeholder="e.g., Basic programming knowledge"
                            value={field.value ?? ""}
                            className="min-h-[80px] resize-none"
                          />
                        </FormControl>
                        <FormDescription>
                          What should students know beforehand?
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="materialProvided"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Materials Provided</FormLabel>
                        <FormControl>
                          <Textarea
                            {...field}
                            placeholder="e.g., Course slides, code repos, assignments"
                            value={field.value ?? ""}
                            className="min-h-[80px] resize-none"
                          />
                        </FormControl>
                        <FormDescription>
                          Resources you will provide
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <LearningOutcomesField
                  control={form.control}
                  name="learningOutcomes"
                  placeholder="e.g., Build full-stack web applications"
                  description="What students will be able to do after completing the class"
                />
              </FormSection>

              {/* Class Curriculum Section */}
              <FormSection
                title="Class Curriculum"
                description="Define the structure and content of your class"
                icon={BookOpen}
              >
                <FormField
                  control={form.control}
                  name="classContents"
                  render={({ field }) => (
                    <FormItem>
                      <div className="space-y-4">
                        {(field.value ?? []).map((content, index) => (
                          <div
                            key={content.id || `content-${index}`}
                            className="p-4 border rounded-lg bg-background"
                          >
                            <div className="flex items-center justify-between mb-4">
                              <span className="text-sm font-medium text-muted-foreground">
                                Module {content.order || index + 1}
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => removeClassContent(index)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <FormField
                                control={form.control}
                                name={`classContents.${index}.title`}
                                render={({ field: contentField }) => (
                                  <FormItem>
                                    <FormLabel>
                                      Title{" "}
                                      <span className="text-destructive">*</span>
                                    </FormLabel>
                                    <FormControl>
                                      <Input
                                        placeholder="e.g., Introduction to React"
                                        {...contentField}
                                      />
                                    </FormControl>
                                    <FormMessage />
                                  </FormItem>
                                )}
                              />

                              <FormField
                                control={form.control}
                                name={`classContents.${index}.hoursAllotted`}
                                render={({ field: contentField }) => (
                                  <FormItem>
                                    <FormLabel>
                                      Hours{" "}
                                      <span className="text-destructive">*</span>
                                    </FormLabel>
                                    <FormControl>
                                      <Input
                                        type="number"
                                        step="0.5"
                                        min="0.5"
                                        placeholder="1"
                                        {...contentField}
                                        onChange={(e) => {
                                          const value = e.target.value;
                                          contentField.onChange(
                                            isNaN(Number.parseFloat(value))
                                              ? 0
                                              : Number.parseFloat(value),
                                          );
                                        }}
                                      />
                                    </FormControl>
                                    <FormMessage />
                                  </FormItem>
                                )}
                              />

                              <FormField
                                control={form.control}
                                name={`classContents.${index}.description`}
                                render={({ field: contentField }) => (
                                  <FormItem className="md:col-span-2">
                                    <FormLabel>
                                      Description{" "}
                                      <span className="text-destructive">*</span>
                                    </FormLabel>
                                    <FormControl>
                                      <Textarea
                                        {...contentField}
                                        placeholder="Describe what will be covered in this module..."
                                        value={contentField.value ?? ""}
                                        className="min-h-[60px] resize-none"
                                      />
                                    </FormControl>
                                    <FormMessage />
                                  </FormItem>
                                )}
                              />

                              <FormField
                                control={form.control}
                                name={`classContents.${index}.contentType`}
                                render={({ field: contentField }) => (
                                  <FormItem>
                                    <FormLabel>Content Type</FormLabel>
                                    <FormControl>
                                      <Input
                                        placeholder="e.g., Video, Live Session"
                                        {...contentField}
                                        value={contentField.value ?? ""}
                                      />
                                    </FormControl>
                                    <FormMessage />
                                  </FormItem>
                                )}
                              />

                              <FormField
                                control={form.control}
                                name={`classContents.${index}.contentUrl`}
                                render={({ field: contentField }) => (
                                  <FormItem>
                                    <FormLabel>Resource URL</FormLabel>
                                    <FormControl>
                                      <Input
                                        placeholder="https://..."
                                        {...contentField}
                                        value={contentField.value ?? ""}
                                      />
                                    </FormControl>
                                    <FormMessage />
                                  </FormItem>
                                )}
                              />
                            </div>
                          </div>
                        ))}

                        <Button
                          type="button"
                          variant="outline"
                          className="w-full"
                          onClick={addClassContent}
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          Add Module
                        </Button>

                        {/* Error messages for classContents */}
                        {form.formState.errors.classContents?.message && (
                          <p className="text-sm font-medium text-destructive">
                            {form.formState.errors.classContents.message}
                          </p>
                        )}
                        {form.formState.errors.classContents?.root?.message && (
                          <p className="text-sm font-medium text-destructive">
                            {form.formState.errors.classContents.root.message}
                          </p>
                        )}
                      </div>
                    </FormItem>
                  )}
                />
              </FormSection>

              <DialogFooter className="pt-6 border-t">
                <Button
                  type="button"
                  variant="outline"
                  onClick={onClose}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
                <SubmitButton isLoading={isSaving}>
                  {initialData ? "Update Class" : "Create Class"}
                </SubmitButton>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <FormConfirmationDialog
        isOpen={showConfirmation}
        onConfirm={handleConfirmedSubmit}
        onCancel={() => setShowConfirmation(false)}
        title={`${initialData ? "Update" : "Create"} Class`}
        description={`You are about to ${initialData ? "update" : "create"} the class "${form.getValues("title")}". This will be immediately available for enrollment.`}
        isLoading={isSaving}
        confirmText={initialData ? "Update" : "Create"}
      />
    </>
  );
}
