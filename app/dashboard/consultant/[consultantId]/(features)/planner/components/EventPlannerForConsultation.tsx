"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FileText, DollarSign, Settings, GraduationCap } from "lucide-react";

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
import { useToast } from "@/hooks/use-toast";
import { ConsultationPlanSchema } from "@/schemas/plans";

import {
  FormSection,
  LearningOutcomesField,
  PriceField,
  LanguageLevelFields,
  SubmitButton,
  FormConfirmationDialog,
} from "./form-fields";
import {
  ConsultationPlanEvent,
  ConsultationPlannerProps,
} from "../types/event";
import { PlannerService } from "../services/planner";

export function EventPlannerForConsultation({
  isOpen,
  onClose,
  onSave,
  initialData,
  isSaving: externalIsSaving,
  consultantId,
}: Readonly<ConsultationPlannerProps>) {
  const [internalIsSaving, setInternalIsSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const { toast } = useToast();

  const isSaving = externalIsSaving ?? internalIsSaving;

  const form = useForm({
    resolver: zodResolver(ConsultationPlanSchema),
    defaultValues: initialData?.consultationPlan
      ? {
          title: initialData.consultationPlan.title,
          description: initialData.consultationPlan.description ?? "",
          durationInHours: initialData.consultationPlan.durationInHours,
          price: initialData.consultationPlan.price,
          priceCurrency: initialData.consultationPlan.priceCurrency ?? "INR",
          language: initialData.consultationPlan.language ?? "English",
          level: initialData.consultationPlan.level ?? "Beginner",
          prerequisites: initialData.consultationPlan.prerequisites ?? "",
          materialProvided: initialData.consultationPlan.materialProvided ?? "",
          learningOutcomes: initialData.consultationPlan.learningOutcomes ?? [],
        }
      : {
          title: "",
          description: "",
          durationInHours: 1,
          price: 0,
          priceCurrency: "INR",
          language: "English",
          level: "Beginner",
          prerequisites: "",
          materialProvided: "",
          learningOutcomes: [],
        },
    mode: "onBlur",
  });

  useEffect(() => {
    if (initialData?.consultationPlan) {
      form.reset({
        title: initialData.consultationPlan.title,
        description: initialData.consultationPlan.description ?? "",
        durationInHours: initialData.consultationPlan.durationInHours,
        price: initialData.consultationPlan.price,
        priceCurrency: initialData.consultationPlan.priceCurrency ?? "INR",
        language: initialData.consultationPlan.language ?? "English",
        level: initialData.consultationPlan.level ?? "Beginner",
        prerequisites: initialData.consultationPlan.prerequisites ?? "",
        materialProvided: initialData.consultationPlan.materialProvided ?? "",
        learningOutcomes: initialData.consultationPlan.learningOutcomes ?? [],
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

      // Check for duplicate title
      const planId = initialData?.consultationPlan?.id ?? "";
      const isDuplicate = await PlannerService.checkDuplicateTitle(
        formData.title,
        consultantId,
        "consultation",
        planId,
      );

      if (isDuplicate) {
        toast({
          title: "Duplicate Title",
          description: `A consultation plan with title "${formData.title}" already exists. Please use a different title.`,
          variant: "destructive",
        });
        setInternalIsSaving(false);
        return;
      }

      const now = new Date();

      const consultationData: Partial<ConsultationPlanEvent> = {
        type: "consultation" as const,
        id: initialData?.id,
        consultationPlan: {
          id: initialData?.consultationPlan?.id ?? "",
          title: formData.title,
          description: formData.description || "",
          durationInHours: formData.durationInHours,
          price: formData.price,
          priceCurrency: formData.priceCurrency ?? "INR",
          language: formData.language ?? "English",
          level: formData.level ?? "Beginner",
          prerequisites: formData.prerequisites ?? undefined,
          materialProvided: formData.materialProvided ?? undefined,
          learningOutcomes: formData.learningOutcomes,
          consultantProfileId: consultantId,
          consultantProfile: null,
          consultations: initialData?.consultationPlan?.consultations ?? [],
          createdAt: initialData?.consultationPlan?.createdAt ?? now,
          updatedAt: now,
        },
      };

      // Await onSave to ensure API call completes before showing success
      await onSave(consultationData);

      toast({
        title: "Success",
        description: `${initialData ? "Updated" : "Created"} consultation plan "${formData.title}" successfully`,
        variant: "default",
      });
      onClose();
    } catch (error) {
      console.error("Error saving consultation plan:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to save consultation plan. Please try again.",
        variant: "destructive",
      });
    } finally {
      setInternalIsSaving(false);
    }
  };

  const activeConsultationsCount =
    initialData?.consultationPlan?.consultations?.length ?? 0;

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
              {initialData ? "Edit" : "Create New"} Consultation Plan
            </DialogTitle>
            <DialogDescription asChild>
              <div className="text-sm text-muted-foreground">
                <p>
                  {initialData
                    ? "Update the details of your consultation plan."
                    : "Create a one-on-one consultation offering for your clients."}
                </p>
                {activeConsultationsCount > 0 && (
                  <div className="mt-2 text-sm text-blue-600 font-medium">
                    This plan has {activeConsultationsCount} active
                    consultation(s).
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
                description="Define your consultation offering"
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
                          placeholder="e.g., Career Strategy Session"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        A clear, descriptive title for your consultation
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
                          placeholder="Describe what participants will learn and experience during this consultation..."
                        />
                      </FormControl>
                      <FormDescription>
                        Detailed overview of the consultation
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FormSection>

              {/* Pricing & Duration Section */}
              <FormSection
                title="Pricing & Duration"
                description="Set your rates and session length"
                icon={DollarSign}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <PriceField
                    control={form.control}
                    priceName="price"
                    currencyName="priceCurrency"
                    description="Leave as 0 for free consultations"
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
                            max="8"
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
                          Session duration (30 min increments)
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
                            placeholder="e.g., Basic understanding of your field"
                            value={field.value ?? ""}
                            className="min-h-[80px] resize-none"
                          />
                        </FormControl>
                        <FormDescription>
                          What should participants know beforehand?
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
                            placeholder="e.g., Session notes, action plan template"
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
                  placeholder="e.g., Create a personalized career roadmap"
                  description="What participants will achieve after the consultation"
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
        title={`${initialData ? "Update" : "Create"} Consultation Plan`}
        description={`You are about to ${initialData ? "update" : "create"} the consultation plan "${form.getValues("title")}". This will be immediately available for clients.`}
        isLoading={isSaving}
        confirmText={initialData ? "Update" : "Create"}
      />
    </>
  );
}
