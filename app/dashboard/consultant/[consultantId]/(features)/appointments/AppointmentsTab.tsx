"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  getOrCreateAppointmentMeeting,
  MeetingAppointment,
  MeetingSlot,
} from "@/lib/meeting";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Users,
  Gift,
  Video,
  Loader2,
  Search,
} from "lucide-react";
import {
  AppointmentsTabProps,
  ScheduledTrial,
  UnscheduledClass,
  UnscheduledWebinar,
  getBadgeStyle,
} from "../../types";
import {
  buildSyntheticClassAppointment,
  buildSyntheticWebinarAppointment,
} from "./utils/syntheticAppointments";
import { UnscheduledEventCard } from "./components/UnscheduledEventCard";
import { TAppointment } from "@/types/appointment";
import {
  calculateSessionProgress,
  formatAppointmentTime,
  getAppointmentStatus,
  getAppointmentTypeAndPlan,
  getConsumeeImage,
  getConsumeeName,
  getGroupStatus,
  getGroupTitle,
  getStartTime,
  groupRecurringAppointments,
  groupAppointmentsByType,
  getAppointmentTypeDisplayName,
  getCollaboratorRole,
  formatCollaboratorRole,
  getRoleBadgeStyle,
} from "../../utils/appointmentHelpers";
import { EventTimingsCalendar } from "./components/EventTimingsCalendar";
import {
  canManageAppointmentTimings,
  canManageGroupTimings,
} from "./utils/appointmentTimingHelpers";
import {
  getParticipantManagementUrl,
  supportsParticipantManagement,
} from "./utils/participantHelpers";

