"use client";

import { useRouter } from "next/navigation";
import { Building2, ChevronLeft, ChevronRight, Clock, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TAppointment } from "@/types/appointment";
import { getBadgeStyle } from "../../../types";
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
  getCollaboratorRole,
  formatCollaboratorRole,
  getRoleBadgeStyle,
} from "../../../utils/appointmentHelpers";
import {
  canManageAppointmentTimings,
  canManageGroupTimings,
} from "../utils/appointmentTimingHelpers";
import {
  getParticipantManagementUrl,
  supportsParticipantManagement,
} from "../utils/participantHelpers";
import { getJoinableSlot } from "../../../utils/joinState";

const PAGE_SIZE = 5;

export interface GroupPaginationState {
  currentPage: number;
  showAll: boolean;
}

interface AppointmentGroupCardProps {
  appointments: TAppointment[];
  isRecurring: boolean;
  consultantId?: string;
  highlighted: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
  pagination: GroupPaginationState;
  onSetPage: (page: number) => void;
  onToggleShowAll: () => void;
  onJoinMeeting: (
    appointment: TAppointment,
    joinableSlot?: TAppointment["slotsOfAppointment"][number],
  ) => void;
  onOpenTimings: (
    appointment: TAppointment,
    groupProgress: { completedSessions: number; totalSessions: number } | null,
  ) => void;
  resolveSponsoringOrgName: (
    orgId: string | null | undefined,
  ) => string | null;
}

// Helper to get consultant ID from appointment (for the participants URL)
function getConsultantIdFromAppointment(appointment: TAppointment): string {
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
}

/**
 * One appointment group: a recurring subscription/class (progress header +
 * paginated session list) or a single consultation/webinar row. Extracted
 * mechanically from the 1,100-line AppointmentsTab — behavior unchanged;
 * pagination state stays parent-owned (keyed by groupKey) so it survives
 * re-groupings exactly as before.
 */
