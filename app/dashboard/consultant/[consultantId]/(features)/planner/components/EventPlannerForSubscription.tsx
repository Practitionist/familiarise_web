"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  FileText,
  DollarSign,
  Settings,
  GraduationCap,
  Headphones,
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
import { useToast } from "@/hooks/use-toast";
import { SubscriptionPlanSchema } from "@/schemas/plans";

import {
  FormSection,
  LearningOutcomesField,
  PriceField,
  LanguageLevelFields,
  SubmitButton,
  FormConfirmationDialog,
} from "./form-fields";
import {
  SubscriptionPlanEvent,
  SubscriptionPlannerProps,
} from "../types/event";

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
  const { toast } = useToast();

  const isSaving = externalIsSaving ?? internalIsSaving;

  const form = useForm({
    resolver: zodResolver(SubscriptionPlanSchema),
    defaultValues: initialData?.subscriptionPlan
      ? {
          title: initialData.subscriptionPlan.title,
          description: initialData.subscriptionPlan.description ?? "",
          durationInMonths: initialData.subscriptionPlan.durationInMonths,
          price: initialData.subscriptionPlan.price,
          priceCurrency: initialData.subscriptionPlan.priceCurrency ?? "INR",
          callsPerWeek: initialData.subscriptionPlan.callsPerWeek,
          emailSupport: initialData.subscriptionPlan.emailSupport,
          language: initialData.subscriptionPlan.language ?? "English",
          level: initialData.subscriptionPlan.level ?? "Beginner",
          prerequisites: initialData.subscriptionPlan.prerequisites ?? "",
          materialProvided:
            initialData.subscriptionPlan.materialProvided ?? "",
          learningOutcomes:
            initialData.subscriptionPlan.learningOutcomes ?? [],
        }
      : {
          title: "",
          description: "",
          durationInMonths: 1,
          price: 0,
          priceCurrency: "INR",
          callsPerWeek: 1,
          emailSupport: "GENERAL" as const,
          language: "English",
          level: "Beginner",
          prerequisites: "",
          materialProvided: "",
          learningOutcomes: [],
        },
    mode: "onChange",
  });

  useEffect(() => {
    if (initialData?.subscriptionPlan) {
      form.reset({
        title: initialData.subscriptionPlan.title,
        description: initialData.subscriptionPlan.description ?? "",
        durationInMonths: initialData.subscriptionPlan.durationInMonths,
        price: initialData.subscriptionPlan.price,
        priceCurrency: initialData.subscriptionPlan.priceCurrency ?? "INR",
        callsPerWeek: initialData.subscriptionPlan.callsPerWeek,
        emailSupport: initialData.subscriptionPlan.emailSupport,
        language: initialData.subscriptionPlan.language ?? "English",
        level: initialData.subscriptionPlan.level ?? "Beginner",
        prerequisites: initialData.subscriptionPlan.prerequisites ?? "",
        materialProvided: initialData.subscriptionPlan.materialProvided ?? "",
        learningOutcomes: initialData.subscriptionPlan.learningOutcomes ?? [],
      });
    }
  }, [initialData, form]);

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

      const now = new Date();

      const subscriptionData: Partial<SubscriptionPlanEvent> = {
        type: "subscription" as const,
        id: initialData?.id,
        subscriptionPlan: {
          id: initialData?.subscriptionPlan?.id ?? "",
          title: formData.title,
          description: formData.description || "",
          durationInMonths: formData.durationInMonths,
          price: formData.price,
          priceCurrency: formData.priceCurrency ?? "INR",
          callsPerWeek: formData.callsPerWeek,
          emailSupport: formData.emailSupport ?? "GENERAL",
          language: formData.language ?? "English",
          level: formData.level ?? "Beginner",
          prerequisites: formData.prerequisites ?? undefined,
          materialProvided: formData.materialProvided ?? undefined,
          learningOutcomes: formData.learningOutcomes,
          consultantProfileId: consultantId,
          consultantProfile: null,
          subscriptions: initialData?.subscriptionPlan?.subscriptions ?? [],
          sessionDurationInHours: 1,
          createdAt: initialData?.subscriptionPlan?.createdAt ?? now,
          updatedAt: now,
        },
      };

      onSave(subscriptionData);

      toast({
        title: "Success",
        description: `${initialData ? "Updated" : "Created"} subscription plan "${formData.title}" successfully`,
        variant: "default",
      });
      onClose();
    } catch (error) {
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
              {initialData ? "Edit" : "Create New"} Subscription Plan
            </DialogTitle>
            <DialogDescription asChild>
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
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={handleFormSubmit} className="space-y-6 py-4">
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
                description="Define call frequency and support level"
                icon={Headphones}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="callsPerWeek"
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
                  {initialData ? "Update Plan" : "Create Plan"}
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
        title={`${initialData ? "Update" : "Create"} Subscription Plan`}
        description={`You are about to ${initialData ? "update" : "create"} the subscription plan "${form.getValues("title")}". This will be immediately available for clients.`}
        isLoading={isSaving}
        confirmText={initialData ? "Update" : "Create"}
      />
    </>
  );
}
