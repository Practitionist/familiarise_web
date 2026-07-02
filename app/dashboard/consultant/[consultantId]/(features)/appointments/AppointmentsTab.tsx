"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarX } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { resolveSponsoringOrgName as resolveSponsoringOrgNameShared } from "@/lib/labels/session-labels";
import {
  AppointmentsTabProps,
  ScheduledTrial,
} from "../../types";
import {
  buildUnscheduledClassAppointment,
  buildUnscheduledWebinarAppointment,
  UnscheduledAppointment,
} from "./utils/unscheduledAppointments";
import { TAppointment } from "@/types/appointment";
import {
  getAppointmentStatus,
  getAppointmentTypeAndPlan,
  getConsumeeName,
  getNextUpcomingSlotTime,
  groupRecurringAppointments,
  groupAppointmentsByType,
  getAppointmentTypeDisplayName,
} from "../../utils/appointmentHelpers";
import { EventTimingsCalendar } from "./components/EventTimingsCalendar";
import { useLazyJoinMeeting } from "../shared/hooks/useLazyJoinMeeting";
import {
  AppointmentFilters,
  type AppointmentStatusFilter,
} from "./components/AppointmentFilters";
import { TrialsSubsection } from "./components/TrialsSubsection";
import { UnscheduledEventsSection } from "./components/UnscheduledEventsSection";
import {
  AppointmentGroupCard,
  type GroupPaginationState,
} from "./components/AppointmentGroupCard";

