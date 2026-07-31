"use client";

import * as Sentry from "@sentry/nextjs";
import { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { EventCarousel } from "./EventCarousel";
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
} from "@/types/planner-events";
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
} from "../hooks/usePlanner";
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

  // Trials live on Appointments now (ADR 19 — a trial IS an appointment), so
  // this deep-links to the tab rather than the retired standalone route.
  const handleTrialsClick = () => {
    router.push(
      `/dashboard/consultant/${consultantId}/appointments?tab=trials`,
    );
  };

  // Handle webinar saved event

  // Handle class saved event

  // Editing routes to the offering editor rather than reopening a dialog, so
  // an offering has one authoring surface and a URL you can return to.
  const editHref = (type: string, id: string) =>
    `/dashboard/consultant/${consultantId}/offerings/${type}/${id}/edit`;

  const handleEditWebinar = (webinar: PlannerWebinarEvent) => {
    router.push(editHref("webinar", webinar.id));
  };

  const handleEditClass = (classEvent: PlannerClassEvent) => {
    router.push(editHref("class", classEvent.id));
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

  // Handle subscription plan saved event

  const handleEditConsultationPlan = (
    consultationPlan: ConsultationPlanEvent,
  ) => {
    router.push(editHref("consultation", consultationPlan.id ?? ""));
  };

  const handleEditSubscriptionPlan = (
    subscriptionPlan: SubscriptionPlanEvent,
  ) => {
    router.push(editHref("subscription", subscriptionPlan.id ?? ""));
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
          className="mb-8 flex flex-wrap items-center gap-2 sm:mb-10 sm:gap-3"
        >
          <div className="flex items-center gap-2 rounded-xl border border-zinc-200/80 bg-white px-3.5 py-2 shadow-sm">
            <LayoutTemplate className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-800">
              {totalPlans}{" "}
              <span className="font-normal text-zinc-500">Plans</span>
            </span>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-zinc-200/80 bg-white px-3.5 py-2 shadow-sm">
            <Radio className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-800">
              {totalSessions}{" "}
              <span className="font-normal text-zinc-500">
                Upcoming Sessions
              </span>
            </span>
          </div>
        </motion.div>

        {/* Plan Templates Section */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="mb-12 sm:mb-16"
        >
          <div className="mb-6 sm:mb-8">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-900 sm:text-xl">
              Plan Templates
            </h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              Create reusable service templates
            </p>
          </div>

          {/* Consultation Plans */}
          <div className="mb-8 sm:mb-10">
            <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-50 ring-1 ring-sky-100">
                  <MessageSquare className="h-4 w-4 text-sky-700" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 sm:text-base">
                    Consultation Plans
                  </h3>
                  <p className="text-xs text-zinc-500 sm:text-sm">
                    One-on-one session templates
                  </p>
                </div>
              </div>
              <Button
                onClick={() =>
                  router.push(
                    `/dashboard/consultant/${consultantId}/offerings/consultation/new`,
                  )
                }
                variant="outline"
                className="w-full gap-2 border-zinc-200 bg-white font-medium text-zinc-900 hover:bg-zinc-50 sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                New Plan
              </Button>
            </div>
            {consultationPlansLoading ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
                {[...Array(3)].map((_, i) => (
                  <div
                    key={i}
                    className="h-52 animate-pulse rounded-2xl bg-zinc-100"
                  />
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
          <div>
            <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-teal-50 ring-1 ring-teal-100">
                  <CalendarRange className="h-4 w-4 text-teal-700" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 sm:text-base">
                    Subscription Plans
                  </h3>
                  <p className="text-xs text-zinc-500 sm:text-sm">
                    Recurring mentorship offerings
                  </p>
                </div>
              </div>
              <Button
                onClick={() =>
                  router.push(
                    `/dashboard/consultant/${consultantId}/offerings/subscription/new`,
                  )
                }
                variant="outline"
                className="w-full gap-2 border-zinc-200 bg-white font-medium text-zinc-900 hover:bg-zinc-50 sm:w-auto"
              >
                <Plus className="h-4 w-4" />
                New Plan
              </Button>
            </div>
            {subscriptionPlansLoading ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
                {[...Array(3)].map((_, i) => (
                  <div
                    key={i}
                    className="h-52 animate-pulse rounded-2xl bg-zinc-100"
                  />
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
          className="mb-12 sm:mb-16"
        >
          <div className="mb-6 sm:mb-8">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-900 sm:text-xl">
              Live Sessions
            </h2>
            <p className="mt-0.5 text-sm text-zinc-500">
              Schedule and manage your live events
            </p>
          </div>

          {/* Webinar Events */}
          <div className="mb-8 sm:mb-10">
            <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 ring-1 ring-emerald-100">
                  <Video className="h-4 w-4 text-emerald-700" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 sm:text-base">
                    Webinar Events
                  </h3>
                  <p className="text-xs text-zinc-500 sm:text-sm">
                    Live sessions with multiple participants
                  </p>
                </div>
              </div>
              <Button
                onClick={() =>
                  router.push(
                    `/dashboard/consultant/${consultantId}/offerings/webinar/new`,
                  )
                }
                variant="outline"
                className="w-full gap-2 border-zinc-200 bg-white font-medium text-zinc-900 hover:bg-zinc-50 sm:w-auto"
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
          <div>
            <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 ring-1 ring-amber-100">
                  <GraduationCap className="h-4 w-4 text-amber-700" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 sm:text-base">
                    Class Events
                  </h3>
                  <p className="text-xs text-zinc-500 sm:text-sm">
                    Multi-session structured learning
                  </p>
                </div>
              </div>
              <Button
                onClick={() =>
                  router.push(
                    `/dashboard/consultant/${consultantId}/offerings/class/new`,
                  )
                }
                variant="outline"
                className="w-full gap-2 border-zinc-200 bg-white font-medium text-zinc-900 hover:bg-zinc-50 sm:w-auto"
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

    </div>
  );
}
