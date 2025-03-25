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
import { Textarea } from "@/components/ui/textarea";
import { WebinarPlanSchema } from "@/schemas/PlanSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { PlannerService } from "../services/planner";
import { WebinarPlannerProps } from "../types/planner";

export function EventWebinarPlanner({
  isOpen,
  onClose,
  onSave,
  initialData,
  isSaving: externalIsSaving,
  consultantId,
}: WebinarPlannerProps) {
  const [internalIsSaving, setInternalIsSaving] = useState(false);
  const { toast } = useToast();
  
  // Use either external or internal saving state
  const isSaving = externalIsSaving !== undefined ? externalIsSaving : internalIsSaving;
  
  // Define form with WebinarPlanSchema
  const form = useForm({
    resolver: zodResolver(WebinarPlanSchema),
    defaultValues: initialData
      ? {
          title: initialData.webinarPlan.title,
          description: initialData.webinarPlan.description || "",
          price: initialData.webinarPlan.price,
          durationInHours: initialData.webinarPlan.durationInHours,
          maxParticipants: initialData.webinarPlan.maxParticipants,
          language: initialData.webinarPlan.language || "English",
          level: initialData.webinarPlan.level || "Beginner",
          prerequisites: initialData.webinarPlan.prerequisites || "",
          materialProvided: initialData.webinarPlan.materialProvided || "",
          learningOutcomes: initialData.webinarPlan.learningOutcomes,
          topics: initialData.webinarPlan.topics.map((topic) => topic.id),
          consultantProfileId: initialData.webinarPlan.consultantProfileId,
        }
      : {
          title: "",
          description: "",
          price: 0,
          durationInHours: 1,
          maxParticipants: 100,
          language: "English",
          level: "Beginner",
          prerequisites: "",
          materialProvided: "",
          learningOutcomes: [],
          topics: [],
        },
    mode: "onChange",
  });

  // Initialize planType in a type-safe way
  useEffect(() => {
    // Use setValue with type casting for safety
    (form as any).setValue('planType', 'webinar');
  }, [form]);

  // Form submission handler
  const handleFormSubmit = form.handleSubmit(async (formData) => {
    try {
      setInternalIsSaving(true);
      console.log("Webinar form submission data:", JSON.stringify(formData, null, 2));
      
      // Process topics if they are entered as text
      const topicNames = (Array.isArray(formData.topics) && formData.topics.length > 0 && 
        typeof formData.topics[0] === 'string' && 
        formData.topics[0]?.length > 0 && 
        !formData.topics[0].match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))
        ? formData.topics as string[]
        : [];
      
      // If we have new topic names, create them and get their IDs
      let finalTopicIds = formData.topics as string[];
      if (topicNames.length > 0) {
        const newIds = await PlannerService.createTopics(topicNames);
        finalTopicIds = newIds.length > 0 ? newIds : finalTopicIds;
      }
      
      const now = new Date();
      
      const webinarData = {
        type: "webinar" as const,
        webinarPlan: {
          id: initialData?.webinarPlan?.id || "",
          title: formData.title,
          description: formData.description,
          price: formData.price,
          durationInHours: formData.durationInHours,
          maxParticipants: formData.maxParticipants,
          language: formData.language,
          level: formData.level,
          prerequisites: formData.prerequisites || null,
          materialProvided: formData.materialProvided || null,
          learningOutcomes: formData.learningOutcomes,
          topics: finalTopicIds.map(id => ({
            id,
            name: "",
            createdAt: now,
            updatedAt: now
          })),
          topicIds: finalTopicIds,
          consultantProfileId: consultantId,
          consultantProfile: null,
          createdAt: initialData?.webinarPlan?.createdAt || now,
          updatedAt: now,
        },
      };
      
      onSave(webinarData);
      
      toast({
        title: "Success",
        description: `${initialData ? "Updated" : "Created"} webinar "${formData.title}" successfully`,
      });
      
      onClose();
    } catch (error) {
      console.error("Error saving webinar:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save webinar. Please try again.",
        variant: "destructive",
      });
    } finally {
      setInternalIsSaving(false);
    }
  }, (errors) => {
    console.log("Form validation failed with errors:", errors);
    toast({
      title: "Validation Error",
      description: "Please check the form for errors",
      variant: "destructive",
    });
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {initialData ? "Edit" : "Create New"} Webinar
          </DialogTitle>
          <DialogDescription>
            {initialData ? "Update the details of your webinar." : "Fill in the details to create a new webinar."}
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
                name="durationInHours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Duration (hours)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) =>
                          field.onChange(Number(e.target.value))
                        }
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
                    <Input {...field} value={field.value || ""} />
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
                    <Input {...field} value={field.value || ""} />
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
                  <FormLabel>Learning Outcomes (one per line)</FormLabel>
                  <FormControl>
                    <textarea
                      value={(field.value || []).join("\n")}
                      onChange={(e) => {
                        const outcomes = e.target.value
                          .split("\n")
                          .filter(Boolean);
                        field.onChange(outcomes);
                      }}
                      rows={5}
                      placeholder="Enter each learning outcome on a new line"
                      className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="topics"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Topics (one per line)</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={(field.value || []).join("\n")}
                      onChange={(e) => {
                        const topics = e.target.value
                          .split("\n")
                          .map((topic) => topic.trim())
                          .filter(Boolean);
                        field.onChange(topics);
                      }}
                      rows={5}
                      placeholder="Enter each topic on a new line"
                      className="min-h-[100px]"
                    />
                  </FormControl>
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