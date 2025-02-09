"use client"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ClassPlanSchema, WebinarPlanSchema } from "@/schemas/PlanSchema"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { EventPlannerProps, FormData } from "../types"

export function EventPlanner({ isOpen, onClose, onSave, eventType, initialData, isSaving }: EventPlannerProps) {
  const schema = eventType === "webinar" ? WebinarPlanSchema : ClassPlanSchema
  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: initialData ? {
      ...(eventType === "webinar" && initialData.webinarPlan ? {
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
        topics: initialData.webinarPlan.topics.map((topic: { id: string }) => topic.id),
        consultantProfileId: initialData.webinarPlan.consultantProfileId
      } : eventType === "class" && initialData.classPlan ? {
        title: initialData.classPlan.title,
        description: initialData.classPlan.description || "",
        price: initialData.classPlan.price,
        durationInMonths: initialData.classPlan.durationInMonths,
        maxParticipants: initialData.classPlan.maxParticipants,
        language: initialData.classPlan.language || "English",
        level: initialData.classPlan.level || "Beginner",
        prerequisites: initialData.classPlan.prerequisites || "",
        materialProvided: initialData.classPlan.materialProvided || "",
        learningOutcomes: initialData.classPlan.learningOutcomes,
        topics: initialData.classPlan.topics.map((topic: { id: string }) => topic.id),
        certificateProvided: initialData.classPlan.certificateProvided,
        callsPerWeek: initialData.classPlan.callsPerWeek,
        videoMeetings: initialData.classPlan.videoMeetings,
        emailSupport: initialData.classPlan.emailSupport,
        consultantProfileId: initialData.classPlan.consultantProfileId,
        classContents: initialData.classPlan.classContents
      } : {})
    } : {
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
      ...(eventType === "webinar" ? {
        durationInHours: 1,
      } : {
        durationInMonths: 1,
        callsPerWeek: 1,
        videoMeetings: 1,
        emailSupport: "GENERAL" as const,
        certificateProvided: false,
        classContents: [],
      }),
    },
  })

  const onSubmit = async (data: FormData) => {
    try {
      const now = new Date()
      if (eventType === "webinar") {
        const webinarData = {
          type: "webinar" as const,
          webinarPlan: {
            id: initialData?.webinarPlan?.id || '',
            title: data.title,
            description: data.description,
            price: data.price,
            durationInHours: 'durationInHours' in data ? data.durationInHours : 0,
            maxParticipants: data.maxParticipants,
            language: data.language,
            level: data.level,
            prerequisites: data.prerequisites || null,
            materialProvided: data.materialProvided || null,
            learningOutcomes: data.learningOutcomes,
            topics: data.topics.map(id => ({ id, name: '', createdAt: now, updatedAt: now })),
            consultantProfileId: data.consultantProfileId || null,
            consultantProfile: null,
            createdAt: initialData?.webinarPlan?.createdAt || now,
            updatedAt: now
          }
        }
        onSave(webinarData)
      } else {
        const classData = {
          type: "class" as const,
          classPlan: {
            id: initialData?.classPlan?.id || '',
            title: data.title,
            description: data.description,
            price: data.price,
            durationInMonths: 'durationInMonths' in data ? data.durationInMonths : 0,
            maxParticipants: data.maxParticipants,
            language: data.language,
            level: data.level,
            prerequisites: data.prerequisites || null,
            materialProvided: data.materialProvided || null,
            learningOutcomes: data.learningOutcomes,
            topics: data.topics.map(id => ({ id, name: '', createdAt: now, updatedAt: now })),
            consultantProfileId: data.consultantProfileId || null,
            consultantProfile: null,
            certificateProvided: 'certificateProvided' in data ? data.certificateProvided : false,
            callsPerWeek: 'callsPerWeek' in data ? data.callsPerWeek : 0,
            videoMeetings: 'videoMeetings' in data ? data.videoMeetings : 0,
            emailSupport: 'emailSupport' in data ? data.emailSupport : 'GENERAL',
            classContents: 'classContents' in data ? data.classContents.map((content, index) => ({
              id: content.id || `temp-${index}`,
              title: content.title,
              description: content.description,
              contentType: content.contentType || null,
              contentUrl: content.contentUrl || null,
              order: content.order,
              hoursAllotted: content.hoursAllotted,
              createdAt: now,
              updatedAt: now,
              classPlanId: initialData?.classPlan?.id || ''
            })) : [],
            createdAt: initialData?.classPlan?.createdAt || now,
            updatedAt: now
          }
        }
        onSave(classData)
      }
    } catch (error) {
      console.error("Error saving plan:", error)
    }
    onClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {initialData ? "Edit" : "Create New"} {eventType === "webinar" ? "Webinar" : "Class"}
          </DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
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
                          onChange={(e) => field.onChange(Number(e.target.value))}
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
                          onChange={(e) => field.onChange(Number(e.target.value))}
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
                    <Input {...field} value={field.value || ''} />
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
                    <Input {...field} value={field.value || ''} />
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
                    <Textarea 
                      {...field}
                      value={field.value.join("\n")}
                      onChange={(e) => {
                        const outcomes = e.target.value
                          .split("\n")
                          .map(outcome => outcome.trim())
                          .filter(Boolean)
                        field.onChange(outcomes)
                      }}
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
                      value={field.value.join("\n")}
                      onChange={(e) => {
                        const topics = e.target.value
                          .split("\n")
                          .map(topic => topic.trim())
                          .filter(Boolean)
                        field.onChange(topics)
                      }}
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
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
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
                          <div key={index} className="grid grid-cols-2 gap-4 p-4 border rounded-lg">
                            <FormField
                              control={form.control}
                              name={`classContents.${index}.title`}
                              render={({ field: contentField }) => (
                                <FormItem>
                                  <FormLabel>Title</FormLabel>
                                  <FormControl>
                                    <Input {...contentField} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={form.control}
                              name={`classContents.${index}.description`}
                              render={({ field: contentField }) => (
                                <FormItem>
                                  <FormLabel>Description</FormLabel>
                                  <FormControl>
                                    <Textarea {...contentField} />
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
                                  <FormLabel>Order</FormLabel>
                                  <FormControl>
                                    <Input 
                                      type="number" 
                                      {...contentField}
                                      onChange={(e) => contentField.onChange(Number(e.target.value))}
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
                                  <FormLabel>Hours Allotted</FormLabel>
                                  <FormControl>
                                    <Input 
                                      type="number" 
                                      {...contentField}
                                      onChange={(e) => contentField.onChange(Number(e.target.value))}
                                    />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <Button
                              type="button"
                              variant="destructive"
                              onClick={() => {
                                const newContents = [...(field.value || [])]
                                newContents.splice(index, 1)
                                field.onChange(newContents)
                              }}
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          onClick={() => {
                            const currentContents = field.value || []
                            field.onChange([
                              ...currentContents,
                              {
                                title: "",
                                description: "",
                                contentType: "",
                                contentUrl: "",
                                order: currentContents.length + 1,
                                hoursAllotted: 1
                              }
                            ])
                          }}
                        >
                          Add Class Content
                        </Button>
                      </div>
                    </FormItem>
                  )}
                />
              </>
            )}

            <DialogFooter>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
