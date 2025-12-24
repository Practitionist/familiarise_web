"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  FileText,
  DollarSign,
  Settings,
  GraduationCap,
  Calendar,
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
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { WebinarPlanSchema } from "@/schemas/plans";

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
import { WebinarEvent, WebinarPlannerProps } from "../types/event";

// Form-specific schema - all required fields explicitly defined
const WebinarFormSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  price: z.number().min(0, "Price must be non-negative"),
  priceCurrency: z.string().min(1, "Currency is required"),
  maxParticipants: z.number().min(1, "At least one participant is required"),
  language: z.string().min(1, "Language is required"),
  level: z.string().min(1, "Level is required"),
  prerequisites: z.string().optional().nullable(),
  materialProvided: z.string().optional().nullable(),
  learningOutcomes: z
    .array(z.string())
    .min(1, "At least one learning outcome is required"),
  topics: z.array(z.string()).min(1, "At least one topic is required"),
  consultantProfileId: z.string().optional(),
  certificateProvided: z.boolean(),
  durationInHours: z.number().min(0.5, "Duration must be at least 30 minutes"),
  scheduledAt: z.string().min(1, "Start time is required"),
});

type WebinarFormValues = z.infer<typeof WebinarFormSchema>;

export function EventPlannerForWebinar({
  isOpen,
  onClose,
  onSave,
  initialData,
  isSaving: externalIsSaving,
  consultantId,
}: Readonly<WebinarPlannerProps>) {
  const [internalIsSaving, setInternalIsSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [availableTopics, setAvailableTopics] = useState<
    { id: string; name: string; createdAt: Date; updatedAt: Date }[]
  >([]);
  const [isLoadingTopics, setIsLoadingTopics] = useState(false);
  const { toast } = useToast();

  const isSaving = externalIsSaving ?? internalIsSaving;

  // Helper function to format datetime-local input
  const formatDateTimeForInput = (date?: Date | string | null) => {
    let dateObj: Date;

    if (!date) {
      const now = new Date();
      now.setHours(now.getHours() + 1);
      now.setMinutes(Math.ceil(now.getMinutes() / 30) * 30);
      now.setSeconds(0);
      now.setMilliseconds(0);
      dateObj = now;
    } else {
      dateObj = typeof date === "string" ? new Date(date) : date;
    }

    const year = dateObj.getFullYear();
    const month = (dateObj.getMonth() + 1).toString().padStart(2, "0");
    const day = dateObj.getDate().toString().padStart(2, "0");
    const hours = dateObj.getHours().toString().padStart(2, "0");
    const minutes = dateObj.getMinutes().toString().padStart(2, "0");

    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

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

  const getInitialScheduledAt = (): string => {
    if (
      initialData?.appointment &&
      initialData.appointment.slotsOfAppointment &&
      initialData.appointment.slotsOfAppointment.length > 0
    ) {
      const slot = initialData.appointment.slotsOfAppointment[0];
      return formatDateTimeForInput(slot.startsAt);
    }
    return formatDateTimeForInput();
  };

  const form = useForm<WebinarFormValues>({
    resolver: zodResolver(WebinarFormSchema),
    defaultValues: {
      title: initialData?.webinarPlan?.title ?? "",
      description: initialData?.webinarPlan?.description ?? "",
      price: initialData?.webinarPlan?.price ?? 0,
      priceCurrency: initialData?.webinarPlan?.priceCurrency ?? "INR",
      durationInHours: initialData?.webinarPlan?.durationInHours ?? 1,
      maxParticipants: initialData?.webinarPlan?.maxParticipants ?? 100,
      language: initialData?.webinarPlan?.language ?? "English",
      level: initialData?.webinarPlan?.level ?? "Beginner",
      prerequisites: initialData?.webinarPlan?.prerequisites ?? "",
      materialProvided: initialData?.webinarPlan?.materialProvided ?? "",
      learningOutcomes: initialData?.webinarPlan?.learningOutcomes ?? [],
      certificateProvided:
        initialData?.webinarPlan?.certificateProvided ?? false,
      topics:
        initialData?.webinarPlan?.topics?.map((topic) => topic.name) ?? [],
      scheduledAt: getInitialScheduledAt(),
      consultantProfileId: consultantId,
    },
    mode: "onChange",
  });

  useEffect(() => {
    if (initialData?.webinarPlan) {
      form.reset({
        title: initialData.webinarPlan.title,
        description: initialData.webinarPlan.description ?? "",
        price: initialData.webinarPlan.price,
        priceCurrency: initialData.webinarPlan.priceCurrency ?? "INR",
        durationInHours: initialData.webinarPlan.durationInHours,
        maxParticipants: initialData.webinarPlan.maxParticipants,
        language: initialData.webinarPlan.language ?? "English",
        level: initialData.webinarPlan.level ?? "Beginner",
        prerequisites: initialData.webinarPlan.prerequisites ?? "",
        materialProvided: initialData.webinarPlan.materialProvided ?? "",
        learningOutcomes: initialData.webinarPlan.learningOutcomes ?? [],
        certificateProvided:
          initialData.webinarPlan.certificateProvided ?? false,
        topics:
          initialData.webinarPlan.topics?.map((topic) => topic.name) ?? [],
        scheduledAt: getInitialScheduledAt(),
        consultantProfileId: consultantId,
      });
    }
  }, [initialData, form, consultantId]);

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
      const planId = initialData?.webinarPlan?.id ?? "";
      try {
        const isDuplicate = await PlannerService.checkDuplicateTitle(
          formData.title,
          consultantId,
          "webinar",
          planId,
        );

        if (isDuplicate) {
          toast({
            title: "Duplicate Title",
            description: `A webinar with title "${formData.title}" already exists.`,
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

      // Validate with full schema
      const validation = WebinarPlanSchema.safeParse(formData);
      if (!validation.success) {
        toast({
          title: "Validation Error",
          description: "Please fix the form errors before submitting",
          variant: "destructive",
        });
        setInternalIsSaving(false);
        return;
      }

      const now = new Date();

      const webinarData: Partial<WebinarEvent> = {
        type: "webinar" as const,
        id: initialData?.id,
        webinarPlan: {
          id: initialData?.webinarPlan?.id ?? "",
          title: formData.title,
          description: formData.description ?? "",
          price: formData.price,
          priceCurrency: formData.priceCurrency ?? "INR",
          certificateProvided: formData.certificateProvided ?? false,
          durationInHours: formData.durationInHours,
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
          createdAt: initialData?.webinarPlan?.createdAt ?? now,
          updatedAt: now,
        },
      };

      onSave(webinarData, formData.scheduledAt);

      toast({
        title: "Success",
        description: `${initialData ? "Updated" : "Created"} webinar "${formData.title}" successfully`,
        variant: "default",
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
    } finally {
      setInternalIsSaving(false);
    }
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
              {initialData ? "Edit" : "Create New"} Webinar
            </DialogTitle>
            <DialogDescription>
              {initialData
                ? "Update the details of your webinar."
                : "Schedule a live group session for your audience."}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={handleFormSubmit} className="space-y-6 py-4">
              {/* Basic Information Section */}
              <FormSection
                title="Basic Information"
                description="Define your webinar content"
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
                          placeholder="e.g., Introduction to Machine Learning"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        A clear, engaging title for your webinar
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
                          className="min-h-[100px] resize-none"
                          placeholder="Describe what attendees will learn during this webinar..."
                        />
                      </FormControl>
                      <FormDescription>
                        Detailed overview of the webinar content
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
                          helpText="Select from existing topics or create new ones"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </FormSection>

              {/* Scheduling Section */}
              <FormSection
                title="Scheduling"
                description="Set the date, time, and duration"
                icon={Calendar}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                          Must be at least 1 hour in the future
                        </FormDescription>
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
                            step="0.5"
                            min="0.5"
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
                        <FormDescription>
                          Must be in 30-minute increments
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </FormSection>

              {/* Pricing & Capacity Section */}
              <FormSection
                title="Pricing & Capacity"
                description="Set your price and attendee limit"
                icon={DollarSign}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <PriceField
                    control={form.control}
                    priceName="price"
                    currencyName="priceCurrency"
                    description="Leave as 0 for free webinars"
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
                            min="1"
                            placeholder="100"
                            {...field}
                            onChange={(e) =>
                              field.onChange(Number.parseInt(e.target.value))
                            }
                          />
                        </FormControl>
                        <FormDescription>
                          Maximum number of attendees
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
                          Provide attendees with a certificate after the webinar
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
                          What should attendees know beforehand?
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
                            placeholder="e.g., Slides, code samples, recording"
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
                  placeholder="e.g., Understand the fundamentals of ML"
                  description="What attendees will learn from this webinar"
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
                  {initialData ? "Update Webinar" : "Create Webinar"}
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
        title={`${initialData ? "Update" : "Create"} Webinar`}
        description={`You are about to ${initialData ? "update" : "create"} the webinar "${form.getValues("title")}" scheduled for ${new Date(form.getValues("scheduledAt")).toLocaleString()}. This will be immediately available for registration.`}
        isLoading={isSaving}
        confirmText={initialData ? "Update" : "Create"}
      />
    </>
  );
}