export function AppointmentsTab({
  appointments,
  scheduledTrials = [],
  trialsState,
  consultantId,
  unscheduledClasses = [],
  unscheduledClassesState,
  unscheduledWebinars = [],
  unscheduledWebinarsState,
  headerSlot,
}: Readonly<AppointmentsTabProps>) {
  const { data: session } = useSession();
  const joinMeeting = useLazyJoinMeeting();
  // Memberships used to resolve an appointment's `organizationId` to a
  // displayable org name for the "Sponsored · <Org>" badge.
  const orgMemberships = session?.user?.organizationMemberships ?? [];
  const resolveSponsoringOrgName = (orgId: string | null | undefined) =>
    resolveSponsoringOrgNameShared(orgId, orgMemberships);

  const [joiningTrialId, setJoiningTrialId] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const [selectedAppointment, setSelectedAppointment] =
    useState<TAppointment | UnscheduledAppointment | null>(null);
  const [selectedGroupProgress, setSelectedGroupProgress] = useState<{
    completedSessions: number;
    totalSessions: number;
  } | null>(null);
  const [groupPagination, setGroupPagination] = useState<
    Map<string, GroupPaginationState>
  >(new Map());
  const [highlightedGroup, setHighlightedGroup] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<AppointmentStatusFilter>("ALL");
  const groupRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Handle highlight from URL parameter
  useEffect(() => {
    const highlight = searchParams?.get("highlight");
    if (highlight) {
      setHighlightedGroup(highlight);

      setTimeout(() => {
        const element = groupRefs.current.get(highlight);
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);

      setTimeout(() => {
        setHighlightedGroup(null);
      }, 3000);
    }
  }, [searchParams]);

  const getPaginationState = (groupKey: string): GroupPaginationState =>
    groupPagination.get(groupKey) || { currentPage: 1, showAll: false };

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

  // Handle joining a trial meeting — builds the minimal meeting shape from
  // the trial's appointment, then defers to the shared lazy join hook.
  const handleJoinTrialMeeting = async (trial: ScheduledTrial) => {
    if (!trial.appointment?.slotsOfAppointment?.[0]) return;
    setJoiningTrialId(trial.id);
    const trialSlot = trial.appointment.slotsOfAppointment[0];
    const navigating = await joinMeeting(
      {
        id: trial.appointment.id,
        appointmentType: "TRIAL",
        slotsOfAppointment: [
          {
            id: trialSlot.id,
            startsAt: trialSlot.startsAt,
            endsAt: trialSlot.endsAt,
            appointmentId: trial.appointment.id,
          },
        ],
      },
      undefined,
    );
    if (!navigating) setJoiningTrialId(null);
  };

  // Apply search and status filters
  const filteredAppointments = useMemo(() => {
    return (appointments || []).filter((apt) => {
      if (statusFilter !== "ALL") {
        const s = getAppointmentStatus(apt);
        if (statusFilter === "UPCOMING") {
          if (s === "Completed" || s === "Cancelled" || s === "Not Scheduled")
            return false;
        }
        if (statusFilter === "PAST") {
          if (s !== "Completed" && s !== "Cancelled") return false;
        }
      }
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

  // Group filtered appointments by type
  const appointmentsByType = groupAppointmentsByType(filteredAppointments);

  // Further group recurring appointments (subscriptions/classes) within each type
  const groupedAppointments = Object.entries(appointmentsByType).reduce(
    (acc, [type, typeAppointments]) => {
      if (typeAppointments.length === 0) {
        acc[`${type}-empty`] = [];
        return acc;
      }

      if (type === "SUBSCRIPTION" || type === "CLASS") {
        const recurringGroups = groupRecurringAppointments(typeAppointments);
        Object.entries(recurringGroups).forEach(([key, appointments]) => {
          acc[`${type}-${key}`] = appointments;
        });
      } else {
        typeAppointments.forEach((appointment) => {
          acc[`${type}-${appointment.id}`] = [appointment];
        });
      }
      return acc;
    },
    {} as { [key: string]: TAppointment[] },
  );

  // Sort groups: by type order first, then within each type —
  // upcoming groups first (nearest future first), past groups after (most recent first)
  const typeOrder = ["CONSULTATION", "SUBSCRIPTION", "WEBINAR", "CLASS"];
  const now = new Date();

  const getGroupSortTime = (groupAppts: TAppointment[]): Date | null => {
    if (groupAppts.length === 0) return null;
    const times = groupAppts
      .map((apt) => getNextUpcomingSlotTime(apt))
      .filter((t): t is Date => t !== null);
    if (times.length === 0) return null;
    return times.reduce((a, b) => (a < b ? a : b));
  };

  const sortedGroupedAppointments = Object.entries(groupedAppointments).sort(
    ([keyA, apptsA], [keyB, apptsB]) => {
      const typeA = keyA.split("-")[0];
      const typeB = keyB.split("-")[0];
      const typeCompare = typeOrder.indexOf(typeA) - typeOrder.indexOf(typeB);
      if (typeCompare !== 0) return typeCompare;

      const timeA = getGroupSortTime(apptsA);
      const timeB = getGroupSortTime(apptsB);
      if (!timeA && !timeB) return 0;
      if (!timeA) return 1;
      if (!timeB) return -1;

      const aIsUpcoming = timeA >= now;
      const bIsUpcoming = timeB >= now;

      if (aIsUpcoming && !bIsUpcoming) return -1;
      if (!aIsUpcoming && bIsUpcoming) return 1;

      if (aIsUpcoming && bIsUpcoming) {
        return timeA.getTime() - timeB.getTime();
      }

      return timeB.getTime() - timeA.getTime();
    },
  );

  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white shadow-sm p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <h2 className="text-xl font-semibold text-zinc-800">
          All Appointments
        </h2>
        {headerSlot}
      </div>
      <AppointmentFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
      />
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

              const showTrialsBlock =
                isNewTypeSection &&
                statusFilter === "ALL" &&
                groupType === "SUBSCRIPTION";
              const showUnscheduledClasses =
                isNewTypeSection &&
                statusFilter === "ALL" &&
                groupType === "CLASS";
              const showUnscheduledWebinars =
                isNewTypeSection &&
                statusFilter === "ALL" &&
                groupType === "WEBINAR";

              return (
                <div key={groupKey}>
                  {/* Type Section Header */}
                  {isNewTypeSection && (
                    <div className="mb-4 pt-6 first:pt-0">
                      <h3 className="text-lg font-semibold text-zinc-900 border-b-2 border-zinc-200 pb-2">
                        {getAppointmentTypeDisplayName(groupType)}
                        <span className="text-sm font-normal text-zinc-500 ml-2">
                          ({(appointmentsByType[groupType]?.length ?? 0) +
                            (statusFilter === "ALL"
                              ? (groupType === "CLASS"
                                  ? unscheduledClasses.length
                                  : 0) +
                                (groupType === "WEBINAR"
                                  ? unscheduledWebinars.length
                                  : 0)
                              : 0)})
                        </span>
                      </h3>
                    </div>
                  )}

                  {/* Free Trials sub-section (SUBSCRIPTION type, "All" view) */}
                  {showTrialsBlock && (
                    <TrialsSubsection
                      trials={scheduledTrials}
                      joiningTrialId={joiningTrialId}
                      onJoin={handleJoinTrialMeeting}
                      state={trialsState}
                    />
                  )}

                  {/* Unscheduled events — only in "All" view */}
                  {showUnscheduledClasses && (
                    <UnscheduledEventsSection
                      title="Unscheduled Classes"
                      state={unscheduledClassesState}
                      items={unscheduledClasses.map((classEvent) => ({
                        id: classEvent.id,
                        title: classEvent.classPlan.title,
                        subtitle: `${classEvent.classPlan.meetingsPerWeek} meeting${classEvent.classPlan.meetingsPerWeek !== 1 ? "s" : ""}/week · ${classEvent.classPlan.totalSessions} sessions · ${classEvent.classPlan.sessionDurationInHours}h each`,
                        onSetSchedule: () => {
                          setSelectedAppointment(
                            buildUnscheduledClassAppointment(classEvent),
                          );
                          setSelectedGroupProgress(null);
                        },
                      }))}
                    />
                  )}
                  {showUnscheduledWebinars && (
                    <UnscheduledEventsSection
                      title="Unscheduled Webinars"
                      state={unscheduledWebinarsState}
                      items={unscheduledWebinars.map((webinarEvent) => ({
                        id: webinarEvent.id,
                        title: webinarEvent.webinarPlan.title,
                        subtitle: `Single session · ${webinarEvent.webinarPlan.durationInHours}h`,
                        onSetSchedule: () => {
                          setSelectedAppointment(
                            buildUnscheduledWebinarAppointment(webinarEvent),
                          );
                          setSelectedGroupProgress(null);
                        },
                      }))}
                    />
                  )}

                  {/* Empty state — only when the section has no scheduled
                      appointments AND no unscheduled items rendered above */}
                  {groupAppointments.length === 0 ? (
                    (statusFilter === "ALL" &&
                      ((groupType === "CLASS" &&
                        unscheduledClasses.length > 0) ||
                        (groupType === "WEBINAR" &&
                          unscheduledWebinars.length > 0))) ? null : (
                      <div className="border border-zinc-200 rounded-lg p-8 bg-zinc-50 text-center">
                        <p className="text-zinc-500 text-sm">
                          {statusFilter === "UPCOMING"
                            ? `No upcoming ${getAppointmentTypeDisplayName(groupType).toLowerCase()}`
                            : statusFilter === "PAST"
                              ? `No past ${getAppointmentTypeDisplayName(groupType).toLowerCase()}`
                              : `No ${getAppointmentTypeDisplayName(groupType).toLowerCase()} scheduled`}
                        </p>
                      </div>
                    )
                  ) : (
                    <AppointmentGroupCard
                      appointments={groupAppointments}
                      isRecurring={isRecurring}
                      consultantId={consultantId}
                      highlighted={highlightedGroup === groupKey}
                      registerRef={(el) => {
                        if (el) groupRefs.current.set(groupKey, el);
                      }}
                      pagination={getPaginationState(groupKey)}
                      onSetPage={(page) => setPage(groupKey, page)}
                      onToggleShowAll={() => toggleShowAll(groupKey)}
                      onJoinMeeting={(appointment, joinableSlot) =>
                        void joinMeeting(appointment, joinableSlot)
                      }
                      onOpenTimings={(appointment, groupProgress) => {
                        setSelectedAppointment(appointment);
                        setSelectedGroupProgress(groupProgress);
                      }}
                      resolveSponsoringOrgName={resolveSponsoringOrgName}
                    />
                  )}
                </div>
              );
            },
          );
        })()}
        {!Object.keys(groupedAppointments).length && (
          <div className="flex flex-col items-center justify-center min-h-[400px] p-8 bg-zinc-50 rounded-lg">
            <CalendarX className="w-16 h-16 mb-4 text-zinc-400" strokeWidth={1.5} />
            <h3 className="text-xl font-semibold text-zinc-900 mb-2">
              {statusFilter === "UPCOMING"
                ? "No Upcoming Appointments"
                : statusFilter === "PAST"
                  ? "No Past Appointments"
                  : "No Appointments Found"}
            </h3>
            <p className="text-zinc-500 text-center">
              {statusFilter === "UPCOMING"
                ? "You don't have any upcoming appointments."
                : statusFilter === "PAST"
                  ? "You don't have any past appointments."
                  : "You don't have any appointments scheduled at the moment."}
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