export function AppointmentGroupCard({
  appointments: groupAppointments,
  isRecurring,
  consultantId,
  highlighted,
  registerRef,
  pagination,
  onSetPage,
  onToggleShowAll,
  onJoinMeeting,
  onOpenTimings,
  resolveSponsoringOrgName,
}: AppointmentGroupCardProps) {
  const router = useRouter();
  const firstAppointment = groupAppointments[0];
  const groupTitle = getGroupTitle(groupAppointments);
  const groupStatus = getGroupStatus(groupAppointments);
  const {
    totalSessions,
    completedSessions,
    remainingSessions,
    progressPercentage,
  } = calculateSessionProgress(groupAppointments);

  const shouldPaginate = groupAppointments.length > PAGE_SIZE;
  const totalPages = Math.ceil(groupAppointments.length / PAGE_SIZE);

  let visibleAppointments = groupAppointments;
  if (shouldPaginate && !pagination.showAll) {
    const startIndex = (pagination.currentPage - 1) * PAGE_SIZE;
    visibleAppointments = groupAppointments.slice(
      startIndex,
      startIndex + PAGE_SIZE,
    );
  }

  return (
    <div
      ref={registerRef}
      className={`border border-zinc-200 rounded-xl overflow-hidden shadow-sm bg-white transition-all duration-300 ${
        highlighted ? "ring-4 ring-yellow-400 shadow-xl" : ""
      }`}
    >
      {/* Group Header */}
      {isRecurring && (
        <div className="bg-zinc-50 p-4 border-b border-zinc-200">
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
                  <h3 className="font-semibold text-zinc-800 text-sm">
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
                <p className="text-xs text-zinc-600">
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
                      onClick={() =>
                        onOpenTimings(
                          firstAppointment,
                          completedSessions > 0
                            ? { completedSessions, totalSessions }
                            : null,
                        )
                      }
                    >
                      <Clock className="w-3 h-3 mr-1" />
                      Timings
                    </Button>
                  )}
                {supportsParticipantManagement(firstAppointment) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs px-3"
                    onClick={() =>
                      router.push(
                        getParticipantManagementUrl(
                          firstAppointment,
                          getConsultantIdFromAppointment(firstAppointment),
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
              className={`${getBadgeStyle(groupStatus)} flex-shrink-0`}
            >
              {groupStatus}
            </Badge>
          </div>

          {/* Progress Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-600">
                <span className="font-semibold text-green-600">
                  {completedSessions}
                </span>{" "}
                completed
              </span>
              <span className="text-zinc-600">
                <span className="font-semibold text-blue-600">
                  {remainingSessions}
                </span>{" "}
                remaining
              </span>
            </div>

            <div className="w-full bg-zinc-200 rounded-full h-2 overflow-hidden">
              <div
                className="bg-emerald-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${progressPercentage}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Appointments List */}
      <ul className="divide-y divide-zinc-100">
        {visibleAppointments.map((appointment) => {
          const status = getAppointmentStatus(appointment);
          const joinableSlot = getJoinableSlot(
            appointment.slotsOfAppointment ?? [],
          );
          const isJoinable = joinableSlot !== null;
          const isDev = process.env.NODE_ENV !== "production";
          const joinButtonStyle =
            isDev || isJoinable
              ? "bg-zinc-900 text-white hover:bg-zinc-800"
              : "bg-zinc-300 text-zinc-500 cursor-not-allowed";

          const isOneOffEvent =
            !isRecurring &&
            (appointment.appointmentType === "CONSULTATION" ||
              appointment.appointmentType === "WEBINAR");

          const containerClasses = isOneOffEvent
            ? "flex items-center justify-between p-4 bg-zinc-50 hover:bg-zinc-100"
            : "flex items-center justify-between p-4 hover:bg-zinc-50";

          return (
            <li key={appointment.id} className={containerClasses}>
              <div className="flex items-center justify-between w-full">
                {/* Left: Avatar and User info */}
                <div className="flex items-center space-x-3 min-w-0">
                  {!isRecurring && (
                    <Avatar className="flex-shrink-0">
                      <AvatarImage
                        alt={getConsumeeName(appointment)}
                        src={getConsumeeImage(appointment)}
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
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-zinc-800">
                            {getConsumeeName(appointment)}
                          </h3>
                          {(() => {
                            const sponsoringOrgName = resolveSponsoringOrgName(
                              appointment.organizationId,
                            );
                            return sponsoringOrgName ? (
                              <Badge
                                className="text-[10px] font-semibold px-2 py-0.5 bg-indigo-50 text-indigo-700 border-0 rounded-md inline-flex items-center gap-1 max-w-[200px]"
                                title={`Sponsored by ${sponsoringOrgName}`}
                              >
                                <Building2 className="h-3 w-3 shrink-0" />
                                <span className="truncate">
                                  Sponsored · {sponsoringOrgName}
                                </span>
                              </Badge>
                            ) : null;
                          })()}
                          {consultantId &&
                            (() => {
                              const role = getCollaboratorRole(
                                appointment,
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
                        <p className="text-sm text-zinc-600">
                          {getAppointmentTypeAndPlan(appointment)}
                        </p>
                      </>
                    )}
                    <div className="text-sm text-zinc-500">
                      Starts:{" "}
                      {(() => {
                        const startTime = getStartTime(appointment);
                        return startTime ? (
                          formatAppointmentTime(startTime.toISOString())
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
                      canManageAppointmentTimings(appointment) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs px-3"
                          onClick={() => onOpenTimings(appointment, null)}
                        >
                          <Clock className="w-3 h-3 mr-1" />
                          Timings
                        </Button>
                      )}
                    {!isRecurring &&
                      supportsParticipantManagement(appointment) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs px-3"
                          onClick={() =>
                            router.push(
                              getParticipantManagementUrl(
                                appointment,
                                getConsultantIdFromAppointment(appointment),
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
                      className={getBadgeStyle(status)}
                    >
                      {status}
                    </Badge>
                  )}
                  {status !== "Completed" && status !== "Not Scheduled" && (
                    <Button
                      variant="default"
                      size="sm"
                      className={`${joinButtonStyle} h-8 px-4 text-xs`}
                      disabled={isDev ? false : !isJoinable}
                      onClick={() =>
                        onJoinMeeting(appointment, joinableSlot ?? undefined)
                      }
                    >
                      {isDev
                        ? "Join (Dev)"
                        : isJoinable
                          ? "Join Meeting"
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
          <li className="p-3 bg-zinc-50 border-t border-zinc-200">
            <div className="flex justify-end gap-2">
              {!pagination.showAll && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => onSetPage(pagination.currentPage - 1)}
                    disabled={pagination.currentPage === 1}
                  >
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Previous
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => onSetPage(pagination.currentPage + 1)}
                    disabled={pagination.currentPage === totalPages}
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
                onClick={onToggleShowAll}
              >
                {pagination.showAll ? "Show Less" : "Show All"}
              </Button>
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}
