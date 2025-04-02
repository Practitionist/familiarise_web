"use client";

import { TopicsComponent } from "@/components/topics-component";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { WebinarPlanSchema } from "@/schemas/PlanSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { PlannerService } from "../services/planner";
import { WebinarEvent, WebinarPlannerProps } from "../types/event";

export function EventPlannerForWebinar({
  isOpen,
  onClose,
  onSave,
  initialData,
  isSaving: externalIsSaving,
  consultantId,
}: Readonly<WebinarPlannerProps>) {
  const [internalIsSaving, setInternalIsSaving] = useState(false);
  const [newOutcome, setNewOutcome] = useState("");
  const [newTopic, setNewTopic] = useState("");
  const [suggestedTopics, setSuggestedTopics] = useState<
    { id: string; name: string }[]
  >([]);
  const [showTopicSuggestions, setShowTopicSuggestions] = useState(false);
  const [availableTopics, setAvailableTopics] = useState<
    { id: string; name: string; createdAt: Date; updatedAt: Date }[]
  >([]);
  const [isLoadingTopics, setIsLoadingTopics] = useState(false);
  const topicInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // Use either external or internal saving state
  const isSaving = externalIsSaving ?? internalIsSaving;

  // Helper function to format datetime-local input
  const formatDateTimeForInput = (date?: Date | string | null) => {
    if (!date) {
      // Default to current time + 1 hour, rounded to nearest 30 min
      const now = new Date();
      now.setHours(now.getHours() + 1);
      now.setMinutes(Math.ceil(now.getMinutes() / 30) * 30);
      now.setSeconds(0);
      now.setMilliseconds(0);
      return now.toISOString().slice(0, 16);
    } 
    
    // Convert to date object if it's a string
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return dateObj.toISOString().slice(0, 16);
  };

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

  // Close topic suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        topicInputRef.current &&
        !topicInputRef.current.contains(event.target as Node)
      ) {
        setShowTopicSuggestions(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Filter suggestions based on input
  useEffect(() => {
    // This effect is no longer needed as we're using the TopicsComponent
  }, []);

  // Extract scheduledAt from appointment slots if available
  const getInitialScheduledAt = (): string => {
    if (initialData?.appointment && 
        initialData.appointment.slotsOfAppointment && 
        initialData.appointment.slotsOfAppointment.length > 0) {
      const slot = initialData.appointment.slotsOfAppointment[0];
      console.log("Found existing slot for appointment:", {
        slotId: slot.id,
        startTime: slot.slotStartTimeInUTC,
        endTime: slot.slotEndTimeInUTC
      });
      return formatDateTimeForInput(slot.slotStartTimeInUTC);
    }
    return formatDateTimeForInput();
  };

  const form = useForm<z.infer<typeof WebinarPlanSchema>>({
    resolver: zodResolver(WebinarPlanSchema),
    defaultValues: {
      title: initialData?.webinarPlan?.title ?? "",
      description: initialData?.webinarPlan?.description ?? "",
      price: initialData?.webinarPlan?.price ?? 0,
      durationInHours: initialData?.webinarPlan?.durationInHours ?? 1,
      maxParticipants: initialData?.webinarPlan?.maxParticipants ?? 100,
      language: initialData?.webinarPlan?.language ?? "English",
      level: initialData?.webinarPlan?.level ?? "Beginner",
      prerequisites: initialData?.webinarPlan?.prerequisites ?? "",
      materialProvided: initialData?.webinarPlan?.materialProvided ?? "",
      learningOutcomes: initialData?.webinarPlan?.learningOutcomes ?? [],
      // Convert topics from objects to strings for the form
      // Simplify mapping: Assume topics are always objects from Prisma include
      topics: initialData?.webinarPlan?.topics?.map(topic => topic.name) ?? [],
      scheduledAt: getInitialScheduledAt(),
      consultantProfileId: consultantId,
    },
    mode: "onChange", // Validate on change for better UX
  });

  // Reset form values when initialData changes
  useEffect(() => {
    if (initialData?.webinarPlan) {
      // Reset the form with values from initialData
      form.reset({
        title: initialData.webinarPlan.title,
        description: initialData.webinarPlan.description || "",
        price: initialData.webinarPlan.price,
        durationInHours: initialData.webinarPlan.durationInHours,
        maxParticipants: initialData.webinarPlan.maxParticipants,
        language: initialData.webinarPlan.language || "English",
        level: initialData.webinarPlan.level || "Beginner",
        prerequisites: initialData.webinarPlan.prerequisites || "",
        materialProvided: initialData.webinarPlan.materialProvided || "",
        learningOutcomes: initialData.webinarPlan.learningOutcomes || [],
        topics: initialData.webinarPlan.topics?.map(topic => topic.name) || [],
        scheduledAt: getInitialScheduledAt(),
        consultantProfileId: consultantId,
      });
    }
  }, [initialData, form, consultantId]);

  const addLearningOutcome = () => {
    if (newOutcome.trim() === "") return;
    const currentOutcomes = form.getValues("learningOutcomes") || [];

    // Check for duplicates (case-insensitive)
    const isDuplicate = currentOutcomes.some(
      (outcome) =>
        outcome.trim().toLowerCase() === newOutcome.trim().toLowerCase(),
    );

    if (isDuplicate) {
      form.setError("learningOutcomes", {
        type: "manual",
        message: "This learning outcome already exists",
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

  const addTopic = (topicName: string = newTopic) => {
    if (topicName.trim() === "") return;
    const currentTopics = form.getValues("topics") || [];

    // Check for duplicates (case-insensitive)
    const isDuplicate = currentTopics.some(
      (topic) => topic.trim().toLowerCase() === topicName.trim().toLowerCase(),
    );

    if (isDuplicate) {
      form.setError("topics", {
        type: "manual",
        message: "This topic already exists",
      });
      return;
    }

    // Add the new topic
    form.setValue("topics", [...currentTopics, topicName], {
      shouldValidate: true,
    });

    // Clear input and hide suggestions
    setNewTopic("");
    setShowTopicSuggestions(false);
  };

  const removeTopic = (index: number) => {
    const currentTopics = form.getValues("topics") || [];
    form.setValue(
      "topics",
      currentTopics.filter((_, i) => i !== index),
      { shouldValidate: true },
    );
  };

  const handleTopicKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTopic();
    } else if (e.key === "ArrowDown" && suggestedTopics.length > 0) {
      e.preventDefault();
      // Focus the first suggestion if possible
      const suggestionsElement = suggestionsRef.current;
      if (suggestionsElement) {
        const firstSuggestion = suggestionsElement.querySelector("button");
        if (firstSuggestion) {
          (firstSuggestion).focus();
        }
      }
    }
  };

  const handleFormSubmit = form.handleSubmit(
    async (formData) => {
      try {
        setInternalIsSaving(true);
        console.log(
          "EventPlannerForWebinar - Form data:",
          JSON.stringify(formData, null, 2),
        );

        // Check for duplicate title
        const title = formData.title;
        const planId = initialData?.webinarPlan?.id || "";

        try {
          const isDuplicate = await PlannerService.checkDuplicateTitle(
            title,
            consultantId,
            "webinar",
            planId,
          );

          if (isDuplicate) {
            toast({
              title: "Duplicate Title",
              description: `A webinar with title "${title}" already exists. Please use a different title.`,
              variant: "destructive",
            });
            // Set field error directly in the form
            form.setError("title", {
              type: "manual",
              message:
                "This title is already in use. Please choose a different title.",
            });
            setInternalIsSaving(false);
            return;
          }
        } catch (error) {
          console.error("Error checking for duplicate title:", error);
          // Continue with validation - the service layer will also check for duplicates
        }

        // Validate form data using Zod
        const validation = WebinarPlanSchema.safeParse(formData);

        if (!validation.success) {
          const errors = validation.error.errors.reduce(
            (acc, error) => {
              const path = error.path.join(".");
              acc[path] = error.message;
              return acc;
            },
            {} as Record<string, string>,
          );

          console.error("Validation errors:", errors);
          toast({
            title: "Validation Error",
            description: "Please fix the form errors before submitting",
            variant: "destructive",
          });
          return;
        }

        const now = new Date();

        const webinarData: Partial<WebinarEvent> = {
          type: "webinar" as const,
          id: initialData?.id, // Include the webinar instance ID if we're editing
          webinarPlan: {
            id: initialData?.webinarPlan?.id ?? "",
            title: formData.title,
            description: formData.description || "",
            price: formData.price,
            durationInHours: formData.durationInHours,
            maxParticipants: formData.maxParticipants,
            language: formData.language,
            level: formData.level,
            prerequisites: formData.prerequisites ?? null,
            materialProvided: formData.materialProvided ?? null,
            learningOutcomes: formData.learningOutcomes,
            topics: formData.topics as any,
            consultantProfileId: consultantId,
            consultantProfile: null,
            createdAt: initialData?.webinarPlan?.createdAt ?? now,
            updatedAt: now,
            scheduledAt: formData.scheduledAt,
          },
        };

        console.log(
          "Calling onSave with webinar data:",
          JSON.stringify(webinarData, null, 2),
        );

        try {
          // Call onSave and wait for it to complete
          onSave(webinarData);

          // Show success toast
          toast({
            title: "Success",
            description: `${initialData ? "Updated" : "Created"} webinar "${formData.title}" successfully`,
          });
          onClose();
        } catch (error) {
          console.error("Error saving webinar:", error);
          toast({
            title: "Error",
            description:
              error instanceof Error
                ? error.message
                : "Failed to save webinar. Please try again.",
            variant: "destructive",
          });
          throw error; // Re-throw to prevent form from closing
        }
      } catch (error) {
        console.error("Error in handleFormSubmit:", error);
        toast({
          title: "Error",
          description:
            error instanceof Error
              ? error.message
              : "Failed to save webinar. Please try again.",
          variant: "destructive",
        });
      } finally {
        setInternalIsSaving(false);
      }
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

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {initialData ? "Edit" : "Create New"} Webinar
          </DialogTitle>
          <DialogDescription>
            {initialData
              ? "Update the details of your webinar."
              : "Fill in the details to create a new webinar."}
          </DialogDescription>
        </DialogHeader>
        <Card className="border-0 shadow-none">
          <CardContent className="p-0">
            <Form {...form}>
              <form onSubmit={handleFormSubmit} className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Title</FormLabel>
                        <FormControl>
                          <Input placeholder="Webinar title" {...field} />
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
                          <Input placeholder="Language" {...field} />
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
                          <Input
                            placeholder="Beginner, Intermediate, Advanced"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="price"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Price</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            placeholder="0"
                            {...field}
                            onChange={(e) =>
                              field.onChange(Number.parseFloat(e.target.value))
                            }
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="maxParticipants"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Maximum Participants</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            placeholder="10"
                            {...field}
                            onChange={(e) =>
                              field.onChange(Number.parseInt(e.target.value))
                            }
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="durationInHours"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Duration (hours)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            placeholder="1"
                            step="0.5"
                            {...field}
                            onChange={(e) =>
                              field.onChange(Number.parseFloat(e.target.value))
                            }
                          />
                        </FormControl>
                        <FormDescription>
                          Must be in 30-minute increments (0.5, 1, 1.5, etc.)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="scheduledAt"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Scheduled Date & Time</FormLabel>
                        <FormControl>
                          <Input type="datetime-local" {...field} />
                        </FormControl>
                        <FormDescription>
                          Must be at least 1 hour in the future and start at :00
                          or :30
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Describe your webinar"
                          className="min-h-[120px]"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="prerequisites"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Prerequisites</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Any prerequisites for attendees"
                            className="min-h-[100px]"
                            {...field}
                            value={field.value || ""}
                          />
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
                        <FormLabel>Materials Provided</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Materials that will be provided"
                            className="min-h-[100px]"
                            {...field}
                            value={field.value || ""}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

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
                            key={index}
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

                <DialogFooter className="mt-6 pt-4 border-t">
                  <Button
                    type="submit"
                    disabled={isSaving}
                    className="min-w-[100px]"
                  >
                    {isSaving ? "Saving..." : "Save"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </CardContent>
        </Card>
      </DialogContent>
    </Dialog>
  );
}
