"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
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
import type { ConsultationPlan, SubscriptionPlan } from "@/schemas/plans";
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
import {
  LayoutTemplate,
  Radio,
  Plus,
  MessageSquare,
  CalendarRange,
  Video,
  GraduationCap,
} from "lucide-react";
import { cn } from "@/utils/tailwind";

interface PlannerData {
  webinars: WebinarEvent[];
  classes: ClassEvent[];
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

        // Use the service to fetch data with consistent date filtering
        const [fetchedWebinars, fetchedClasses] = await Promise.all([
          PlannerService.fetchWebinars(consultantId, startDate, endDate),
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
  const handleClassSaved = async (
    data: Partial<ClassEvent>,
    startDate?: string,
  ) => {
    try {
      setIsSaving(true);
      console.log("EventManagementDashboard - Saving class:", data);
      console.log("EventManagementDashboard - Class startDate:", startDate);

      // First save the class with startDate
      const savedClass = await PlannerService.saveClass(
        data,
        consultantId,
        startDate,
      );
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
  ): Promise<void> => {
    try {
      setIsSaving(true);
      console.log("EventManagementDashboard - Saving consultation plan:", data);

      // Transform topics to string[] for API compatibility
      const planData = {
        ...data.consultationPlan,
        topics: data.consultationPlan?.topics ?? [],
      };

      if (data.consultationPlan?.id) {
        // Update existing plan - use mutateAsync to return a Promise
        await updateConsultationPlan.mutateAsync({
          id: data.consultationPlan.id,
          ...planData,
        });
      } else {
        // Create new plan - use mutateAsync to return a Promise
        await createConsultationPlan.mutateAsync(planData);
      }

      // Dialog closing is handled by the form component after awaiting this Promise
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
  ): Promise<void> => {
    try {
      setIsSaving(true);
      console.log("EventManagementDashboard - Saving subscription plan:", data);

      // Transform topics to string[] for API compatibility
      const planData = {
        ...data.subscriptionPlan,
        topics: data.subscriptionPlan?.topics ?? [],
      };

      if (data.subscriptionPlan?.id) {
        // Update existing plan - use mutateAsync to return a Promise
        await updateSubscriptionPlan.mutateAsync({
          id: data.subscriptionPlan.id,
          ...planData,
        });
      } else {
        // Create new plan - use mutateAsync to return a Promise
        await createSubscriptionPlan.mutateAsync(planData);
      }

      // Dialog closing is handled by the form component after awaiting this Promise
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
      <div className="min-h-screen bg-white">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <div className="animate-pulse space-y-8 sm:space-y-12">
            {/* Header skeleton */}
            <div className="space-y-3">
              <div className="h-8 sm:h-10 bg-zinc-200 rounded-lg w-64 sm:w-80"></div>
              <div className="h-4 sm:h-5 bg-zinc-200 rounded w-72 sm:w-96"></div>
              <div className="flex flex-wrap gap-2 sm:gap-3 mt-4">
                <div className="h-8 bg-zinc-200 rounded-full w-24 sm:w-28"></div>
                <div className="h-8 bg-zinc-200 rounded-full w-28 sm:w-32"></div>
              </div>
            </div>

            {/* Section skeleton */}
            <div className="space-y-6">
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="h-10 w-10 sm:h-12 sm:w-12 bg-zinc-200 rounded-xl"></div>
                <div className="space-y-2">
                  <div className="h-5 sm:h-6 bg-zinc-200 rounded w-32 sm:w-40"></div>
                  <div className="h-3 sm:h-4 bg-zinc-200 rounded w-48 sm:w-64"></div>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4 sm:gap-5 lg:gap-6">
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="h-56 sm:h-64 bg-zinc-200 rounded-xl"
                  ></div>
                ))}
              </div>
            </div>

            {/* Section skeleton */}
            <div className="space-y-6">
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="h-10 w-10 sm:h-12 sm:w-12 bg-zinc-200 rounded-xl"></div>
                <div className="space-y-2">
                  <div className="h-5 sm:h-6 bg-zinc-200 rounded w-28 sm:w-36"></div>
                  <div className="h-3 sm:h-4 bg-zinc-200 rounded w-44 sm:w-56"></div>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4 sm:gap-5 lg:gap-6">
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="h-56 sm:h-64 bg-zinc-200 rounded-xl"
                  ></div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Calculate stats
  const totalPlans =
    (consultationPlans?.length ?? 0) + (subscriptionPlans?.length ?? 0);
  const totalSessions = webinars.length + classes.length;

  return (
    <div className="min-h-screen bg-white">
      <div className="w-full px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* Page Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-8 sm:mb-12"
        >
          <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-zinc-900 tracking-tight">
            Event Management
          </h1>
          <p className="mt-1 sm:mt-2 text-sm sm:text-base lg:text-lg text-zinc-500">
            Manage your service templates and scheduled sessions
          </p>

          {/* Quick Stats */}
          <div className="mt-4 sm:mt-6 flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full bg-zinc-100 border border-zinc-200/60">
              <LayoutTemplate className="h-4 w-4 text-zinc-600" />
              <span className="text-xs sm:text-sm font-medium text-zinc-700">
                {totalPlans} Plans
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full bg-zinc-100 border border-zinc-200/60">
              <Radio className="h-4 w-4 text-zinc-600" />
              <span className="text-xs sm:text-sm font-medium text-zinc-700">
                {totalSessions} Live Sessions
              </span>
            </div>
          </div>
        </motion.div>

        {/* Plan Templates Section */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="mb-10 sm:mb-16"
        >
          {/* Section Header */}
          <div className="flex items-center gap-3 sm:gap-4 mb-6 sm:mb-8">
            <div className="flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-xl bg-zinc-900 shrink-0">
              <LayoutTemplate className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl sm:text-2xl font-bold text-zinc-900">
                Plan Templates
              </h2>
              <p className="text-xs sm:text-sm text-zinc-500">
                Create reusable service templates
              </p>
            </div>
            <div className="flex-1 h-px bg-gradient-to-r from-zinc-200 to-transparent hidden sm:block" />
          </div>

          {/* Consultation Plans */}
          <div className="mb-6 sm:mb-10 bg-zinc-50/50 border border-zinc-100 rounded-xl p-4 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-4 sm:mb-6">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50 shrink-0">
                  <MessageSquare className="h-4 w-4 sm:h-5 sm:w-5 text-blue-600" />
                </div>
                <div>
                  <h3 className="text-base sm:text-lg font-semibold text-zinc-900">
                    Consultation Plans
                  </h3>
                  <p className="text-xs sm:text-sm text-zinc-500">
                    One-on-one session templates
                  </p>
                </div>
              </div>
              <Button
                onClick={() => setIsConsultationDialogOpen(true)}
                className="bg-zinc-900 hover:bg-zinc-800 text-white font-medium gap-2 w-full sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                New Plan
              </Button>
            </div>
            {consultationPlansLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4 sm:gap-5 lg:gap-6">
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="h-56 sm:h-64 bg-zinc-200 rounded-xl animate-pulse"
                  ></div>
                ))}
              </div>
            ) : (
              <EventCarousel
                events={
                  consultationPlans?.map(
                    (plan: ConsultationPlan & { id: string }) => ({
                      type: "consultation" as const,
                      id: plan.id,
                      consultationPlan: plan,
                    }),
                  ) || []
                }
                onEdit={handleEditConsultationPlan}
                onDelete={handleConsultationPlanDelete}
                eventType="consultation"
                participantCounts={{}}
              />
            )}
          </div>

          {/* Subscription Plans */}
          <div className="bg-zinc-50/50 border border-zinc-100 rounded-xl p-4 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-4 sm:mb-6">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-50 shrink-0">
                  <CalendarRange className="h-4 w-4 sm:h-5 sm:w-5 text-purple-600" />
                </div>
                <div>
                  <h3 className="text-base sm:text-lg font-semibold text-zinc-900">
                    Subscription Plans
                  </h3>
                  <p className="text-xs sm:text-sm text-zinc-500">
                    Recurring mentorship offerings
                  </p>
                </div>
              </div>
              <Button
                onClick={() => setIsSubscriptionDialogOpen(true)}
                className="bg-zinc-900 hover:bg-zinc-800 text-white font-medium gap-2 w-full sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                New Plan
              </Button>
            </div>
            {subscriptionPlansLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4 sm:gap-5 lg:gap-6">
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="h-56 sm:h-64 bg-zinc-200 rounded-xl animate-pulse"
                  ></div>
                ))}
              </div>
            ) : (
              <EventCarousel
                events={
                  subscriptionPlans?.map(
                    (plan: SubscriptionPlan & { id: string }) => ({
                      type: "subscription" as const,
                      id: plan.id,
                      subscriptionPlan: plan,
                    }),
                  ) || []
                }
                onEdit={handleEditSubscriptionPlan}
                onDelete={handleSubscriptionPlanDelete}
                eventType="subscription"
                participantCounts={{}}
              />
            )}
          </div>
        </motion.section>

        {/* Live Sessions Section */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          className="mb-10 sm:mb-16"
        >
          {/* Section Header */}
          <div className="flex items-center gap-3 sm:gap-4 mb-6 sm:mb-8">
            <div className="flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-xl bg-zinc-900 shrink-0">
              <Radio className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl sm:text-2xl font-bold text-zinc-900">
                Live Sessions
              </h2>
              <p className="text-xs sm:text-sm text-zinc-500">
                Schedule and manage your live events
              </p>
            </div>
            <div className="flex-1 h-px bg-gradient-to-r from-zinc-200 to-transparent hidden sm:block" />
          </div>

          {/* Webinar Events */}
          <div className="mb-6 sm:mb-10 bg-zinc-50/50 border border-zinc-100 rounded-xl p-4 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-4 sm:mb-6">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 shrink-0">
                  <Video className="h-4 w-4 sm:h-5 sm:w-5 text-emerald-600" />
                </div>
                <div>
                  <h3 className="text-base sm:text-lg font-semibold text-zinc-900">
                    Webinar Events
                  </h3>
                  <p className="text-xs sm:text-sm text-zinc-500">
                    Live sessions with multiple participants
                  </p>
                </div>
              </div>
              <Button
                onClick={() => setIsWebinarDialogOpen(true)}
                className="bg-zinc-900 hover:bg-zinc-800 text-white font-medium gap-2 w-full sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                New Webinar
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
          <div className="bg-zinc-50/50 border border-zinc-100 rounded-xl p-4 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-4 sm:mb-6">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 shrink-0">
                  <GraduationCap className="h-4 w-4 sm:h-5 sm:w-5 text-amber-600" />
                </div>
                <div>
                  <h3 className="text-base sm:text-lg font-semibold text-zinc-900">
                    Class Events
                  </h3>
                  <p className="text-xs sm:text-sm text-zinc-500">
                    Multi-session structured learning
                  </p>
                </div>
              </div>
              <Button
                onClick={() => setIsClassDialogOpen(true)}
                className="bg-zinc-900 hover:bg-zinc-800 text-white font-medium gap-2 w-full sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                New Class
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
        </motion.section>
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
