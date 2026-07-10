"use client";

import * as Sentry from "@sentry/nextjs";
import { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { EventCarousel } from "./EventCarousel";
import { EventPlanner } from "./EventPlanner";
// #248 bundle discipline: never statically import the Stream SDK or
// @/lib/meeting (which imports it) — the client singleton is read at
// click time and the meeting helper is lazy-imported on demand.
import { waitForGlobalVideoClient } from "@/lib/stream/disconnect";
import type { MeetingAppointment, MeetingSlot } from "@/lib/meeting";
import {
  WebinarEvent,
  ClassEvent,
  PlannerWebinarEvent,
  PlannerClassEvent,
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

interface PlannerData {
  webinars: PlannerWebinarEvent[];
  classes: PlannerClassEvent[];
  participantCounts: Record<string, number>;
}

interface Props {
  consultantId: string;
  /**
   * Planner payload from the page's ["consultant-planner", …] query — the
   * SINGLE source of truth. Mutations invalidate that key (usePlanner.ts)
   * and fresh data flows back down; this component keeps no local copy.
   * (Previously it seeded useState from this prop while mutations
   * invalidated a key nobody queried, so the UI went stale after every
   * create/edit/delete.)
   */
  data: PlannerData;
}

export function EventManagementDashboard({
  consultantId,
  data,
}: Readonly<Props>) {
  const webinars = data.webinars;
  const classes = data.classes;
  const [isWebinarDialogOpen, setIsWebinarDialogOpen] = useState(false);
  const [isClassDialogOpen, setIsClassDialogOpen] = useState(false);
  const [isConsultationDialogOpen, setIsConsultationDialogOpen] =
    useState(false);
  const [isSubscriptionDialogOpen, setIsSubscriptionDialogOpen] =
    useState(false);
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [_isSaving, setIsSaving] = useState(false);
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
  const router = useRouter();
  const [joiningEventId, setJoiningEventId] = useState<string | null>(null);

  // Compute which webinar/class events are currently joinable (within 10 min before start to end)
  const joinableEventIds = useMemo(() => {
    const now = new Date();
    const ids = new Set<string>();

    for (const webinar of webinars) {
      const startTimeStr =
        webinar.appointment?.slotsOfAppointment?.[0]?.startsAt;
      const endTimeStr = webinar.appointment?.slotsOfAppointment?.[0]?.endsAt;
      if (startTimeStr) {
        const startTime = new Date(startTimeStr);
        const endTime = endTimeStr
          ? new Date(endTimeStr)
          : new Date(
              startTime.getTime() +
                (webinar.webinarPlan.durationInHours ?? 1) * 60 * 60 * 1000,
            );
        const joinWindow = new Date(startTime.getTime() - 10 * 60 * 1000);
        if (now >= joinWindow && now <= endTime && webinar.id) {
          ids.add(webinar.id);
        }
      }
    }

    for (const cls of classes) {
      // For classes, check the nearest upcoming appointment
      const appointments = cls.appointments ?? [];
      for (const appt of appointments) {
        const startTimeStr = appt.slotsOfAppointment?.[0]?.startsAt;
        const endTimeStr = appt.slotsOfAppointment?.[0]?.endsAt;
        if (startTimeStr) {
          const startTime = new Date(startTimeStr);
          const endTime = endTimeStr
            ? new Date(endTimeStr)
            : new Date(startTime.getTime() + 60 * 60 * 1000);
          const joinWindow = new Date(startTime.getTime() - 10 * 60 * 1000);
          if (now >= joinWindow && now <= endTime && cls.id) {
            ids.add(cls.id);
          }
        }
      }
    }

    return ids;
  }, [webinars, classes]);

  // Handle joining a meeting from the planner. Reads the connected video
  // client singleton at click time (HomeTab idiom, #248) so the Stream SDK
  // stays off the planner bundle.
  const handleJoinWebinarMeeting = async (webinar: PlannerWebinarEvent) => {
    const streamClient = await waitForGlobalVideoClient();
    if (!streamClient) {
      toast({
        title: "Connecting…",
        description: "Setting up your meeting client. Please try Join again.",
        variant: "warning",
      });
      return;
    }

    const slot = webinar.appointment?.slotsOfAppointment?.[0];
    if (!slot || !webinar.appointment) {
      toast({
        title: "Error",
        description: "Meeting slot information is not available.",
        variant: "destructive",
      });
      return;
    }

    setJoiningEventId(webinar.id ?? null);
    try {
      const meetingSlot: MeetingSlot = {
        id: slot.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        appointmentId: webinar.appointment.id,
      };
      const meetingAppointment: MeetingAppointment = {
        id: webinar.appointment.id,
        appointmentType: "WEBINAR",
        slotsOfAppointment: [meetingSlot],
        webinar: { webinarPlan: { title: webinar.webinarPlan.title } },
      };
      const { getOrCreateAppointmentMeeting } = await import("@/lib/meeting");
      const meetingId = await getOrCreateAppointmentMeeting(
        streamClient,
        meetingAppointment,
        meetingSlot,
      );
      toast({
        title: "Joining meeting",
        description: "Redirecting to the meeting room.",
      });
      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Error joining webinar meeting:", error);
      toast({
        title: "Error joining meeting",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
      setJoiningEventId(null);
    }
  };

  const handleJoinClassMeeting = async (classEvent: PlannerClassEvent) => {
    const streamClient = await waitForGlobalVideoClient();
    if (!streamClient) {
      toast({
        title: "Connecting…",
        description: "Setting up your meeting client. Please try Join again.",
        variant: "warning",
      });
      return;
    }

    // Find the nearest joinable appointment for this class
    const now = new Date();
    const appointments = classEvent.appointments ?? [];
    let targetAppt = null;
    let targetSlot = null;

    for (const appt of appointments) {
      const slot = appt.slotsOfAppointment?.[0];
      if (slot?.startsAt) {
        const startTime = new Date(slot.startsAt);
        const endTime = slot.endsAt
          ? new Date(slot.endsAt)
          : new Date(startTime.getTime() + 60 * 60 * 1000);
        const joinWindow = new Date(startTime.getTime() - 10 * 60 * 1000);
        if (now >= joinWindow && now <= endTime) {
          targetAppt = appt;
          targetSlot = slot;
          break;
        }
      }
    }

    if (!targetAppt || !targetSlot) {
      toast({
        title: "Error",
        description: "No joinable session found for this class.",
        variant: "destructive",
      });
      return;
    }

    setJoiningEventId(classEvent.id ?? null);
    try {
      const meetingSlot: MeetingSlot = {
        id: targetSlot.id,
        startsAt: targetSlot.startsAt,
        endsAt: targetSlot.endsAt,
        appointmentId: targetAppt.id,
      };
      const meetingAppointment: MeetingAppointment = {
        id: targetAppt.id,
        appointmentType: "CLASS",
        slotsOfAppointment: [meetingSlot],
        class: { classPlan: { title: classEvent.classPlan.title } },
      };
      const { getOrCreateAppointmentMeeting } = await import("@/lib/meeting");
      const meetingId = await getOrCreateAppointmentMeeting(
        streamClient,
        meetingAppointment,
        meetingSlot,
      );
      toast({
        title: "Joining meeting",
        description: "Redirecting to the meeting room.",
      });
      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Error joining class meeting:", error);
      toast({
        title: "Error joining meeting",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
      setJoiningEventId(null);
    }
  };

  // Trial management state - just counts for badge display
  const [pendingTrialCounts, setPendingTrialCounts] = useState<
    Record<string, number>
  >({});

  // Fetch pending trial counts for subscription plans
  const fetchTrialCounts = useCallback(async () => {
    if (!consultantId) return;

    try {
      const response = await fetch(
        `/api/trials?consultantProfileId=${consultantId}&status=PENDING`,
      );
      if (!response.ok) return;

      const { data } = await response.json();
      // Group by subscriptionPlanId
      const counts = data.reduce(
        (
          acc: Record<string, number>,
          trial: { subscriptionPlanId: string },
        ) => {
          acc[trial.subscriptionPlanId] =
            (acc[trial.subscriptionPlanId] || 0) + 1;
          return acc;
        },
        {},
      );
      setPendingTrialCounts(counts);
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Error fetching trial counts:", error);
    }
  }, [consultantId]);

  // Fetch trial counts on mount and when subscription plans change
  useEffect(() => {
    fetchTrialCounts();
  }, [fetchTrialCounts, subscriptionPlans]);

  // Redirect to Free Trials tab when clicking trial button
  const handleTrialsClick = () => {
    router.push(`/dashboard/consultant/${consultantId}/trials`);
  };

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
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
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
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
      console.error("Error saving/refreshing class:", error);
      throw error; // Propagate error to form handler
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditWebinar = (webinar: PlannerWebinarEvent) => {
    setEditingEvent(webinar);
    setIsWebinarDialogOpen(true);
  };

  const handleEditClass = (classEvent: PlannerClassEvent) => {
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
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "client" } });
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

  // Calculate stats
  const totalPlans =
    (consultationPlans?.length ?? 0) + (subscriptionPlans?.length ?? 0);
  const totalSessions = webinars.length + classes.length;

  return (
    <div>
      <div className="w-full">
        {/* Quick Stats — the page title lives in the page-level
            DashboardHeader; only the live counters render here. */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-8 flex flex-wrap items-center gap-2 sm:gap-3"
        >
          <div className="flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full bg-zinc-100 border border-zinc-200/60">
            <LayoutTemplate className="h-4 w-4 text-zinc-600" />
            <span className="text-xs sm:text-sm font-medium text-zinc-700">
              {totalPlans} Plans
            </span>
          </div>
          <div className="flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full bg-zinc-100 border border-zinc-200/60">
            <Radio className="h-4 w-4 text-zinc-600" />
            <span className="text-xs sm:text-sm font-medium text-zinc-700">
              {totalSessions} Upcoming Sessions
            </span>
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
                pendingTrialCounts={pendingTrialCounts}
                onTrialsClick={handleTrialsClick}
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
              participantCounts={data.participantCounts ?? {}}
              onJoinMeeting={handleJoinWebinarMeeting}
              joinableEventIds={joinableEventIds}
              joiningEventId={joiningEventId}
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
              participantCounts={data.participantCounts ?? {}}
              onJoinMeeting={handleJoinClassMeeting}
              joinableEventIds={joinableEventIds}
              joiningEventId={joiningEventId}
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
