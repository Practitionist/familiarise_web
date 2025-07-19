"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EventCarousel } from "./EventCarousel";
import { EventPlanner } from "./EventPlanner";
import {
  WebinarEvent,
  ClassEvent,
  ConsultationPlanEvent,
  SubscriptionPlanEvent,
  Event,
} from "../types/event";
import { PlannerService } from "../services/planner";
import { useToast } from "@/hooks/use-toast";
import {
  useWebinarMutations,
  useClassMutations,
  useConsultationPlans,
  useConsultationPlanMutations,
  useSubscriptionPlans,
  useSubscriptionPlanMutations,
  usePlannerRefresh,
} from "../../../hooks/usePlanner";

interface PlannerData {
  webinars: any[];
  classes: any[];
  participantCounts: Record<string, number>;
}
import { addMonths, startOfMonth, endOfMonth } from "date-fns";

interface Props {
  consultantId: string;
  initialData?: PlannerData;
}

export function EventManagementDashboard({
  consultantId,
  initialData,
}: Readonly<Props>) {
  const [webinars, setWebinars] = useState<WebinarEvent[]>(
    initialData?.webinars || [],
  );
  const [classes, setClasses] = useState<ClassEvent[]>(
    initialData?.classes || [],
  );
  const [isWebinarDialogOpen, setIsWebinarDialogOpen] = useState(false);
  const [isClassDialogOpen, setIsClassDialogOpen] = useState(false);
  const [isConsultationDialogOpen, setIsConsultationDialogOpen] =
    useState(false);
  const [isSubscriptionDialogOpen, setIsSubscriptionDialogOpen] =
    useState(false);
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [isLoading, setIsLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  // React Query hooks for consultation and subscription plans
  const { data: consultationPlans, isLoading: consultationPlansLoading } =
    useConsultationPlans(consultantId);
  const { data: subscriptionPlans, isLoading: subscriptionPlansLoading } =
    useSubscriptionPlans(consultantId);

  // React Query mutations
  const { deleteWebinar } = useWebinarMutations(consultantId);
  const { deleteClass } = useClassMutations(consultantId);
  const {
    createConsultationPlan,
    updateConsultationPlan,
    deleteConsultationPlan,
  } = useConsultationPlanMutations(consultantId);
  const {
    createSubscriptionPlan,
    updateSubscriptionPlan,
    deleteSubscriptionPlan,
  } = useSubscriptionPlanMutations(consultantId);
  const { refreshPlanner } = usePlannerRefresh(consultantId);
  const [currentDate, setCurrentDate] = useState(new Date());

  // Fetch events on load only if no initial data
  useEffect(() => {
    if (initialData) {
      setWebinars(initialData.webinars);
      setClasses(initialData.classes);
      setIsLoading(false);
      return;
    }

    const fetchEvents = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const startDate = startOfMonth(currentDate);
        const endDate = endOfMonth(currentDate);

        // Use the service to fetch data
        const [fetchedWebinars, fetchedClasses] = await Promise.all([
          PlannerService.fetchWebinars(consultantId),
          PlannerService.fetchClasses(consultantId, startDate, endDate),
        ]);

        setWebinars(fetchedWebinars);
        setClasses(fetchedClasses);
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
        console.error("Error fetching events:", err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchEvents();
  }, [consultantId, initialData, currentDate]);

  // Handle webinar saved event
  const handleWebinarSaved = async (
    data: Partial<WebinarEvent>,
    scheduledAt?: string | Date,
  ) => {
    try {
      setIsSaving(true);
      console.log("EventManagementDashboard - Saving webinar:", {
        data,
        scheduledAt,
      });

      const savedWebinar = await PlannerService.saveWebinar(
        data,
        scheduledAt,
        consultantId,
      );
      console.log("Webinar saved successfully:", savedWebinar);

      // Refresh planner data with React Query
      refreshPlanner();
      setIsWebinarDialogOpen(false);
      setEditingEvent(null);
    } catch (error) {
      console.error("Error saving/refreshing webinar:", error);
      // Re-throw the error so it can be handled by the form
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  // Handle class saved event
  const handleClassSaved = async (data: Partial<ClassEvent>) => {
    try {
      setIsSaving(true);
      console.log("EventManagementDashboard - Saving class:", data);

      // First save the class
      const savedClass = await PlannerService.saveClass(data, consultantId);
      console.log("Class saved successfully:", savedClass);

      // Refresh planner data with React Query
      refreshPlanner();
      setIsClassDialogOpen(false);
      setEditingEvent(null);
    } catch (error) {
      console.error("Error saving/refreshing class:", error);
      throw error; // Propagate error to form handler
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditWebinar = (webinar: WebinarEvent) => {
    setEditingEvent(webinar);
    setIsWebinarDialogOpen(true);
  };

  const handleEditClass = (classEvent: ClassEvent) => {
    setEditingEvent(classEvent);
    setIsClassDialogOpen(true);
  };

  // Handle webinar delete event using React Query
  const handleWebinarDelete = async (webinarId: string) => {
    console.log(`EventManagementDashboard - Deleting webinar: ${webinarId}`);
    deleteWebinar.mutate(webinarId);
  };

  // Handle class delete event using React Query
  const handleClassDelete = async (classId: string) => {
    console.log(`EventManagementDashboard - Deleting class: ${classId}`);
    deleteClass.mutate(classId);
  };

  // Handle consultation plan saved event
  const handleConsultationPlanSaved = async (
    data: Partial<ConsultationPlanEvent>,
  ) => {
    try {
      setIsSaving(true);
      console.log("EventManagementDashboard - Saving consultation plan:", data);

      if (data.consultationPlan?.id) {
        // Update existing plan
        updateConsultationPlan.mutate({
          id: data.consultationPlan.id,
          ...data.consultationPlan,
        });
      } else {
        // Create new plan
        createConsultationPlan.mutate(data.consultationPlan);
      }

      setIsConsultationDialogOpen(false);
      setEditingEvent(null);
    } catch (error) {
      console.error("Error saving consultation plan:", error);
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  // Handle subscription plan saved event
  const handleSubscriptionPlanSaved = async (
    data: Partial<SubscriptionPlanEvent>,
  ) => {
    try {
      setIsSaving(true);
      console.log("EventManagementDashboard - Saving subscription plan:", data);

      if (data.subscriptionPlan?.id) {
        // Update existing plan
        updateSubscriptionPlan.mutate({
          id: data.subscriptionPlan.id,
          ...data.subscriptionPlan,
        });
      } else {
        // Create new plan
        createSubscriptionPlan.mutate(data.subscriptionPlan);
      }

      setIsSubscriptionDialogOpen(false);
      setEditingEvent(null);
    } catch (error) {
      console.error("Error saving subscription plan:", error);
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditConsultationPlan = (
    consultationPlan: ConsultationPlanEvent,
  ) => {
    setEditingEvent(consultationPlan);
    setIsConsultationDialogOpen(true);
  };

  const handleEditSubscriptionPlan = (
    subscriptionPlan: SubscriptionPlanEvent,
  ) => {
    setEditingEvent(subscriptionPlan);
    setIsSubscriptionDialogOpen(true);
  };

  // Handle consultation plan delete event using React Query
  const handleConsultationPlanDelete = async (planId: string) => {
    console.log(
      `EventManagementDashboard - Deleting consultation plan: ${planId}`,
    );
    deleteConsultationPlan.mutate(planId);
  };

  // Handle subscription plan delete event using React Query
  const handleSubscriptionPlanDelete = async (planId: string) => {
    console.log(
      `EventManagementDashboard - Deleting subscription plan: ${planId}`,
    );
    deleteSubscriptionPlan.mutate(planId);
  };

  const handleMonthChange = (direction: "prev" | "next") => {
    setCurrentDate((prevDate) =>
      addMonths(prevDate, direction === "prev" ? -1 : 1),
    );
  };

  if (error) {
    return (
      <div className="container mx-auto p-4">
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="container mx-auto p-4">
        <div className="animate-pulse space-y-8">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="space-y-4">
            <div className="h-4 bg-gray-200 rounded w-1/3"></div>
            <div className="h-32 bg-gray-200 rounded"></div>
          </div>
          <div className="space-y-4">
            <div className="h-4 bg-gray-200 rounded w-1/3"></div>
            <div className="h-32 bg-gray-200 rounded"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-6 py-8">
        {/* Page Header */}
        <div className="mb-12">
          <h1 className="text-4xl font-bold text-gray-900 tracking-tight">
            Event Management Dashboard
          </h1>
          <p className="mt-2 text-lg text-gray-600">
            Manage your service templates and scheduled sessions
          </p>
        </div>

        {/* Section Divider */}
        <div className="relative mb-16">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t-2 border-gray-300"></div>
          </div>
          <div className="relative flex justify-center">
            <div className="bg-gray-50 px-8 py-2">
              <h2 className="text-3xl font-bold text-gray-900">Plan Templates</h2>
              <p className="text-sm text-gray-600 text-center mt-1">
                Create reusable service templates for consultations and subscriptions
              </p>
            </div>
          </div>
        </div>

        {/* Plan Templates Section */}
        <section className="mb-16">

          {/* Consultation Plans */}
          <div className="mb-12">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-semibold text-gray-800">Consultation Plans</h3>
              <Button 
                onClick={() => setIsConsultationDialogOpen(true)}
                className="bg-black hover:bg-gray-800 text-white font-medium"
              >
                Create New Consultation Plan
              </Button>
            </div>
            {consultationPlansLoading ? (
              <div className="animate-pulse space-y-4">
                <div className="h-32 bg-gray-200 rounded-lg"></div>
              </div>
            ) : (
              <EventCarousel
                events={
                  consultationPlans?.map((plan: any) => ({
                    type: "consultation" as const,
                    id: plan.id,
                    consultationPlan: plan,
                  })) || []
                }
                onEdit={handleEditConsultationPlan}
                onDelete={handleConsultationPlanDelete}
                eventType="consultation"
                participantCounts={{}}
              />
            )}
          </div>

          {/* Subscription Plans */}
          <div className="mb-12">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-semibold text-gray-800">Subscription Plans</h3>
              <Button 
                onClick={() => setIsSubscriptionDialogOpen(true)}
                className="bg-black hover:bg-gray-800 text-white font-medium"
              >
                Create New Subscription Plan
              </Button>
            </div>
            {subscriptionPlansLoading ? (
              <div className="animate-pulse space-y-4">
                <div className="h-32 bg-gray-200 rounded-lg"></div>
              </div>
            ) : (
              <EventCarousel
                events={
                  subscriptionPlans?.map((plan: any) => ({
                    type: "subscription" as const,
                    id: plan.id,
                    subscriptionPlan: plan,
                  })) || []
                }
                onEdit={handleEditSubscriptionPlan}
                onDelete={handleSubscriptionPlanDelete}
                eventType="subscription"
                participantCounts={{}}
              />
            )}
          </div>
        </section>

        {/* Section Divider */}
        <div className="relative my-16">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t-2 border-gray-300"></div>
          </div>
          <div className="relative flex justify-center">
            <div className="bg-gray-50 px-8 py-2">
              <h2 className="text-3xl font-bold text-gray-900">Live Sessions</h2>
              <p className="text-sm text-gray-600 text-center mt-1">
                Schedule and manage your live events
              </p>
            </div>
          </div>
        </div>

        {/* Live Sessions Section */}
        <section className="mb-16">
          {/* Webinar Events */}
          <div className="mb-12">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-semibold text-gray-800">Webinar Events</h3>
              <Button 
                onClick={() => setIsWebinarDialogOpen(true)}
                className="bg-black hover:bg-gray-800 text-white font-medium"
              >
                Create New Webinar
              </Button>
            </div>
            <EventCarousel
              events={webinars}
              onEdit={handleEditWebinar}
              onDelete={handleWebinarDelete}
              eventType="webinar"
              participantCounts={initialData?.participantCounts || {}}
            />
          </div>

          {/* Class Events */}
          <div className="mb-12">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-semibold text-gray-800">Class Events</h3>
              <Button 
                onClick={() => setIsClassDialogOpen(true)}
                className="bg-black hover:bg-gray-800 text-white font-medium"
              >
                Create New Class
              </Button>
            </div>
            <EventCarousel
              events={classes}
              onEdit={handleEditClass}
              onDelete={handleClassDelete}
              eventType="class"
              participantCounts={initialData?.participantCounts || {}}
            />
          </div>
        </section>
      </div>

      <EventPlanner
        isOpen={isWebinarDialogOpen}
        onClose={() => {
          setIsWebinarDialogOpen(false);
          setEditingEvent(null);
        }}
        onSaved={handleWebinarSaved}
        eventType="webinar"
        initialData={editingEvent as WebinarEvent}
        consultantId={consultantId}
      />

      <EventPlanner
        isOpen={isClassDialogOpen}
        onClose={() => {
          setIsClassDialogOpen(false);
          setEditingEvent(null);
        }}
        onSaved={handleClassSaved}
        eventType="class"
        initialData={editingEvent as ClassEvent}
        consultantId={consultantId}
      />

      <EventPlanner
        isOpen={isConsultationDialogOpen}
        onClose={() => {
          setIsConsultationDialogOpen(false);
          setEditingEvent(null);
        }}
        onSaved={handleConsultationPlanSaved}
        eventType="consultation"
        initialData={editingEvent as ConsultationPlanEvent}
        consultantId={consultantId}
      />

      <EventPlanner
        isOpen={isSubscriptionDialogOpen}
        onClose={() => {
          setIsSubscriptionDialogOpen(false);
          setEditingEvent(null);
        }}
        onSaved={handleSubscriptionPlanSaved}
        eventType="subscription"
        initialData={editingEvent as SubscriptionPlanEvent}
        consultantId={consultantId}
      />
    </div>
  );
}
