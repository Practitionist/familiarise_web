"use client";

import { PlanLevel } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  FileText,
  DollarSign,
  Settings,
  GraduationCap,
  Headphones,
  Upload,
  BookOpen,
  Trash2,
  Plus,
  Gift,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Checkbox } from "@/components/ui/checkbox";
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
import { SubscriptionPlanSchema } from "@/schemas/plans";

import { FormSection } from "./form-fields/FormSection";
import { PositioningSections } from "./form-fields/PositioningSections";
import { LearningOutcomesField } from "./form-fields/LearningOutcomesField";
import { PriceField } from "./form-fields/PriceField";
import { LanguageLevelFields } from "./form-fields/LanguageLevelFields";
import { SubmitButton } from "./form-fields/SubmitButton";
import { FormConfirmationDialog } from "./form-fields/FormConfirmationDialog";
import { TopicsMultiSelect } from "./TopicsMultiSelect";
import {
  SubscriptionPlanEvent,
  SubscriptionPlannerProps,
} from "@/types/planner-events";
import { PlannerService } from "../services/planner";
import { PlanMaterialsUpload } from "./PlanMaterialsUpload";

export function EventPlannerForSubscription({
  isOpen,
  onClose,
  onSave,
  initialData,
  isSaving: externalIsSaving,
  consultantId,
}: Readonly<SubscriptionPlannerProps>) {
  const [internalIsSaving, setInternalIsSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [showMaterialsDialog, setShowMaterialsDialog] = useState(false);
  const [availableTopics, setAvailableTopics] = useState<
    { id: string; name: string; createdAt?: Date; updatedAt?: Date }[]
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
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
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
    fetchTopics();
  }, [toast]);

  // State for the trial offer (kept outside the react-hook-form state)
  const [trialEnabled, setTrialEnabled] = useState(
    initialData?.subscriptionPlan?.trialEnabled ?? false,
  );
  const [trialDurationMinutes, setTrialDurationMinutes] = useState(
    initialData?.subscriptionPlan?.trialDurationMinutes ?? 30,
  );
  // Rupee text input; paise derived below. Free by default until paid-trial
  // checkout is wired (the wiring PR flips this to ₹100 with the schema).
  const [trialPriceInput, setTrialPriceInput] = useState(
    String((initialData?.subscriptionPlan?.trialPriceInPaise ?? 0) / 100),
  );
  // ₹0 is allowed but must be an explicit choice, not a default slide-through.
  const [freeTrialAcknowledged, setFreeTrialAcknowledged] = useState(false);

  const trialPriceRupees = Number(trialPriceInput);
  const trialPriceValid =
    trialPriceInput.trim() !== "" &&
    Number.isFinite(trialPriceRupees) &&
    trialPriceRupees >= 0;
  const trialPriceInPaise = trialPriceValid
    ? Math.round(trialPriceRupees * 100)
    : 0;
  const isFreeTrial = trialPriceValid && trialPriceInPaise === 0;

  // State for subscription contents/roadmap (not in Zod schema)
  const [subscriptionContents, setSubscriptionContents] = useState<
    Array<{
      id?: string;
      title: string;
      description: string;
      contentType?: string | null;
      contentUrl?: string | null;
      order: number;
      hoursAllotted: number;
      sectionLabel?: string | null;
      outcomes?: string[];
    }>
  >(initialData?.subscriptionPlan?.subscriptionContents ?? []);

  const form = useForm({
    resolver: zodResolver(SubscriptionPlanSchema),
    defaultValues: initialData?.subscriptionPlan
      ? {
          title: initialData.subscriptionPlan.title,
          description: initialData.subscriptionPlan.description ?? "",
          durationInMonths: initialData.subscriptionPlan.durationInMonths,
          price: (initialData.subscriptionPlan.price ?? 0) / 100,
          priceCurrency: initialData.subscriptionPlan.priceCurrency ?? "INR",
          sessionsPerWeek: initialData.subscriptionPlan.sessionsPerWeek,
          sessionDurationInHours:
            initialData.subscriptionPlan.sessionDurationInHours ?? 1,
          emailSupport: initialData.subscriptionPlan.emailSupport,
          language: initialData.subscriptionPlan.language ?? "English",
          level: initialData.subscriptionPlan.level ?? PlanLevel.BEGINNER,
          prerequisites: initialData.subscriptionPlan.prerequisites ?? "",
          materialProvided: initialData.subscriptionPlan.materialProvided ?? "",
          learningOutcomes: initialData.subscriptionPlan.learningOutcomes ?? [],
          topics: initialData.subscriptionPlan.topics ?? [],
          subtitle: initialData.subscriptionPlan.subtitle ?? "",
          targetAudience: initialData.subscriptionPlan.targetAudience ?? [],
          whatsIncluded: initialData.subscriptionPlan.whatsIncluded ?? [],
          faqs: initialData.subscriptionPlan.faqs ?? [],
        }
      : {
          title: "",
          description: "",
          durationInMonths: 1,
          price: 0,
          priceCurrency: "INR",
          sessionsPerWeek: 1,
          sessionDurationInHours: 1,
          emailSupport: "GENERAL" as const,
          language: "English",
          level: PlanLevel.BEGINNER,
          prerequisites: "",
          materialProvided: "",
          learningOutcomes: [],
          topics: [],
          subtitle: "",
          targetAudience: [],
          whatsIncluded: [],
          faqs: [],
        },
    mode: "onBlur",
  });

  useEffect(() => {
    if (initialData?.subscriptionPlan) {
      form.reset({
        title: initialData.subscriptionPlan.title,
        description: initialData.subscriptionPlan.description ?? "",
        durationInMonths: initialData.subscriptionPlan.durationInMonths,
        price: (initialData.subscriptionPlan.price ?? 0) / 100,
        priceCurrency: initialData.subscriptionPlan.priceCurrency ?? "INR",
        sessionsPerWeek: initialData.subscriptionPlan.sessionsPerWeek,
        sessionDurationInHours:
          initialData.subscriptionPlan.sessionDurationInHours ?? 1,
        emailSupport: initialData.subscriptionPlan.emailSupport,
        language: initialData.subscriptionPlan.language ?? "English",
        level: initialData.subscriptionPlan.level ?? PlanLevel.BEGINNER,
        prerequisites: initialData.subscriptionPlan.prerequisites ?? "",
        materialProvided: initialData.subscriptionPlan.materialProvided ?? "",
        learningOutcomes: initialData.subscriptionPlan.learningOutcomes ?? [],
        topics: initialData.subscriptionPlan.topics ?? [],
        subtitle: initialData.subscriptionPlan.subtitle ?? "",
        targetAudience: initialData.subscriptionPlan.targetAudience ?? [],
        whatsIncluded: initialData.subscriptionPlan.whatsIncluded ?? [],
        faqs: initialData.subscriptionPlan.faqs ?? [],
      });
      // Reset trial and subscription contents state
      setTrialEnabled(
        initialData.subscriptionPlan.trialEnabled ?? false,
      );
      setTrialDurationMinutes(
        initialData.subscriptionPlan.trialDurationMinutes ?? 30,
      );
      setTrialPriceInput(
        String((initialData.subscriptionPlan.trialPriceInPaise ?? 10000) / 100),
      );
      setFreeTrialAcknowledged(false);
      setSubscriptionContents(
        initialData.subscriptionPlan.subscriptionContents ?? [],
      );
    }
  }, [initialData, form]);

  const handleFormSubmit = form.handleSubmit(
    async () => {
      if (trialEnabled && !trialPriceValid) {
        toast({
          title: "Invalid trial price",
          description: "Enter a trial price of ₹0 or more.",
          variant: "destructive",
        });
        return;
      }
      // Friction, not a hard block — a ₹0 trial needs explicit confirmation.
      if (trialEnabled && isFreeTrial && !freeTrialAcknowledged) {
        toast({
          title: "Confirm free trial",
          description:
            'Tick "I understand, keep this trial free" to save a ₹0 trial.',
          variant: "destructive",
        });
        return;
      }
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
      const planId = initialData?.subscriptionPlan?.id ?? "";
      const isDuplicate = await PlannerService.checkDuplicateTitle(
        formData.title,
        consultantId,
        "subscription",
        planId,
      );

      if (isDuplicate) {
        toast({
          title: "Duplicate Title",
          description: `A subscription plan with title "${formData.title}" already exists. Please use a different title.`,
          variant: "destructive",
        });
        setInternalIsSaving(false);
        return;
      }

      const now = new Date();

      const subscriptionData: Partial<SubscriptionPlanEvent> = {
        type: "subscription" as const,
        id: initialData?.id,
        subscriptionPlan: {
          id: initialData?.subscriptionPlan?.id ?? "",
          title: formData.title,
          description: formData.description || "",
          durationInMonths: formData.durationInMonths,
          price: Math.round(formData.price * 100),
          priceCurrency: formData.priceCurrency ?? "INR",
          sessionsPerWeek: formData.sessionsPerWeek,
          emailSupport: formData.emailSupport ?? "GENERAL",
          language: formData.language ?? "English",
          level: formData.level ?? PlanLevel.BEGINNER,
          prerequisites: formData.prerequisites ?? undefined,
          materialProvided: formData.materialProvided ?? undefined,
          learningOutcomes: formData.learningOutcomes,
          topics: formData.topics ?? [],
          subtitle: formData.subtitle || null,
          targetAudience: formData.targetAudience ?? [],
          whatsIncluded: formData.whatsIncluded ?? [],
          faqs: (formData.faqs ?? []).map((faq, index) => ({
            ...faq,
            order: faq.order ?? index,
          })),
          consultantProfileId: consultantId,
          consultantProfile: null,
          subscriptions: initialData?.subscriptionPlan?.subscriptions ?? [],
          sessionDurationInHours: formData.sessionDurationInHours ?? 1,
          trialEnabled,
          trialDurationMinutes,
          trialPriceInPaise,
          subscriptionContents: subscriptionContents.map((content, index) => ({
            ...content,
            order: index + 1,
          })),
          createdAt: initialData?.subscriptionPlan?.createdAt ?? now,
          updatedAt: now,
        },
      };

      // Await onSave to ensure API call completes before showing success
      await onSave(subscriptionData);

      toast({
        title: "Success",
        description: `${initialData ? "Updated" : "Created"} subscription plan "${formData.title}" successfully`,
        variant: "default",
      });
      onClose();
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Error saving subscription plan:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to save subscription plan. Please try again.",
        variant: "destructive",
      });
    } finally {
      setInternalIsSaving(false);
    }
  };

  const activeSubscriptionsCount =
    initialData?.subscriptionPlan?.subscriptions?.length ?? 0;

  // Helper functions for subscription contents/roadmap
  const addSubscriptionContent = () => {
    const newContent = {
      title: "",
      description: "",
      contentType: null,
      contentUrl: null,
      order: subscriptionContents.length + 1,
      // Pre-fill the next week so the common case needs no typing.
      sectionLabel: `Week ${subscriptionContents.length + 1}`,
      outcomes: [],
      hoursAllotted: 1,
    };
    setSubscriptionContents([...subscriptionContents, newContent]);
  };

  const removeSubscriptionContent = (index: number) => {
    const newContents = subscriptionContents.filter((_, i) => i !== index);
    // Re-order remaining contents
    const reorderedContents = newContents.map((content, i) => ({
      ...content,
      order: i + 1,
    }));
    setSubscriptionContents(reorderedContents);
  };

  const updateSubscriptionContent = (
    index: number,
    field: string,
    value: string | number | string[] | null,
  ) => {
    const newContents = [...subscriptionContents];
    newContents[index] = { ...newContents[index], [field]: value };
    setSubscriptionContents(newContents);
  };

  return (
    <>
      <ResponsiveModal
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <ResponsiveModalContent className="max-w-3xl max-h-[90dvh] overflow-hidden flex flex-col">
          <ResponsiveModalHeader className="shrink-0">
            <ResponsiveModalTitle className="text-xl">
              {initialData ? "Edit" : "Create New"} Subscription Plan
            </ResponsiveModalTitle>
            <ResponsiveModalDescription asChild>
              <div className="text-sm text-muted-foreground">
                <p>
                  {initialData
                    ? "Update the details of your subscription plan."
                    : "Create a recurring subscription offering with scheduled calls and support."}
                </p>
                {activeSubscriptionsCount > 0 && (
                  <div className="mt-2 text-sm text-blue-600 font-medium">
                    This plan has {activeSubscriptionsCount} active
                    subscription(s).
                  </div>
                )}
              </div>
            </ResponsiveModalDescription>
          </ResponsiveModalHeader>

          <Form {...form}>
            <form onSubmit={handleFormSubmit} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-4">
              {/* Basic Information Section */}
              <FormSection
                title="Basic Information"
                description="Define your subscription offering"
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
                          placeholder="e.g., Monthly Mentorship Program"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        A clear, descriptive title for your subscription
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
                          placeholder="Describe what subscribers will receive throughout their subscription period..."
                        />
                      </FormControl>
                      <FormDescription>
                        Detailed overview of the subscription benefits
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FormSection>

              {/* Pricing & Duration Section */}
              <FormSection
                title="Pricing & Duration"
                description="Set your subscription rates and duration"
                icon={DollarSign}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <PriceField
                    control={form.control}
                    priceName="price"
                    currencyName="priceCurrency"
                    description="Total subscription price"
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
                            min="1"
                            max="24"
                            placeholder="1"
                            {...field}
                            onChange={(e) => {
                              const value = e.target.value;
                              field.onChange(
                                value === "" ? 0 : Number.parseInt(value, 10),
                              );
                            }}
                          />
                        </FormControl>
                        <FormDescription>
                          Subscription duration (1-24 months)
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </FormSection>

              {/* Support Options Section */}
              <FormSection
                title="Support Options"
                description="Define call frequency, duration, and support level"
                icon={Headphones}
              >
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="sessionsPerWeek"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Calls Per Week</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="0"
                            max="7"
                            placeholder="1"
                            {...field}
                            onChange={(e) => {
                              const value = e.target.value;
                              field.onChange(
                                value === "" ? 0 : Number.parseInt(value, 10),
                              );
                            }}
                          />
                        </FormControl>
                        <FormDescription>
                          Number of scheduled calls per week
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="sessionDurationInHours"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Session Duration (hours)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="0.5"
                            min="0.5"
                            max="4"
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
                          Duration of each call (30 min increments)
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

              {/* Trial Section */}
              <FormSection
                title="Trial Session"
                description="Offer a trial session to potential subscribers"
                icon={Gift}
              >
                <div className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">
                      Enable Trial
                    </FormLabel>
                    <FormDescription>
                      Allow potential subscribers to book a trial session
                    </FormDescription>
                  </div>
                  <Switch
                    checked={trialEnabled}
                    onCheckedChange={setTrialEnabled}
                  />
                </div>

                {trialEnabled && (
                  <>
                    <div className="mt-4">
                      <FormLabel>Trial Duration</FormLabel>
                      <Select
                        value={trialDurationMinutes.toString()}
                        onValueChange={(value) =>
                          setTrialDurationMinutes(Number.parseInt(value))
                        }
                      >
                        <SelectTrigger className="mt-2">
                          <SelectValue placeholder="Select duration" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="30">30 minutes</SelectItem>
                          <SelectItem value="45">45 minutes</SelectItem>
                          <SelectItem value="60">60 minutes</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription className="mt-2">
                        Duration of the trial session
                      </FormDescription>
                    </div>

                    <div className="mt-4">
                      <FormLabel htmlFor="trial-price">
                        Trial Price (₹)
                      </FormLabel>
                      <Input
                        id="trial-price"
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        value={trialPriceInput}
                        onChange={(e) => setTrialPriceInput(e.target.value)}
                        className="mt-2"
                      />
                      <FormDescription className="mt-2">
                        We recommend charging at least ₹100–₹200 — paid trials
                        get far fewer no-shows.
                      </FormDescription>
                    </div>

                    {isFreeTrial && (
                      <div className="mt-4 space-y-2 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20 p-4">
                        <p className="text-sm font-semibold text-amber-900 dark:text-amber-300">
                          Free trials attract no-shows and low-intent bookings
                        </p>
                        <p className="text-sm text-amber-800 dark:text-amber-300">
                          Charging even ₹100 filters for consultees who are
                          serious about subscribing.
                        </p>
                        <label
                          htmlFor="free-trial-acknowledged"
                          className="flex items-start gap-2 pt-1 text-sm font-medium text-amber-900 dark:text-amber-300"
                        >
                          <Checkbox
                            id="free-trial-acknowledged"
                            checked={freeTrialAcknowledged}
                            onCheckedChange={(checked) =>
                              setFreeTrialAcknowledged(checked === true)
                            }
                            className="mt-0.5 border-amber-600 data-[state=checked]:bg-amber-600"
                          />
                          I understand, keep this trial free
                        </label>
                      </div>
                    )}
                  </>
                )}
              </FormSection>

              {/* Session Details Section */}
              <FormSection
                title="Session Details"
                description="Language and expertise level"
                icon={Settings}
              >
                <LanguageLevelFields control={form.control} />
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
                            placeholder="e.g., 1+ years of experience in your field"
                            value={field.value ?? ""}
                            className="min-h-[80px] resize-none"
                          />
                        </FormControl>
                        <FormDescription>
                          What should subscribers know beforehand?
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
                            placeholder="e.g., Weekly resources, templates, recordings"
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
                  placeholder="e.g., Master advanced techniques in your field"
                  description="What subscribers will achieve during the subscription"
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
                          helpText="Select from existing topics or create new ones (optional)"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </FormSection>

              <PositioningSections
                control={form.control}
                offeringNoun="mentorship program"
              />

              {/* Session Roadmap Section */}
              <FormSection
                title="Session Roadmap"
                description="Define the structure and content of each session"
                icon={BookOpen}
              >
                <div className="space-y-4">
                  {subscriptionContents.map((content, index) => (
                    <div
                      key={content.id || `content-${index}`}
                      className="p-4 border rounded-lg bg-background"
                    >
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-sm font-medium text-muted-foreground">
                          Session {content.order || index + 1}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => removeSubscriptionContent(index)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <FormLabel>Section label</FormLabel>
                          <Input
                            placeholder="e.g., Week 1"
                            maxLength={40}
                            value={content.sectionLabel ?? ""}
                            onChange={(e) =>
                              updateSubscriptionContent(
                                index,
                                "sectionLabel",
                                e.target.value,
                              )
                            }
                            className="mt-2"
                          />
                          <p className="text-xs text-muted-foreground mt-1.5">
                            Sessions sharing a label group under one heading.
                          </p>
                        </div>

                        <div>
                          <FormLabel>
                            Title <span className="text-destructive">*</span>
                          </FormLabel>
                          <Input
                            placeholder="e.g., Introduction & Goal Setting"
                            value={content.title}
                            onChange={(e) =>
                              updateSubscriptionContent(
                                index,
                                "title",
                                e.target.value,
                              )
                            }
                            className="mt-2"
                          />
                        </div>

                        <div>
                          <FormLabel>Hours</FormLabel>
                          <Input
                            type="number"
                            step="0.5"
                            min="0.5"
                            placeholder="1"
                            value={content.hoursAllotted}
                            onChange={(e) =>
                              updateSubscriptionContent(
                                index,
                                "hoursAllotted",
                                Number.parseFloat(e.target.value) || 1,
                              )
                            }
                            className="mt-2"
                          />
                        </div>

                        <div className="md:col-span-2">
                          <FormLabel>
                            Description{" "}
                            <span className="text-destructive">*</span>
                          </FormLabel>
                          <Textarea
                            placeholder="Describe what will be covered in this session..."
                            value={content.description}
                            onChange={(e) =>
                              updateSubscriptionContent(
                                index,
                                "description",
                                e.target.value,
                              )
                            }
                            className="mt-2 min-h-[60px] resize-none"
                          />
                        </div>

                        <div>
                          <FormLabel>Session Type</FormLabel>
                          <Input
                            placeholder="e.g., Video Call, Review Session"
                            value={content.contentType ?? ""}
                            onChange={(e) =>
                              updateSubscriptionContent(
                                index,
                                "contentType",
                                e.target.value || null,
                              )
                            }
                            className="mt-2"
                          />
                        </div>

                        <div>
                          <FormLabel>Resource URL</FormLabel>
                          <Input
                            placeholder="https://..."
                            value={content.contentUrl ?? ""}
                            onChange={(e) =>
                              updateSubscriptionContent(
                                index,
                                "contentUrl",
                                e.target.value || null,
                              )
                            }
                            className="mt-2"
                          />
                        </div>
                      </div>
                    </div>
                  ))}

                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={addSubscriptionContent}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Session
                  </Button>

                  <FormDescription>
                    Define the curriculum for each session of the subscription.
                    This helps subscribers understand what they will learn.
                  </FormDescription>
                </div>
              </FormSection>

              {/* Materials Section - Only show when editing an existing plan */}
              {initialData?.id && (
                <FormSection
                  title="Plan Materials"
                  description="Upload materials for subscribers"
                  icon={Upload}
                >
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowMaterialsDialog(true)}
                    className="w-full"
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    Manage Materials
                  </Button>
                </FormSection>
              )}

              </div>
              <ResponsiveModalFooter className="shrink-0 border-t pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={onClose}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
                <SubmitButton isLoading={isSaving}>
                  {initialData ? "Update Plan" : "Create Plan"}
                </SubmitButton>
              </ResponsiveModalFooter>
            </form>
          </Form>
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* Materials Upload ResponsiveModal */}
      {initialData?.id && (
        <PlanMaterialsUpload
          planType="subscription"
          planId={initialData.id}
          planTitle={
            form.getValues("title") ||
            initialData.subscriptionPlan?.title ||
            "Subscription Plan"
          }
          isOpen={showMaterialsDialog}
          onClose={() => setShowMaterialsDialog(false)}
        />
      )}

      <FormConfirmationDialog
        isOpen={showConfirmation}
        onConfirm={handleConfirmedSubmit}
        onCancel={() => setShowConfirmation(false)}
        title={`${initialData ? "Update" : "Create"} Subscription Plan`}
        description={`You are about to ${initialData ? "update" : "create"} the subscription plan "${form.getValues("title")}". This will be immediately available for clients.`}
        isLoading={isSaving}
        confirmText={initialData ? "Update" : "Create"}
      />
    </>
  );
}