export function AppointmentsTab({
  appointments,
  badgeStyles,
  scheduledTrials = [],
  consultantId,
  unscheduledClasses = [],
  unscheduledWebinars = [],
}: Readonly<AppointmentsTabProps>) {
  const router = useRouter();
  const client = useStreamVideoClient();
  const { toast } = useToast();
  const [joiningTrialId, setJoiningTrialId] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const [selectedAppointment, setSelectedAppointment] =
    useState<TAppointment | null>(null);
  const [selectedGroupProgress, setSelectedGroupProgress] = useState<{
    completedSessions: number;
    totalSessions: number;
  } | null>(null);
  const [groupPagination, setGroupPagination] = useState<
    Map<string, { currentPage: number; showAll: boolean }>
  >(new Map());
  const [highlightedGroup, setHighlightedGroup] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | "UPCOMING" | "COMPLETED" | "CANCELLED"
  >("ALL");
  const groupRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const PAGE_SIZE = 5; // Show 5 items per page

  // Handle highlight from URL parameter
  useEffect(() => {
    const highlight = searchParams?.get("highlight");
    if (highlight) {
      setHighlightedGroup(highlight);

      // Scroll to highlighted group
      setTimeout(() => {
        const element = groupRefs.current.get(highlight);
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);

      // Remove highlight after 3 seconds
      setTimeout(() => {
        setHighlightedGroup(null);
      }, 3000);
    }
  }, [searchParams]);

  const getPaginationState = (groupKey: string) => {
    return groupPagination.get(groupKey) || { currentPage: 1, showAll: false };
  };

  const setPage = (groupKey: string, page: number) => {
    setGroupPagination((prev) => {
      const newMap = new Map(prev);
      newMap.set(groupKey, { currentPage: page, showAll: false });
      return newMap;
    });
  };

  const toggleShowAll = (groupKey: string) => {
    setGroupPagination((prev) => {
      const newMap = new Map(prev);
      const current = prev.get(groupKey) || { currentPage: 1, showAll: false };
      newMap.set(groupKey, { currentPage: 1, showAll: !current.showAll });
      return newMap;
    });
  };

  // Helper to get consultant ID from appointment
  const getConsultantIdFromAppointment = (
    appointment: TAppointment,
  ): string => {
    switch (appointment.appointmentType) {
      case "CONSULTATION":
        return (
          appointment.consultation?.consultationPlan?.consultantProfileId || ""
        );
      case "SUBSCRIPTION":
        return (
          appointment.subscription?.subscriptionPlan?.consultantProfileId || ""
        );
      case "WEBINAR":
        return appointment.webinar?.webinarPlan?.consultantProfileId || "";
      case "CLASS":
        return appointment.class?.classPlan?.consultantProfileId || "";
      default:
        return "";
    }
  };

  const getStyleFromBadgeData = (status: string): string => {
    return getBadgeStyle(status);
  };

  const handleJoinMeeting = async (appointment: TAppointment) => {
    if (!client) {
      console.warn("Stream client not ready");
      toast({
        title: "Not signed in",
        description:
          "Video client not initialized. You have to sign in to join a meeting.",
        variant: "warning",
      });
      return;
    }
    const relevantSlot = appointment.slotsOfAppointment?.[0];
    if (!relevantSlot) {
      toast({
        title: "Error",
        description: "Slot information missing for this appointment item.",
        variant: "error",
      });
      return;
    }

    try {
      const meetingId = await getOrCreateAppointmentMeeting(
        client,
        appointment,
        relevantSlot,
      );
      router.push(`/meetings/${meetingId}`);
      toast({
        title: "Joining meeting",
        description: "You will now be redirected to the meeting",
        variant: "success",
      });
    } catch (error) {
      console.error("Error joining meeting:", error);
      toast({
        title: "Error joining meeting",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  // Helper to check if a trial is joinable (within 10 mins before start and before end)
  const isTrialJoinable = (trial: ScheduledTrial): boolean => {
    if (!trial.appointment?.slotsOfAppointment?.[0]) return false;
    const slot = trial.appointment.slotsOfAppointment[0];
    const now = new Date();
    const startTime = new Date(slot.startsAt);
    const endTime = slot.endsAt
      ? new Date(slot.endsAt)
      : new Date(startTime.getTime() + 60 * 60 * 1000);
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) return false;
    const joinWindowStart = new Date(startTime.getTime() - 10 * 60 * 1000);
    return now >= joinWindowStart && now <= endTime;
  };

  // Handle joining a trial meeting
  const handleJoinTrialMeeting = async (trial: ScheduledTrial) => {
    if (!client) {
      toast({
        title: "Not signed in",
        description: "Video client not initialized. Please sign in to join.",
        variant: "warning",
      });
      return;
    }
    if (!trial.appointment?.slotsOfAppointment?.[0]) {
      toast({
        title: "Error",
        description: "Meeting information is not available.",
        variant: "destructive",
      });
      return;
    }
    setJoiningTrialId(trial.id);
    try {
      const trialSlot = trial.appointment.slotsOfAppointment[0];
      const slot: MeetingSlot = {
        id: trialSlot.id,
        startsAt: trialSlot.startsAt,
        endsAt: trialSlot.endsAt,
        appointmentId: trial.appointment.id,
      };
      const appointmentForMeeting: MeetingAppointment = {
        id: trial.appointment.id,
        appointmentType: "TRIAL",
        slotsOfAppointment: [slot],
      };
      const meetingId = await getOrCreateAppointmentMeeting(
        client,
        appointmentForMeeting,
        slot,
      );
      toast({
        title: "Joining meeting",
        description: "You will now be redirected to the meeting room.",
      });
      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      console.error("Error joining trial meeting:", error);
      toast({
        title: "Error joining meeting",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
      setJoiningTrialId(null);
    }
  };

  const formatTrialTime = (dateString: string) => {
    return new Date(dateString).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };

  // Apply search and status filters
  const filteredAppointments = useMemo(() => {
    return (appointments || []).filter((apt) => {
      // Status filter
      if (statusFilter !== "ALL") {
        const s = getAppointmentStatus(apt);
        if (
          statusFilter === "UPCOMING" &&
          (s === "Completed" || s === "Cancelled" || s === "Not Scheduled")
        )
          return false;
        if (statusFilter === "COMPLETED" && s !== "Completed") return false;
        if (statusFilter === "CANCELLED" && s !== "Cancelled") return false;
      }
      // Name/plan search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        if (
          !getConsumeeName(apt).toLowerCase().includes(q) &&
          !getAppointmentTypeAndPlan(apt).toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [appointments, statusFilter, searchQuery]);

  // Keep unfiltered counts for section headers
  const allAppointmentsByType = groupAppointmentsByType(appointments || []);

  // Group filtered appointments by type
  const appointmentsByType = groupAppointmentsByType(filteredAppointments);

  // Further group recurring appointments (subscriptions/classes) within each type
  const groupedAppointments = Object.entries(appointmentsByType).reduce(
    (acc, [type, typeAppointments]) => {
      // If this type has no appointments, create an empty group to show the section
      if (typeAppointments.length === 0) {
        acc[`${type}-empty`] = [];
        return acc;
      }

      // For SUBSCRIPTION and CLASS types, further group by recurring sessions
      if (type === "SUBSCRIPTION" || type === "CLASS") {
        const recurringGroups = groupRecurringAppointments(typeAppointments);
        Object.entries(recurringGroups).forEach(([key, appointments]) => {
          acc[`${type}-${key}`] = appointments;
        });
      } else {
        // For CONSULTATION and WEBINAR, each appointment is its own group
        typeAppointments.forEach((appointment) => {
          acc[`${type}-${appointment.id}`] = [appointment];
        });
      }
      return acc;
    },
    {} as { [key: string]: TAppointment[] },
  );

  // Sort groups by appointment type order
  const typeOrder = ["CONSULTATION", "SUBSCRIPTION", "WEBINAR", "CLASS"];
  const sortedGroupedAppointments = Object.entries(groupedAppointments).sort(
    ([keyA], [keyB]) => {
      const typeA = keyA.split("-")[0];
      const typeB = keyB.split("-")[0];
      return typeOrder.indexOf(typeA) - typeOrder.indexOf(typeB);
    },
  );

  return (
    <div className="bg-white p-4 sm:p-6 rounded-lg shadow">
      <h2 className="text-xl font-semibold mb-4 text-gray-800">
        All Appointments
      </h2>
      <div className="space-y-3 mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Search by name or plan..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 h-10"
          />
        </div>
        <div className="flex items-center gap-2 border-b border-zinc-200 overflow-x-auto">
          {(
            [
              { label: "All", value: "ALL" },
              { label: "Upcoming", value: "UPCOMING" },
              { label: "Completed", value: "COMPLETED" },
              { label: "Cancelled", value: "CANCELLED" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.value}
              onClick={() => setStatusFilter(tab.value)}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                statusFilter === tab.value
                  ? "border-zinc-900 text-zinc-900"
                  : "border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-6">
        {(() => {
          let currentType: string | null = null;

          return sortedGroupedAppointments.map(
            ([groupKey, groupAppointments]) => {
              const groupType = groupKey.split("-")[0];
              const isNewTypeSection = currentType !== groupType;

              if (isNewTypeSection) {
                currentType = groupType;
              }

              const isRecurring =
                groupKey.startsWith("SUBSCRIPTION-subscription-") ||
                groupKey.startsWith("CLASS-class-");
              const groupTitle = getGroupTitle(groupAppointments);
              const groupStatus = getGroupStatus(groupAppointments);
              const firstAppointment = groupAppointments[0];

              // Calculate session progress for recurring appointments
              const {
                totalSessions,
                completedSessions,
                remainingSessions,
                progressPercentage,
              } = calculateSessionProgress(groupAppointments);

              return (
                <div key={groupKey}>
                  {/* Type Section Header */}
                  {isNewTypeSection && (
                    <div className="mb-4 pt-6 first:pt-0">
                      <h3 className="text-lg font-semibold text-gray-900 border-b-2 border-gray-300 pb-2">
                        {getAppointmentTypeDisplayName(groupType)}
                        <span className="text-sm font-normal text-gray-500 ml-2">
                          ({(allAppointmentsByType[groupType]?.length ?? 0) +
                            (groupType === "CLASS"
                              ? unscheduledClasses.length
                              : 0) +
                            (groupType === "WEBINAR"
                              ? unscheduledWebinars.length
                              : 0)})
                        </span>
                      </h3>
                    </div>
                  )}

                  {/* Free Trials Sub-section (only for SUBSCRIPTION type) */}
                  {isNewTypeSection &&
                    groupType === "SUBSCRIPTION" &&
                    scheduledTrials.length > 0 && (
                      <div className="mb-6 bg-purple-50/50 border border-purple-200 rounded-lg p-4">
                        <h4 className="text-sm font-semibold text-purple-700 mb-3 flex items-center gap-2">
                          <Gift className="h-4 w-4" />
                          Free Trial Sessions ({scheduledTrials.length})
                        </h4>
                        <div className="space-y-3">
                          {scheduledTrials.map((trial) => (
                            <div
                              key={trial.id}
                              className="border border-purple-200 rounded-lg p-4 bg-purple-50/50"
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <Avatar className="h-10 w-10">
                                    <AvatarImage
                                      src={
                                        trial.consulteeProfile.user.image || ""
                                      }
                                      alt={trial.consulteeProfile.user.name}
                                    />
                                    <AvatarFallback>
                                      {trial.consulteeProfile.user.name
                                        .split(" ")
                                        .map((n) => n[0])
                                        .join("")}
                                    </AvatarFallback>
                                  </Avatar>
                                  <div>
                                    <p className="font-medium text-gray-900">
                                      {trial.consulteeProfile.user.name}
                                    </p>
                                    <p className="text-sm text-gray-600">
                                      {trial.subscriptionPlan.title} •{" "}
                                      {
                                        trial.subscriptionPlan
                                          .freeTrialDurationMinutes
                                      }{" "}
                                      min trial
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3">
                                  <div className="text-right">
                                    <Badge className="bg-purple-100 text-purple-800">
                                      Trial
                                    </Badge>
                                    {trial.appointment
                                      ?.slotsOfAppointment?.[0] && (
                                      <p className="text-xs text-gray-500 mt-1">
                                        {formatTrialTime(
                                          trial.appointment
                                            .slotsOfAppointment[0].startsAt,
                                        )}
                                      </p>
                                    )}
                                  </div>
                                  <Button
                                    size="sm"
                                    onClick={() =>
                                      handleJoinTrialMeeting(trial)
                                    }
                                    disabled={
                                      joiningTrialId === trial.id ||
                                      !isTrialJoinable(trial)
                                    }
                                    className={
                                      isTrialJoinable(trial)
                                        ? "bg-purple-600 hover:bg-purple-700"
                                        : ""
                                    }
                                  >
                                    {joiningTrialId === trial.id ? (
                                      <>
                                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                        Joining...
                                      </>
                                    ) : (
                                      <>
                                        <Video className="h-4 w-4 mr-1" />
                                        Join
                                      </>
                                    )}
                                  </Button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                  {/* Unscheduled events — rendered once per section, before any scheduled groups */}
                  {isNewTypeSection &&
                    groupType === "CLASS" &&
                    unscheduledClasses.length > 0 && (
                      <div className="mb-4">
                        <h4 className="text-sm font-semibold text-orange-700 mb-3 flex items-center gap-2">
                          <Clock className="h-4 w-4" />
                          Unscheduled Classes ({unscheduledClasses.length})
                        </h4>
                        <div className="space-y-3">
                          {unscheduledClasses.map((classEvent) => (
                            <UnscheduledEventCard
                              key={classEvent.id}
                              title={classEvent.classPlan.title}
                              subtitle={`${classEvent.classPlan.meetingsPerWeek} meeting${classEvent.classPlan.meetingsPerWeek !== 1 ? "s" : ""}/week · ${classEvent.classPlan.totalSessions} sessions · ${classEvent.classPlan.sessionDurationInHours}h each`}
                              onSetSchedule={() => {
                                setSelectedAppointment(
                                  buildSyntheticClassAppointment(classEvent),
                                );
                                setSelectedGroupProgress(null);
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  {isNewTypeSection &&
                    groupType === "WEBINAR" &&
                    unscheduledWebinars.length > 0 && (
                      <div className="mb-4">
                        <h4 className="text-sm font-semibold text-orange-700 mb-3 flex items-center gap-2">
                          <Clock className="h-4 w-4" />
                          Unscheduled Webinars ({unscheduledWebinars.length})
                        </h4>
                        <div className="space-y-3">
                          {unscheduledWebinars.map((webinarEvent) => (
                            <UnscheduledEventCard
                              key={webinarEvent.id}
                              title={webinarEvent.webinarPlan.title}
                              subtitle={`Single session · ${webinarEvent.webinarPlan.durationInHours}h`}
                              onSetSchedule={() => {
                                setSelectedAppointment(
                                  buildSyntheticWebinarAppointment(webinarEvent),
                                );
                                setSelectedGroupProgress(null);
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                  {/* Empty state — only shown when section has no scheduled appointments
                      AND no unscheduled items were already rendered above */}
                  {groupAppointments.length === 0 ? (
                    (groupType === "CLASS" && unscheduledClasses.length > 0) ||
                    (groupType === "WEBINAR" &&
                      unscheduledWebinars.length > 0) ? null : (
                      <div className="border rounded-lg p-8 bg-gray-50 text-center">
                        <p className="text-gray-500 text-sm">
                          No{" "}
                          {getAppointmentTypeDisplayName(
                            groupType,
                          ).toLowerCase()}{" "}
                          scheduled
                        </p>
                      </div>
                    )
                  ) : (
                    /* Existing appointment group card */
                    <div
                      ref={(el) => {
                        if (el) groupRefs.current.set(groupKey, el);
                      }}
                      className={`border rounded-lg overflow-hidden shadow-sm transition-all duration-300 ${
                        highlightedGroup === groupKey
                          ? "ring-4 ring-yellow-400 shadow-xl"
                          : ""
                      }`}
                    >
                      {/* Group Header */}
                      {isRecurring && (
                        <div className="bg-gray-50 p-4 border-b border-gray-200">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center space-x-3 sm:space-x-4 min-w-0">
                              <Avatar className="w-10 h-10">
                                <AvatarImage
                                  alt={getConsumeeName(firstAppointment)}
                                  src={getConsumeeImage(firstAppointment)}
                                />
                                <AvatarFallback>
                                  {getConsumeeName(firstAppointment)
                                    .split(" ")
                                    .map((n: string) => n[0])
                                    .join("")}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <div className="flex items-center gap-2">
                                  <h3 className="font-semibold text-gray-800 text-sm">
                                    {getConsumeeName(firstAppointment)}
                                  </h3>
                                  {consultantId &&
                                    (() => {
                                      const role = getCollaboratorRole(
                                        firstAppointment,
                                        consultantId,
                                      );
                                      return role ? (
                                        <Badge
                                          variant="secondary"
                                          className={`text-[10px] px-1.5 py-0 h-5 ${getRoleBadgeStyle(role)}`}
                                        >
                                          {formatCollaboratorRole(role)}
                                        </Badge>
                                      ) : null;
                                    })()}
                                </div>
                                <p className="text-xs text-gray-600">
                                  {groupTitle.split("(")[0].trim()}
                                </p>
                              </div>

                              {/* Management buttons inline with user name */}
                              <div className="flex items-center gap-2 ml-4">
                                {groupStatus !== "Completed" &&
                                  groupStatus !== "Cancelled" &&
                                  canManageGroupTimings(groupAppointments) && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-8 text-xs px-3"
                                      onClick={() => {
                                        setSelectedAppointment(
                                          firstAppointment,
                                        );
                                        setSelectedGroupProgress(
                                          completedSessions > 0
                                            ? {
                                                completedSessions,
                                                totalSessions,
                                              }
                                            : null,
                                        );
                                      }}
                                    >
                                      <Clock className="w-3 h-3 mr-1" />
                                      Timings
                                    </Button>
                                  )}
                                {supportsParticipantManagement(
                                  firstAppointment,
                                ) && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 text-xs px-3"
                                    onClick={() =>
                                      router.push(
                                        getParticipantManagementUrl(
                                          firstAppointment,
                                          getConsultantIdFromAppointment(
                                            firstAppointment,
                                          ),
                                        ),
                                      )
                                    }
                                  >
                                    <Users className="w-3 h-3 mr-1" />
                                    Participants
                                  </Button>
                                )}
                              </div>
                            </div>

                            <Badge
                              variant="secondary"
                              className={`${getStyleFromBadgeData(groupStatus)} flex-shrink-0`}
                            >
                              {groupStatus}
                            </Badge>
                          </div>

                          {/* Progress Section */}
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-gray-600">
                                <span className="font-semibold text-green-600">
                                  {completedSessions}
                                </span>{" "}
                                completed
                              </span>
                              <span className="text-gray-600">
                                <span className="font-semibold text-blue-600">
                                  {remainingSessions}
                                </span>{" "}
                                remaining
                              </span>
                            </div>

                            {/* Progress Bar */}
                            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                              <div
                                className="bg-gradient-to-r from-green-500 to-blue-500 h-2 rounded-full transition-all duration-500"
                                style={{ width: `${progressPercentage}%` }}
                              />
                            </div>

                          </div>
                        </div>
                      )}

                      {/* Appointments List */}
                      <ul className="divide-y">
                        {(() => {
                          const paginationState = getPaginationState(groupKey);
                          const shouldPaginate =
                            groupAppointments.length > PAGE_SIZE;
                          const totalPages = Math.ceil(
                            groupAppointments.length / PAGE_SIZE,
                          );

                          let visibleAppointments = groupAppointments;
                          if (shouldPaginate && !paginationState.showAll) {
                            const startIndex =
                              (paginationState.currentPage - 1) * PAGE_SIZE;
                            const endIndex = startIndex + PAGE_SIZE;
                            visibleAppointments = groupAppointments.slice(
                              startIndex,
                              endIndex,
                            );
                          }

                          return (
                            <>
                              {visibleAppointments.map((appointment) => {
                                const status =
                                  getAppointmentStatus(appointment);
                                const isJoinable =
                                  status === "Meeting in 5 min";
                                const joinButtonStyle = isJoinable
                                  ? "bg-black text-white hover:bg-gray-800"
                                  : "bg-gray-400 text-white cursor-not-allowed";

                                // Check if this is a one-off event (consultation or webinar)
                                const isOneOffEvent =
                                  !isRecurring &&
                                  (appointment.appointmentType ===
                                    "CONSULTATION" ||
                                    appointment.appointmentType === "WEBINAR");

                                const containerClasses = isOneOffEvent
                                  ? "flex items-center justify-between p-4 bg-gray-200 hover:bg-gray-250 border border-gray-300"
                                  : "flex items-center justify-between p-4 hover:bg-gray-100";

                                return (
                                  <li
                                    key={appointment.id}
                                    className={containerClasses}
                                  >
                                    <div className="flex items-center justify-between w-full">
                                      {/* Left: Avatar and User info */}
                                      <div className="flex items-center space-x-3 min-w-0">
                                        {!isRecurring && (
                                          <Avatar className="flex-shrink-0">
                                            <AvatarImage
                                              alt={getConsumeeName(appointment)}
                                              src={getConsumeeImage(
                                                appointment,
                                              )}
                                            />
                                            <AvatarFallback>
                                              {getConsumeeName(appointment)
                                                .split(" ")
                                                .map((n: string) => n[0])
                                                .join("")}
                                            </AvatarFallback>
                                          </Avatar>
                                        )}
                                        <div className="min-w-0">
                                          {!isRecurring && (
                                            <>
                                              <div className="flex items-center gap-2">
                                                <h3 className="font-semibold text-gray-800">
                                                  {getConsumeeName(appointment)}
                                                </h3>
                                                {consultantId &&
                                                  (() => {
                                                    const role =
                                                      getCollaboratorRole(
                                                        appointment,
                                                        consultantId,
                                                      );
                                                    return role ? (
                                                      <Badge
                                                        variant="secondary"
                                                        className={`text-[10px] px-1.5 py-0 h-5 ${getRoleBadgeStyle(role)}`}
                                                      >
                                                        {formatCollaboratorRole(
                                                          role,
                                                        )}
                                                      </Badge>
                                                    ) : null;
                                                  })()}
                                              </div>
                                              <p className="text-sm text-gray-600">
                                                {getAppointmentTypeAndPlan(
                                                  appointment,
                                                )}
                                              </p>
                                            </>
                                          )}
                                          <div className="text-sm text-gray-500">
                                            Starts:{" "}
                                            {(() => {
                                              const startTime =
                                                getStartTime(appointment);
                                              return startTime ? (
                                                formatAppointmentTime(
                                                  startTime.toISOString(),
                                                )
                                              ) : (
                                                <span className="text-orange-600 font-medium">
                                                  Not Scheduled
                                                </span>
                                              );
                                            })()}
                                          </div>
                                        </div>

                                        {/* Management buttons right after user info */}
                                        <div className="flex items-center gap-2 ml-4">
                                          {!isRecurring &&
                                            status !== "Completed" &&
                                            status !== "Cancelled" &&
                                            canManageAppointmentTimings(
                                              appointment,
                                            ) && (
                                              <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-8 text-xs px-3"
                                                onClick={() => {
                                                  setSelectedAppointment(
                                                    appointment,
                                                  );
                                                  setSelectedGroupProgress(
                                                    null,
                                                  );
                                                }}
                                              >
                                                <Clock className="w-3 h-3 mr-1" />
                                                Timings
                                              </Button>
                                            )}
                                          {!isRecurring &&
                                            supportsParticipantManagement(
                                              appointment,
                                            ) && (
                                              <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-8 text-xs px-3"
                                                onClick={() =>
                                                  router.push(
                                                    getParticipantManagementUrl(
                                                      appointment,
                                                      getConsultantIdFromAppointment(
                                                        appointment,
                                                      ),
                                                    ),
                                                  )
                                                }
                                              >
                                                <Users className="w-3 h-3 mr-1" />
                                                Participants
                                              </Button>
                                            )}
                                        </div>
                                      </div>

                                      {/* Right side: Status and Join button */}
                                      <div className="flex items-center gap-3 flex-shrink-0">
                                        {status !== "Not Scheduled" && (
                                          <Badge
                                            variant="secondary"
                                            className={getStyleFromBadgeData(
                                              status,
                                            )}
                                          >
                                            {status}
                                          </Badge>
                                        )}
                                        {status !== "Completed" &&
                                          status !== "Not Scheduled" && (
                                            <Button
                                              variant="default"
                                              size="sm"
                                              className={`${joinButtonStyle} h-8 px-4 text-xs`}
                                              disabled={!isJoinable}
                                              onClick={() =>
                                                handleJoinMeeting(appointment)
                                              }
                                            >
                                              {isJoinable
                                                ? "Join meet"
                                                : "Not available"}
                                            </Button>
                                          )}
                                      </div>
                                    </div>
                                  </li>
                                );
                              })}

                              {/* Pagination Controls */}
                              {shouldPaginate && (
                                <li className="p-3 bg-gray-200 border-t border-gray-300">
                                  <div className="flex justify-end gap-2">
                                    {!paginationState.showAll && (
                                      <>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="text-xs"
                                          onClick={() =>
                                            setPage(
                                              groupKey,
                                              paginationState.currentPage - 1,
                                            )
                                          }
                                          disabled={
                                            paginationState.currentPage === 1
                                          }
                                        >
                                          <ChevronLeft className="w-4 h-4 mr-1" />
                                          Previous
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="text-xs"
                                          onClick={() =>
                                            setPage(
                                              groupKey,
                                              paginationState.currentPage + 1,
                                            )
                                          }
                                          disabled={
                                            paginationState.currentPage ===
                                            totalPages
                                          }
                                        >
                                          Next
                                          <ChevronRight className="w-4 h-4 ml-1" />
                                        </Button>
                                      </>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-xs"
                                      onClick={() => toggleShowAll(groupKey)}
                                    >
                                      {paginationState.showAll
                                        ? "Show Less"
                                        : "Show All"}
                                    </Button>
                                  </div>
                                </li>
                              )}
                            </>
                          );
                        })()}
                      </ul>
                    </div>
                  )}
                </div>
              );
            },
          );
        })()}
        {!Object.keys(groupedAppointments).length && (
          <div className="flex flex-col items-center justify-center min-h-[400px] p-8 bg-gray-50 rounded-lg">
            <div className="w-16 h-16 mb-4 text-gray-400">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-gray-900 mb-2">
              No Appointments Found
            </h3>
            <p className="text-gray-500 text-center">
              You don't have any appointments scheduled at the moment.
            </p>
          </div>
        )}
      </div>

      {selectedAppointment && (
        <EventTimingsCalendar
          isOpen={!!selectedAppointment}
          onClose={() => {
            setSelectedAppointment(null);
            setSelectedGroupProgress(null);
          }}
          appointment={selectedAppointment}
          completedSessions={selectedGroupProgress?.completedSessions}
          groupTotalSessions={selectedGroupProgress?.totalSessions}
        />
      )}
    </div>
  );
}
