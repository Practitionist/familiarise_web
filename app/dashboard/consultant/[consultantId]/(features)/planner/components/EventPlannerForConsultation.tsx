"use client";

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
import { ConsultationPlanSchema } from "@/schemas/plans";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  ConsultationPlanEvent,
  ConsultationPlannerProps,
} from "../types/event";
import iso6391 from "iso-639-1";

// Define the level options
const levelOptions = ["Beginner", "Intermediate", "Advanced", "Expert"];

export function EventPlannerForConsultation({
  isOpen,
  onClose,
  onSave,
  initialData,
  isSaving: externalIsSaving,
  consultantId,
}: Readonly<ConsultationPlannerProps>) {
  const [internalIsSaving, setInternalIsSaving] = useState(false);
  const [newOutcome, setNewOutcome] = useState("");
  const { toast } = useToast();

  // Use either external or internal saving state
  const isSaving = externalIsSaving ?? internalIsSaving;

  // Define form for consultation plan
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
    mode: "onChange",
  });

  // Reset form values when initialData changes
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

  // Form submission handler
  const handleFormSubmit = form.handleSubmit(
    async (formData) => {
      try {
        console.log(
          "Consultation form submission data:",
          JSON.stringify(formData, null, 2),
        );

        setInternalIsSaving(true);

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
            priceCurrency: formData.priceCurrency,
            language: formData.language,
            level: formData.level,
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

        console.log(
          "Calling onSave with consultation data:",
          JSON.stringify(consultationData, null, 2),
        );

        try {
          onSave(consultationData);

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
          throw error;
        }
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

  // Calculate active consultations count
  const activeConsultationsCount =
    initialData?.consultationPlan?.consultations?.length ?? 0;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {initialData ? "Edit" : "Create New"} Consultation Plan
          </DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground">
              <p>
                {initialData
                  ? "Update the details of your consultation plan."
                  : "Fill in the details to create a new consultation plan."}
              </p>
              {activeConsultationsCount > 0 && (
                <div className="mt-2 text-sm text-blue-600">
                  This plan has {activeConsultationsCount} consultation
                  request(s).
                </div>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={handleFormSubmit} className="space-y-6">
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
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      className="min-h-[120px]"
                      placeholder="Describe your consultation plan"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
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
                        {...field}
                        onChange={(e) => {
                          const value = e.target.value;
                          field.onChange(
                            value === "" ? 0 : Number.parseFloat(value),
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
                name="price"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Price (INR)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min="0"
                        {...field}
                        onChange={(e) => {
                          const value = e.target.value;
                          field.onChange(
                            value === "" ? 0 : Number.parseInt(value, 10),
                          );
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="language"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Language</FormLabel>
                    <FormControl>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select language" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {iso6391.getAllNames().map((langName) => (
                            <SelectItem key={langName} value={langName}>
                              {langName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select level" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {levelOptions.map((level) => (
                            <SelectItem key={level} value={level}>
                              {level}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="prerequisites"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Prerequisites</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Enter prerequisites"
                      value={field.value ?? ""}
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
                  <FormLabel>Material Provided</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Enter material provided"
                      value={field.value ?? ""}
                    />
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
      </DialogContent>
    </Dialog>
  );
}
