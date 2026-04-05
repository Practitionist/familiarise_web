"use client";

import { usePagination } from "@/hooks/usePagination";
import { Pagination } from "@/components/Pagination";
import { BADGE_STYLES, getBadgeStyle } from "../../types";
import { TAppointment, TSlotOfAppointment } from "@/types/appointment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Clock } from "lucide-react";
import {
  formatAppointmentTime,
  getAppointmentStatus,
  getAppointmentTypeAndPlan,
  getConsumeeImage,
  getConsumeeName,
  getStartTime,
} from "../../utils/appointmentHelpers";
import { canManageAppointmentTimings } from "./utils/appointmentTimingHelpers";
import { getJoinableSlot } from "../../utils/joinState";

interface PaginatedAppointmentsProps {
  appointments: TAppointment[];
  badgeStyles: typeof BADGE_STYLES;
  onManageTimings?: (appointment: TAppointment) => void;
  onJoinMeeting?: (appointment: TAppointment, slot?: TSlotOfAppointment) => void;
}

export function PaginatedAppointments({
  appointments,
  badgeStyles,
  onManageTimings,
  onJoinMeeting,
}: PaginatedAppointmentsProps) {
  const expandedAppointments = appointments;

  const {
    paginatedData,
    currentPage,
    totalPages,
    totalItems,
    pageSize,
    hasNextPage,
    hasPreviousPage,
    startIndex,
    endIndex,
    goToPage,
    goToNextPage,
    goToPreviousPage,
    goToFirstPage,
    goToLastPage,
  } = usePagination(expandedAppointments, { pageSize: 6 }); // Show 6 appointments per page

  const getBadgeStyleFromData = (status: string): string => {
    return getBadgeStyle(status);
  };

  if (expandedAppointments.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-500">No appointments found</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Appointments grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {paginatedData.map((appointment) => {
          const userName = getConsumeeName(appointment);
          const status = getAppointmentStatus(appointment);
          const joinableSlot = getJoinableSlot(
            appointment.slotsOfAppointment ?? [],
          );
          const isJoinable = joinableSlot !== null;
          const isDev = process.env.NODE_ENV !== "production";

          return (
            <div
              key={appointment.id}
              className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow"
            >
              <div className="flex items-center gap-3 mb-3">
                <Avatar className="w-10 h-10">
                  <AvatarImage
                    alt={userName}
                    src={getConsumeeImage(appointment)}
                  />
                  <AvatarFallback>
                    {userName
                      .split(" ")
                      .map((n: string) => n[0])
                      .join("")}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold truncate">{userName}</h3>
                  <p className="text-sm text-gray-600 truncate">
                    {getAppointmentTypeAndPlan(appointment)}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs text-gray-500">
                  {(() => {
                    const startTime = getStartTime(appointment);
                    return startTime
                      ? formatAppointmentTime(startTime.toISOString())
                      : "Time not set";
                  })()}
                </div>

                <div className="flex items-center justify-between">
                  <Badge
                    variant="secondary"
                    className={getBadgeStyleFromData(status)}
                  >
                    {status}
                  </Badge>
                  <div className="flex items-center space-x-2">
                    {canManageAppointmentTimings(appointment) &&
                      onManageTimings && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onManageTimings(appointment)}
                        >
                          <Clock className="w-4 h-4 mr-1" />
                          Manage
                        </Button>
                      )}
                    <Button
                      variant="default"
                      size="sm"
                      className={
                        isDev || isJoinable
                          ? "bg-blue-600 text-white hover:bg-blue-700"
                          : "bg-gray-400 text-white cursor-not-allowed"
                      }
                      disabled={isDev ? false : !isJoinable}
                      onClick={() =>
                        onJoinMeeting?.(
                          appointment,
                          joinableSlot ?? undefined,
                        )
                      }
                    >
                      {isDev
                        ? "Join (Dev)"
                        : isJoinable
                          ? "Join Meeting"
                          : "Not available"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={totalItems}
        pageSize={pageSize}
        hasNextPage={hasNextPage}
        hasPreviousPage={hasPreviousPage}
        startIndex={startIndex}
        endIndex={endIndex}
        onPageChange={goToPage}
        onNextPage={goToNextPage}
        onPreviousPage={goToPreviousPage}
        onFirstPage={goToFirstPage}
        onLastPage={goToLastPage}
        showPageNumbers={true}
        maxVisiblePages={5}
      />
    </div>
  );
}
