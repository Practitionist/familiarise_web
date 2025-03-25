"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { ClassPlanSchema, WebinarPlanSchema } from "@/schemas/PlanSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { EventPlannerProps, FormData } from "../types/event";
import { useEffect, useState, useMemo } from "react";
import { useToast } from "@/hooks/use-toast";

export function EventPlanner({
  isOpen,
  onClose,
  onSave,
  eventType,
  initialData,
  isSaving,
}: EventPlannerProps) {
  // State to track created topic IDs
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const { toast } = useToast();
  
  // State to track form errors
  const [contentErrors, setContentErrors] = useState<{[key: string]: string}>({});
  
  const schema = eventType === "webinar" ? WebinarPlanSchema : ClassPlanSchema;

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: initialData
      ? {
          ...(eventType === "webinar" && initialData.webinarPlan
            ? {
                title: initialData.webinarPlan.title,
                description: initialData.webinarPlan.description || "",
                price: initialData.webinarPlan.price,
                durationInHours: initialData.webinarPlan.durationInHours,
                maxParticipants: initialData.webinarPlan.maxParticipants,
                language: initialData.webinarPlan.language || "English",
                level: initialData.webinarPlan.level || "Beginner",
                prerequisites: initialData.webinarPlan.prerequisites || "",
                materialProvided:
                  initialData.webinarPlan.materialProvided || "",
                learningOutcomes: initialData.webinarPlan.learningOutcomes,
                topics: initialData.webinarPlan.topics.map(
                  (topic) => topic.id,
                ),
                consultantProfileId:
                  initialData.webinarPlan.consultantProfileId,
              }
            : eventType === "class" && initialData.classPlan
              ? {
                  title: initialData.classPlan.title,
                  description: initialData.classPlan.description || "",
                  price: initialData.classPlan.price,
                  durationInMonths: initialData.classPlan.durationInMonths,
                  maxParticipants: initialData.classPlan.maxParticipants,
                  language: initialData.classPlan.language || "English",
                  level: initialData.classPlan.level || "Beginner",
                  prerequisites: initialData.classPlan.prerequisites || "",
                  materialProvided:
                    initialData.classPlan.materialProvided || "",
                  learningOutcomes: initialData.classPlan.learningOutcomes,
                  topics: initialData.classPlan.topics.map(
                    (topic) => topic.id,
                  ),
                  certificateProvided:
                    initialData.classPlan.certificateProvided,
                  callsPerWeek: initialData.classPlan.callsPerWeek,
                  videoMeetings: initialData.classPlan.videoMeetings,
                  emailSupport: initialData.classPlan.emailSupport,
                  consultantProfileId:
                    initialData.classPlan.consultantProfileId,
                  classContents: initialData.classPlan.classContents,
                }
              : {}),
        }
      : {
          title: "",
          description: "",
          price: 0,
          maxParticipants: 100,
          language: "English",
          level: "Beginner",
          prerequisites: "",
          materialProvided: "",
          learningOutcomes: [],
          topics: [],
          ...(eventType === "webinar"
            ? {
                durationInHours: 1,
              }
            : {
                durationInMonths: 1,
                callsPerWeek: 1,
                videoMeetings: 1,
                emailSupport: "GENERAL" as const,
                certificateProvided: false,
                classContents: [],
              }),
        },
    mode: "onChange",
  });

  // Function to create topics
  const createTopics = async (topicNames: string[]) => {
    try {
      // Create an array of promises for creating each topic
      const promises = topicNames.map(async (name) => {
        // Create a new topic
        const topicResponse = await fetch('/api/user/content/topics', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name }),
        });
        
        if (!topicResponse.ok) {
          const errorData = await topicResponse.json();
          throw new Error(errorData.error || `Failed to create topic "${name}"`);
        }
        
        const topicData = await topicResponse.json();
        return topicData.data.id;
      });
      
      // Wait for all topics to be created
      const ids = await Promise.all(promises);
      setTopicIds(ids);
      
      if (ids.length > 0) {
        toast({
          title: "Topics created",
          description: `Successfully created ${ids.length} topics`,
        });
      }
      
      return ids;
    } catch (error) {
      console.error("Error creating topics:", error);
      toast({
        title: "Error creating topics",
        description: error instanceof Error ? error.message : "Unknown error occurred",
        variant: "destructive",
      });
      return [];
    }
  };

  // Update the validateClassContents function to handle proper types
  function validateClassContents(contents: any[] | undefined) {
    const errors: Record<string, string> = {};
    
    if (!contents || contents.length === 0) {
      return errors;
    }
    
    contents.forEach((content, index) => {
      if (!content.title) {
        errors[`classContents.${index}.title`] = "Title is required";
      }
      
      if (!content.description) {
        errors[`classContents.${index}.description`] = "Description is required";
      }
      
      if (!content.order || isNaN(Number(content.order)) || Number(content.order) <= 0) {
        errors[`classContents.${index}.order`] = "Order must be a positive number";
      }
      
      if (!content.hoursAllotted || isNaN(Number(content.hoursAllotted)) || Number(content.hoursAllotted) <= 0) {
        errors[`classContents.${index}.hoursAllotted`] = "Hours must be a positive number";
      }
    });
    return errors;
  }

  // Type guard to check if form data has classContents
  function isClassFormData(data: any): data is FormData & { classContents: any[] } {
    return data && Array.isArray(data.classContents);
  }

  // Run validation on form values whenever they change
  useEffect(() => {
    if (eventType === "class" && form.formState.isSubmitted) {
      const formValues = form.getValues();
      if (isClassFormData(formValues)) {
        setContentErrors(validateClassContents(formValues.classContents));
      }
    }
  }, [form.watch('classContents'), eventType, form]);

  // Validate class contents when dialog opens and when the form is set to class type
  useEffect(() => {
    if (isOpen && eventType === "class") {
      // For class events, check and validate class contents
      const formValues = form.getValues();
      if (isClassFormData(formValues)) {
        setContentErrors(validateClassContents(formValues.classContents));
      }
    }
  }, [isOpen, eventType, form]);

  // Clear errors when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setContentErrors({});
    }
  }, [isOpen]);

  // Initialize planType in a type-safe way
  useEffect(() => {
    if (form && eventType === "class") {
      // Use setValue with type casting for safety
      (form as any).setValue('planType', 'class');
    } else if (form && eventType === "webinar") {
      (form as any).setValue('planType', 'webinar');
    }
  }, [form, eventType]);

  const onSubmit = async (data: FormData) => {
    try {
      console.log("Starting form submission with data:", JSON.stringify(data, null, 2));
      
      // Process topics if they are entered as text
      const topicNames = (Array.isArray(data.topics) && data.topics.length > 0 && 
          typeof data.topics[0] === 'string' && 
          data.topics[0]?.length > 0 && 
          !data.topics[0].match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))
        ? data.topics as string[]
        : [];
      
      // If we have new topic names, create them and get their IDs
      let finalTopicIds = data.topics as string[];
      if (topicNames.length > 0) {
        const newIds = await createTopics(topicNames);
        finalTopicIds = newIds.length > 0 ? newIds : finalTopicIds;
      }
      
      const now = new Date();
      if (eventType === "webinar") {
        const webinarData = {
          type: "webinar" as const,
          webinarPlan: {
            id: initialData?.webinarPlan?.id || "",
            title: data.title,
            description: data.description,
            price: data.price,
            durationInHours:
              "durationInHours" in data ? data.durationInHours : 0,
            maxParticipants: data.maxParticipants,
            language: data.language,
            level: data.level,
            prerequisites: data.prerequisites || null,
            materialProvided: data.materialProvided || null,
            learningOutcomes: data.learningOutcomes,
            topics: finalTopicIds.map(id => ({
              id,
              name: "",
              createdAt: now,
              updatedAt: now
            })),
            topicIds: finalTopicIds,
            consultantProfileId: data.consultantProfileId || null,
            consultantProfile: null,
            createdAt: initialData?.webinarPlan?.createdAt || now,
            updatedAt: now,
          },
        };
        console.log("Saving webinar data:", webinarData);
        onSave(webinarData);
        toast({
          title: "Success",
          description: `${initialData ? "Updated" : "Created"} webinar "${data.title}" successfully`,
        });
      } else if (eventType === "class") {
        // For class events, access classContents with type casting
        const classData = data as any;
        const classContents = classData.classContents || [];
        
        const classEventData = {
          type: "class" as const,
          classPlan: {
            id: initialData?.classPlan?.id || "",
            title: data.title,
            description: data.description,
            price: data.price,
            durationInMonths:
              "durationInMonths" in data ? data.durationInMonths : 0,
            maxParticipants: data.maxParticipants,
            language: data.language,
            level: data.level,
            prerequisites: data.prerequisites || null,
            materialProvided: data.materialProvided || null,
            learningOutcomes: data.learningOutcomes,
            topics: finalTopicIds.map(id => ({
              id,
              name: "",
              createdAt: now,
              updatedAt: now
            })),
            topicIds: finalTopicIds,
            consultantProfileId: data.consultantProfileId || null,
            consultantProfile: null,
            certificateProvided:
              "certificateProvided" in data ? data.certificateProvided : false,
            callsPerWeek: "callsPerWeek" in data ? data.callsPerWeek : 0,
            videoMeetings: "videoMeetings" in data ? data.videoMeetings : 0,
            emailSupport:
              "emailSupport" in data ? data.emailSupport : "GENERAL",
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
              classPlanId: initialData?.classPlan?.id || "",
            })),
            createdAt: initialData?.classPlan?.createdAt || now,
            updatedAt: now,
          },
        };
        console.log("Saving class data:", classEventData);
        try {
          onSave(classEventData);
          toast({
            title: "Success",
            description: `${initialData ? "Updated" : "Created"} class "${data.title}" successfully`,
          });
        } catch (saveError) {
          console.error("Error in onSave callback:", saveError);
          throw saveError;
        }
      }
      onClose();
    } catch (error) {
      console.error("Error saving plan:", error);
      // Show detailed error info
      const errorMessage = error instanceof Error ? 
        `${error.message}\n${error.stack}` : 
        "Unknown error occurred";
      console.error(errorMessage);
        
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Function to get error for a content field
  const getContentError = (path: string) => {
    return contentErrors[path] || "";
  };

  // Form submission wrapper for debugging
  const handleFormSubmit = form.handleSubmit((formData) => {
    console.log("Form submission data:", JSON.stringify(formData, null, 2));
    console.log("Form validation errors:", form.formState.errors);
    
    // For class type, check if classContents exists
    if (eventType === "class") {
      const classData = formData as any;
      if (!Array.isArray(classData.classContents) || classData.classContents.length === 0) {
        toast({
          title: "Error",
          description: "Please add at least one class content item",
          variant: "destructive",
        });
        return;
      }
      
      // Validate all class contents
      const errors = validateClassContents(classData.classContents);
      if (Object.keys(errors).length > 0) {
        setContentErrors(errors);
        toast({
          title: "Validation Error",
          description: "Please fix errors in Class Contents before saving",
          variant: "destructive",
        });
        return;
      }
    }
    
    // If we reach here, proceed with submission
    onSubmit(formData);
  }, (errors) => {
    // This function runs if validation fails
    console.log("Form validation failed with errors:", errors);
    toast({
      title: "Validation Error",
      description: "Please check the form for errors",
      variant: "destructive",
    });
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      // Clear errors when dialog is closed
      if (!open) {
        setContentErrors({});
      }
      onClose();
    }}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {initialData ? "Edit" : "Create New"}{" "}
            {eventType === "webinar" ? "Webinar" : "Class"}
          </DialogTitle>
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

              {eventType === "webinar" ? (
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
              ) : (
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
                          onChange={(e) =>
                            field.onChange(Number(e.target.value))
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
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

            {eventType === "class" && (
              <>
                <FormField
                  control={form.control}
                  name="certificateProvided"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Certificate Provided</FormLabel>
                      <Select
                        onValueChange={(value) =>
                          field.onChange(value === "true")
                        }
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
                            onChange={(e) =>
                              field.onChange(Number(e.target.value))
                            }
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
                  name="classContents"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Class Contents</FormLabel>
                      <div className="space-y-4">
                        {(field.value || []).map((content, index) => (
                          <div
                            key={index}
                            className="grid grid-cols-2 gap-4 p-4 border rounded-lg"
                          >
                            <FormField
                              control={form.control}
                              name={`classContents.${index}.title`}
                              render={({ field: contentField }) => (
                                <FormItem>
                                  <FormLabel>Title <span className="text-red-500">*</span></FormLabel>
                                  <FormControl>
                                    <Input 
                                      {...contentField} 
                                      className={contentErrors[`classContents.${index}.title`] ? "border-red-500" : ""}
                                      onBlur={() => {
                                        // Validate this specific field on blur
                                        const formValues = form.getValues();
                                        if (isClassFormData(formValues) && formValues.classContents[index] && !formValues.classContents[index].title) {
                                          setContentErrors(prev => ({
                                            ...prev,
                                            [`classContents.${index}.title`]: "Title is required"
                                          }));
                                        } else {
                                          setContentErrors(prev => {
                                            const newErrors = {...prev};
                                            delete newErrors[`classContents.${index}.title`];
                                            return newErrors;
                                          });
                                        }
                                      }}
                                    />
                                  </FormControl>
                                  {contentErrors[`classContents.${index}.title`] && (
                                    <p className="text-sm font-medium text-red-500">
                                      {contentErrors[`classContents.${index}.title`]}
                                    </p>
                                  )}
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={form.control}
                              name={`classContents.${index}.description`}
                              render={({ field: contentField }) => (
                                <FormItem>
                                  <FormLabel>Description <span className="text-red-500">*</span></FormLabel>
                                  <FormControl>
                                    <Textarea 
                                      {...contentField} 
                                      placeholder="Enter a description (required)"
                                      className={contentErrors[`classContents.${index}.description`] ? "border-red-500" : ""}
                                      onChange={(e) => {
                                        contentField.onChange(e.target.value);
                                        // Validate as user types
                                        if (!e.target.value.trim()) {
                                          setContentErrors(prev => ({
                                            ...prev,
                                            [`classContents.${index}.description`]: "Description is required"
                                          }));
                                        } else {
                                          setContentErrors(prev => {
                                            const newErrors = {...prev};
                                            delete newErrors[`classContents.${index}.description`];
                                            return newErrors;
                                          });
                                        }
                                      }}
                                    />
                                  </FormControl>
                                  {contentErrors[`classContents.${index}.description`] ? (
                                    <p className="text-sm font-medium text-red-500">
                                      {contentErrors[`classContents.${index}.description`]}
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
                              name={`classContents.${index}.contentType`}
                              render={({ field: contentField }) => (
                                <FormItem>
                                  <FormLabel>Content Type</FormLabel>
                                  <FormControl>
                                    <Input {...contentField} />
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
                                  <FormLabel>Content URL</FormLabel>
                                  <FormControl>
                                    <Input {...contentField} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={form.control}
                              name={`classContents.${index}.order`}
                              render={({ field: contentField }) => (
                                <FormItem>
                                  <FormLabel>Order <span className="text-red-500">*</span></FormLabel>
                                  <FormControl>
                                    <Input
                                      type="number"
                                      {...contentField}
                                      className={contentErrors[`classContents.${index}.order`] ? "border-red-500" : ""}
                                      onChange={(e) => {
                                        const value = Number(e.target.value);
                                        contentField.onChange(value);
                                        // Validate as user types
                                        if (value <= 0 || isNaN(value)) {
                                          setContentErrors(prev => ({
                                            ...prev,
                                            [`classContents.${index}.order`]: "Order must be a positive number"
                                          }));
                                        } else {
                                          setContentErrors(prev => {
                                            const newErrors = {...prev};
                                            delete newErrors[`classContents.${index}.order`];
                                            return newErrors;
                                          });
                                        }
                                      }}
                                    />
                                  </FormControl>
                                  {contentErrors[`classContents.${index}.order`] && (
                                    <p className="text-sm font-medium text-red-500">
                                      {contentErrors[`classContents.${index}.order`]}
                                    </p>
                                  )}
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={form.control}
                              name={`classContents.${index}.hoursAllotted`}
                              render={({ field: contentField }) => (
                                <FormItem>
                                  <FormLabel>Hours Allotted <span className="text-red-500">*</span></FormLabel>
                                  <FormControl>
                                    <Input
                                      type="number"
                                      {...contentField}
                                      className={contentErrors[`classContents.${index}.hoursAllotted`] ? "border-red-500" : ""}
                                      onChange={(e) => {
                                        const value = Number(e.target.value);
                                        contentField.onChange(value);
                                        // Validate as user types
                                        if (value <= 0 || isNaN(value)) {
                                          setContentErrors(prev => ({
                                            ...prev,
                                            [`classContents.${index}.hoursAllotted`]: "Hours must be a positive number"
                                          }));
                                        } else {
                                          setContentErrors(prev => {
                                            const newErrors = {...prev};
                                            delete newErrors[`classContents.${index}.hoursAllotted`];
                                            return newErrors;
                                          });
                                        }
                                      }}
                                    />
                                  </FormControl>
                                  {contentErrors[`classContents.${index}.hoursAllotted`] && (
                                    <p className="text-sm font-medium text-red-500">
                                      {contentErrors[`classContents.${index}.hoursAllotted`]}
                                    </p>
                                  )}
                                </FormItem>
                              )}
                            />
                            <Button
                              type="button"
                              variant="destructive"
                              onClick={() => {
                                const newContents = [...(field.value || [])];
                                newContents.splice(index, 1);
                                field.onChange(newContents);
                                
                                // Clear any errors for this content
                                const newErrors = { ...contentErrors };
                                Object.keys(newErrors).forEach(key => {
                                  if (key.startsWith(`classContents.${index}`)) {
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
                            const currentContents = field.value || [];
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
                              setContentErrors(validateClassContents([...currentContents, newContent]));
                            }, 100);
                          }}
                        >
                          Add Class Content
                        </Button>
                      </div>
                      {field.value && field.value.length === 0 && (
                        <p className="text-sm text-muted-foreground mt-2">
                          Add at least one class content to define the structure of your class.
                        </p>
                      )}
                    </FormItem>
                  )}
                />
              </>
            )}

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
