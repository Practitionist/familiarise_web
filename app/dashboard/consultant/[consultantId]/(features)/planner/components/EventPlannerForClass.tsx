"use client";

import { TopicsComponent } from "@/components/topics-component";
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { ClassContentSchema, ClassPlanSchema } from "@/schemas/PlanSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
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
  // State to track form errors
  const [contentErrors, setContentErrors] = useState<{ [key: string]: string }>(
    {},
  );
  const [internalIsSaving, setInternalIsSaving] = useState(false);
  const [newOutcome, setNewOutcome] = useState("");
  const [availableTopics, setAvailableTopics] = useState<
    { id: string; name: string; createdAt: Date; updatedAt: Date }[]
  >([]);
  const [isLoadingTopics, setIsLoadingTopics] = useState(false);
  const { toast } = useToast();

  // Use either external or internal saving state
  const isSaving = externalIsSaving ?? internalIsSaving;

  // Load topic names when component mounts or initialData changes
  useEffect(() => {
    const loadTopicNames = async () => {
      if (initialData?.classPlan.topics) {
        // Assuming topics is an array of topic names
        // You might want to fetch topic details from the API
      }
    };
    loadTopicNames();
  }, [initialData]);

  // Define form for class plan
  const form = useForm({
    resolver: zodResolver(ClassPlanSchema),
    defaultValues: initialData
      ? {
          title: initialData.classPlan.title,
          description: initialData.classPlan.description ?? "",
          price: initialData.classPlan.price,
          durationInMonths: initialData.classPlan.durationInMonths,
          maxParticipants: initialData.classPlan.maxParticipants,
          language: initialData.classPlan.language ?? "English",
          level: initialData.classPlan.level ?? "Beginner",
          prerequisites: initialData.classPlan.prerequisites ?? "",
          materialProvided: initialData.classPlan.materialProvided ?? "",
          learningOutcomes: initialData.classPlan.learningOutcomes,
          topics: initialData.classPlan.topics?.map((topic) => 
            typeof topic === "string" ? topic : topic.name
          ) || [],
          certificateProvided: initialData.classPlan.certificateProvided,
          callsPerWeek: initialData.classPlan.callsPerWeek,
          videoMeetings: initialData.classPlan.videoMeetings,
          emailSupport: initialData.classPlan.emailSupport,
          consultantProfileId: initialData.classPlan.consultantProfileId,
          classContents: initialData.classPlan.classContents,
        }
      : {
          title: "",
          description: "",
          price: 0,
          durationInMonths: 1,
          maxParticipants: 100,
          language: "English",
          level: "Beginner",
          prerequisites: "",
          materialProvided: "",
          learningOutcomes: [],
          topics: [],
          certificateProvided: false,
          callsPerWeek: 1,
          videoMeetings: 1,
          emailSupport: "GENERAL" as const,
          classContents: [],
        },
    mode: "onChange",
  });

  // Reset form values when initialData changes
  useEffect(() => {
    if (initialData && initialData.classPlan) {
      // Reset the form with values from initialData
      form.reset({
        title: initialData.classPlan.title,
        description: initialData.classPlan.description ?? "",
        price: initialData.classPlan.price,
        durationInMonths: initialData.classPlan.durationInMonths,
        maxParticipants: initialData.classPlan.maxParticipants,
        language: initialData.classPlan.language ?? "English",
        level: initialData.classPlan.level ?? "Beginner",
        prerequisites: initialData.classPlan.prerequisites ?? "",
        materialProvided: initialData.classPlan.materialProvided ?? "",
        learningOutcomes: initialData.classPlan.learningOutcomes,
        topics: initialData.classPlan.topics?.map((topic) => 
          typeof topic === "string" ? topic : topic.name
        ) || [],
        certificateProvided: initialData.classPlan.certificateProvided,
        callsPerWeek: initialData.classPlan.callsPerWeek,
        videoMeetings: initialData.classPlan.videoMeetings,
        emailSupport: initialData.classPlan.emailSupport,
        consultantProfileId: initialData.classPlan.consultantProfileId,
        classContents: initialData.classPlan.classContents,
      });
    }
  }, [initialData, form, consultantId]);

  // Type guard to check if form data has classContents
  function isClassFormData(data: any): data is { classContents: any[] } {
    return data && Array.isArray(data.classContents);
  }

  // Run validation on form values whenever they change
  useEffect(() => {
    if (form.formState.isSubmitted) {
      const formValues = form.getValues();
      if (isClassFormData(formValues)) {
        setContentErrors(
          PlannerService.validateClassContents(formValues.classContents),
        );
      }
    }
  }, [form.watch("classContents"), form]);

  // Validate class contents when dialog opens
  useEffect(() => {
    if (isOpen) {
      // Check and validate class contents
      const formValues = form.getValues();
      if (isClassFormData(formValues)) {
        setContentErrors(
          PlannerService.validateClassContents(formValues.classContents),
        );
      }
    }
  }, [isOpen, form]);

  // Clear errors when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setContentErrors({});
    }
  }, [isOpen]);

  // Initialize planType in a type-safe way
  useEffect(() => {
    // Use setValue with type casting for safety
    (form as any).setValue("planType", "class");
  }, [form]);

  // Fetch available topics from API
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

  // Form submission handler
  const handleFormSubmit = form.handleSubmit(
    async (formData) => {
      try {
        console.log(
          "Class form submission data:",
          JSON.stringify(formData, null, 2),
        );
        console.log("Form validation errors:", form.formState.errors);

        // Check for duplicate title
        const title = formData.title;
        const planId = initialData?.classPlan?.id || "";

        try {
          const isDuplicate = await PlannerService.checkDuplicateTitle(
            title,
            consultantId,
            "class",
            planId,
          );

          if (isDuplicate) {
            toast({
              title: "Duplicate Title",
              description: `A class with title "${title}" already exists. Please use a different title.`,
              variant: "destructive",
            });
            // Set field error directly in the form
            form.setError("title", {
              type: "manual",
              message:
                "This title is already in use. Please choose a different title.",
            });
            return;
          }
        } catch (error) {
          console.error("Error checking for duplicate title:", error);
          // Continue with validation - the service layer will also check for duplicates
        }

        // Check if classContents exists and validate using Zod
        if (
          !Array.isArray(formData.classContents) ||
          formData.classContents.length === 0
        ) {
          toast({
            title: "Error",
            description: "Please add at least one class content item",
            variant: "destructive",
          });
          return;
        }

        // Validate all class contents using Zod
        const contentValidation = z
          .array(ClassContentSchema)
          .safeParse(formData.classContents);

        if (!contentValidation.success) {
          const errors = contentValidation.error.errors.reduce(
            (acc, error) => {
              const path = error.path.join(".");
              acc[path] = error.message;
              return acc;
            },
            {} as Record<string, string>,
          );

          setContentErrors(errors);
          toast({
            title: "Validation Error",
            description: "Please fix errors in Class Contents before saving",
            variant: "destructive",
          });
          return;
        }

        // If we reach here, proceed with submission
        setInternalIsSaving(true);

        const now = new Date();
        const classContents = formData.classContents || [];

        // Format the topics correctly
        const formattedTopics = formData.topics.map((topicName) => ({
          id: "", // The API/service will handle assigning actual IDs
          name: topicName,
          createdAt: now,
          updatedAt: now,
        }));

        const classData: Partial<ClassEvent> = {
          type: "class" as const,
          id: initialData?.id,
          classPlan: {
            id: initialData?.classPlan?.id ?? "",
            title: formData.title,
            description: formData.description || "",
            price: formData.price,
            durationInMonths: formData.durationInMonths,
            maxParticipants: formData.maxParticipants,
            language: formData.language,
            level: formData.level,
            prerequisites: formData.prerequisites ?? null,
            materialProvided: formData.materialProvided ?? null,
            learningOutcomes: formData.learningOutcomes,
            topics: formattedTopics,
            consultantProfileId: consultantId,
            consultantProfile: null,
            certificateProvided: formData.certificateProvided,
            callsPerWeek: formData.callsPerWeek,
            videoMeetings: formData.videoMeetings,
            emailSupport: formData.emailSupport,
            classContents: classContents.map((content: any, index: number) => ({
              id: content.id || `temp-${index}`,
              title: content.title,
              description: content.description,
              contentType: content.contentType || null,
              contentUrl: content.contentUrl || null,
              order: content.order,
              hoursAllotted: content.hoursAllotted,
              createdAt: now,
              updatedAt: now,
              classPlanId: initialData?.classPlan?.id ?? "",
            })),
            createdAt: initialData?.classPlan?.createdAt ?? now,
            updatedAt: now,
          },
        };

        console.log(
          "Calling onSave with class data:",
          JSON.stringify(classData, null, 2),
        );

        try {
          // Call onSave and wait for it to complete
          onSave(classData);

          // If we get here, the save was successful
          toast({
            title: "Success",
            description: `${initialData ? "Updated" : "Created"} class "${formData.title}" successfully`,
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
          throw error; // Re-throw to prevent form from closing
        }
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
    },
    (errors) => {
      // This function runs if validation fails
      console.log("Form validation failed with errors:", errors);
      toast({
        title: "Validation Error",
        description: "Please check the form for errors",
        variant: "destructive",
      });
    },
  );

  const addLearningOutcome = () => {
    if (newOutcome.trim() === "") return;
    const currentOutcomes = form.getValues("learningOutcomes") || [];

    // Check for duplicates (case-insensitive)
    const isDuplicate = currentOutcomes.some(
      (outcome) =>
        outcome.trim().toLowerCase() === newOutcome.trim().toLowerCase(),
    );

    if (isDuplicate) {
      toast({
        title: "Duplicate",
        description: "This learning outcome already exists",
        variant: "destructive",
      });
      return;
    }

    form.setValue("learningOutcomes", [...currentOutcomes, newOutcome], {
      shouldValidate: true,
    });
    setNewOutcome("");
  };

  const removeLearningOutcome = (index: number) => {
    const currentOutcomes = form.getValues("learningOutcomes") || [];
    form.setValue(
      "learningOutcomes",
      currentOutcomes.filter((_, i) => i !== index),
      { shouldValidate: true },
    );
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        // Clear errors when dialog is closed
        if (!open) {
          setContentErrors({});
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initialData ? "Edit" : "Create New"} Class</DialogTitle>
          <DialogDescription>
            {initialData
              ? "Update the details of your class."
              : "Fill in the details to create a new class."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={handleFormSubmit} className="space-y-8">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
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
                    <Textarea {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="price"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Price</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
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
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="maxParticipants"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max Participants</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...field}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="language"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Language</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="level"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Level</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="prerequisites"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Prerequisites</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="materialProvided"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Material Provided</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="learningOutcomes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Learning Outcomes</FormLabel>
                  <div className="flex gap-2 mb-2">
                    <Input
                      placeholder="Add a learning outcome"
                      value={newOutcome}
                      onChange={(e) => setNewOutcome(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addLearningOutcome();
                        }
                      }}
                    />
                    <Button type="button" onClick={addLearningOutcome}>
                      Add
                    </Button>
                  </div>
                  <div className="space-y-2 mt-2">
                    {field.value?.map((outcome, index) => (
                      <div
                        key={`learning-outcome-${outcome}-${index}`}
                        className="flex items-center gap-2 p-2 border rounded-md"
                      >
                        <span className="flex-1">{outcome}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeLearningOutcome(index)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="certificateProvided"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Certificate Provided</FormLabel>
                  <Select
                    onValueChange={(value) => field.onChange(value === "true")}
                    defaultValue={field.value ? "true" : "false"}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select certificate option" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="true">Yes</SelectItem>
                      <SelectItem value="false">No</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="callsPerWeek"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Calls Per Week</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="videoMeetings"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Video Meetings</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="emailSupport"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email Support</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select email support level" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="GENERAL">General</SelectItem>
                      <SelectItem value="PRIORITY">Priority</SelectItem>
                      <SelectItem value="DEDICATED">Dedicated</SelectItem>
                    </SelectContent>
                  </Select>
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
                    <TopicsComponent
                      initialTopics={field.value}
                      onTopicsChange={(topics) => {
                        field.onChange(topics);
                      }}
                      availableTopics={availableTopics}
                      isLoading={isLoadingTopics}
                      label="Topics"
                      error={form.formState.errors.topics?.message}
                      helpText="Select from existing topics or create new ones"
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="classContents"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Class Contents</FormLabel>
                  <div className="space-y-4">
                    {(field.value ?? []).map((content) => (
                      <div
                        key={`content-${content.id || content.title}-${content.order}`}
                        className="grid grid-cols-2 gap-4 p-4 border rounded-lg"
                      >
                        <FormField
                          control={form.control}
                          name={`classContents.${content.order}.title`}
                          render={({ field: contentField }) => (
                            <FormItem>
                              <FormLabel>
                                Title <span className="text-red-500">*</span>
                              </FormLabel>
                              <FormControl>
                                <Input
                                  {...contentField}
                                  className={
                                    contentErrors[
                                      `classContents.${content.order}.title`
                                    ]
                                      ? "border-red-500"
                                      : ""
                                  }
                                />
                              </FormControl>
                              {contentErrors[
                                `classContents.${content.order}.title`
                              ] && (
                                <p className="text-sm font-medium text-red-500">
                                  {
                                    contentErrors[
                                      `classContents.${content.order}.title`
                                    ]
                                  }
                                </p>
                              )}
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`classContents.${content.order}.description`}
                          render={({ field: contentField }) => (
                            <FormItem>
                              <FormLabel>
                                Description{" "}
                                <span className="text-red-500">*</span>
                              </FormLabel>
                              <FormControl>
                                <Textarea
                                  {...contentField}
                                  placeholder="Enter a description (required)"
                                  className={
                                    contentErrors[
                                      `classContents.${content.order}.description`
                                    ]
                                      ? "border-red-500"
                                      : ""
                                  }
                                />
                              </FormControl>
                              {contentErrors[
                                `classContents.${content.order}.description`
                              ] ? (
                                <p className="text-sm font-medium text-red-500">
                                  {
                                    contentErrors[
                                      `classContents.${content.order}.description`
                                    ]
                                  }
                                </p>
                              ) : (
                                <p className="text-sm text-muted-foreground">
                                  This field is required
                                </p>
                              )}
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`classContents.${content.order}.contentType`}
                          render={({ field: contentField }) => (
                            <FormItem>
                              <FormLabel>Content Type</FormLabel>
                              <FormControl>
                                <Input
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
                          name={`classContents.${content.order}.contentUrl`}
                          render={({ field: contentField }) => (
                            <FormItem>
                              <FormLabel>Content URL</FormLabel>
                              <FormControl>
                                <Input
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
                          name={`classContents.${content.order}.order`}
                          render={({ field: contentField }) => (
                            <FormItem>
                              <FormLabel>
                                Order <span className="text-red-500">*</span>
                              </FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  {...contentField}
                                  className={
                                    contentErrors[
                                      `classContents.${content.order}.order`
                                    ]
                                      ? "border-red-500"
                                      : ""
                                  }
                                />
                              </FormControl>
                              {contentErrors[
                                `classContents.${content.order}.order`
                              ] && (
                                <p className="text-sm font-medium text-red-500">
                                  {
                                    contentErrors[
                                      `classContents.${content.order}.order`
                                    ]
                                  }
                                </p>
                              )}
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`classContents.${content.order}.hoursAllotted`}
                          render={({ field: contentField }) => (
                            <FormItem>
                              <FormLabel>
                                Hours Allotted{" "}
                                <span className="text-red-500">*</span>
                              </FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  {...contentField}
                                  className={
                                    contentErrors[
                                      `classContents.${content.order}.hoursAllotted`
                                    ]
                                      ? "border-red-500"
                                      : ""
                                  }
                                />
                              </FormControl>
                              {contentErrors[
                                `classContents.${content.order}.hoursAllotted`
                              ] && (
                                <p className="text-sm font-medium text-red-500">
                                  {
                                    contentErrors[
                                      `classContents.${content.order}.hoursAllotted`
                                    ]
                                  }
                                </p>
                              )}
                            </FormItem>
                          )}
                        />
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => {
                            const newContents = [...(field.value ?? [])];
                            newContents.splice(content.order, 1);
                            field.onChange(newContents);

                            // Clear any errors for this content
                            const newErrors = { ...contentErrors };
                            Object.keys(newErrors).forEach((key) => {
                              if (
                                key.startsWith(`classContents.${content.order}`)
                              ) {
                                delete newErrors[key];
                              }
                            });
                            setContentErrors(newErrors);
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      onClick={() => {
                        const currentContents = field.value ?? [];
                        const newContent = {
                          title: "",
                          description: "",
                          contentType: "",
                          contentUrl: "",
                          order: currentContents.length + 1,
                          hoursAllotted: 1,
                        };
                        field.onChange([...currentContents, newContent]);

                        // Immediately validate the new content
                        setTimeout(() => {
                          setContentErrors(
                            PlannerService.validateClassContents([
                              ...currentContents,
                              newContent,
                            ]),
                          );
                        }, 100);
                      }}
                    >
                      Add Class Content
                    </Button>
                  </div>
                  {field.value && field.value.length === 0 && (
                    <p className="text-sm text-muted-foreground mt-2">
                      Add at least one class content to define the structure of
                      your class.
                    </p>
                  )}
                </FormItem>
              )}
            />

            <DialogFooter className="mt-6 pt-4 border-t">
              <Button
                type="submit"
                disabled={isSaving || Object.keys(contentErrors).length > 0}
                className="min-w-[100px]"
              >
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
