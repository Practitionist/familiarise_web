"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { getOrCreateAppointmentMeeting } from "@/lib/meeting";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import { useRouter } from "next/navigation";
import { Suspense } from "react";
import { ClientActivity } from "../../components/ClientActivity";
import {
  formatAppointmentTime,
  getAppointmentStatus,
  getAppointmentTypeAndPlan,
  getConsumeeImage,
  getConsumeeName,
  getGroupStatus,
  getGroupTitle,
  getStartTime,
  getTodayAppointments,
  getUpcomingAppointments,
  groupRecurringAppointments,
  sortAppointmentsByStartTime,
} from "../../utils/appointmentHelpers";

import { IActivity, IApproval, BADGE_STYLES } from "../../types";
import { TAppointment } from "@/types/appointment";
import { RequestSlotAllocationTabMini } from "../requests/RequestSlotAllocationTabMini";
import { convertTAppointmentToIAppointment } from "../appointments/utils/appointmentTypeAdapter";

// Define the type for the badge styles object if not already defined/imported
type BadgeStyleMap = typeof BADGE_STYLES; // Use typeof if BADGE_STYLES is an object constant

interface HomeTabProps {
  appointments: TAppointment[];
  activities: IActivity[];
  approvals: IApproval[];
  badgeStyles: BadgeStyleMap; // Accept the data object
}

export function HomeTab({
  appointments,
  activities,
  badgeStyles, // Destructure the new prop
}: Readonly<HomeTabProps>) {
  const router = useRouter();
  const client = useStreamVideoClient();
  const { toast } = useToast();

  const handleJoinMeeting = async (appointment: TAppointment) => {
    if (!client) {
      console.error("Stream client not ready");
      toast({ title: "Error", description: "Meeting client not ready." });
      return;
    }
    const relevantSlot = appointment.slotsOfAppointment?.[0];
    if (!relevantSlot) {
      toast({
        title: "Error",
        description: "Slot information missing for this appointment item.",
      });
      return;
    }

    try {
      const meetingId = await getOrCreateAppointmentMeeting(
        client,
        convertTAppointmentToIAppointment(appointment),
        relevantSlot,
      );
      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      console.error("Error joining meeting:", error);
      toast({
        title: "Error",
        description: "Failed to join meeting.",
        variant: "destructive",
      });
    }
  };

  // Internal function to get style using the passed object
  const getBadgeStyleFromData = (status: string): string => {
    return badgeStyles[status] || badgeStyles.default;
  };

  // Expand appointments into individual slots
  const expandedAppointments = (appointments || []).flatMap((appointment) => {
    if (
      !appointment.slotsOfAppointment ||
      appointment.slotsOfAppointment.length === 0
    ) {
      return [appointment];
    }
    return appointment.slotsOfAppointment.map((slot) => ({
      ...appointment,
      id: `${appointment.id}-${slot.id}`,
      slotsOfAppointment: [slot],
    }));
  });

  // Filter appointments for today (limit to 5 for performance)
  const todayAppointments = getTodayAppointments(expandedAppointments)
    .filter((appointment) => {
      const status = getAppointmentStatus(appointment);
      return status !== "Completed";
    })
    .slice(0, 5);

  // Get all upcoming appointments (limit to 10 for performance)
  const upcomingAppointments = sortAppointmentsByStartTime(
    getUpcomingAppointments(expandedAppointments),
  ).slice(0, 10);

  // Group upcoming appointments
  const groupedUpcomingAppointments =
    groupRecurringAppointments(upcomingAppointments);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
      <div className="lg:col-span-2 space-y-4 lg:space-y-6">
        <Suspense fallback={<div>Loading appointments...</div>}>
          <div className="bg-white p-4 lg:p-6 rounded-lg shadow">
            <h2 className="text-lg lg:text-xl font-semibold mb-3 lg:mb-4">
              Today's Appointments
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 lg:gap-4">
              {todayAppointments.map((appointment) => {
                const userName = getConsumeeName(appointment);
                const status = getAppointmentStatus(appointment);
                const isJoinable = status === "Meeting in 5 min";
                const joinButtonStyle = isJoinable
                  ? "bg-black text-white hover:bg-gray-800"
                  : "bg-gray-400 text-white cursor-not-allowed";

                return (
                  <div
                    key={appointment.id}
                    className="bg-gray-100 p-4 rounded-lg"
                  >
                    <div className="flex items-center gap-3">
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
                    <div className="mt-3">
                      <div className="text-xs text-gray-500 mt-1">
                        {(() => {
                          const startTime = getStartTime(appointment);
                          return startTime
                            ? formatAppointmentTime(startTime.toISOString())
                            : "Time not set";
                        })()}
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <Badge
                          variant="secondary"
                          className={getBadgeStyleFromData(status)}
                        >
                          {status}
                        </Badge>
                        <Button
                          variant="default"
                          size="sm"
                          className={joinButtonStyle}
                          disabled={!isJoinable}
                          onClick={() => handleJoinMeeting(appointment)}
                        >
                          Join meet
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {todayAppointments.length === 0 && (
                <p className="text-gray-500 col-span-1 sm:col-span-2">
                  No appointments for today
                </p>
              )}
            </div>
          </div>
        </Suspense>
        <Suspense fallback={<div>Loading upcoming appointments...</div>}>
          <div className="bg-white p-4 lg:p-6 rounded-lg shadow">
            <h2 className="text-lg lg:text-xl font-semibold mb-3 lg:mb-4">
              Upcoming Appointments
            </h2>
            <div className="space-y-4">
              {Object.entries(groupedUpcomingAppointments).map(
                ([groupKey, groupAppointments]) => {
                  const isRecurring =
                    groupKey.startsWith("subscription-") ||
                    groupKey.startsWith("class-");
                  const groupTitle = getGroupTitle(groupAppointments);
                  const groupStatus = getGroupStatus(groupAppointments);
                  const firstAppointment = groupAppointments[0];
                  const userName = getConsumeeName(firstAppointment);

                  return (
                    <div
                      key={groupKey}
                      className="border rounded-lg overflow-hidden"
                    >
                      {/* Group Header for recurring appointments */}
                      {isRecurring && (
                        <div className="bg-gray-50 p-3 border-b">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-3">
                              <Avatar className="w-8 h-8">
                                <AvatarImage
                                  alt={userName}
                                  src={getConsumeeImage(firstAppointment)}
                                />
                                <AvatarFallback>
                                  {userName
                                    .split(" ")
                                    .map((n: string) => n[0])
                                    .join("")}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <h3 className="font-semibold text-sm">
                                  {userName}
                                </h3>
                                <p className="text-xs text-gray-600">
                                  {groupTitle}
                                </p>
                              </div>
                            </div>
                            <Badge
                              variant="secondary"
                              className={getBadgeStyleFromData(groupStatus)}
                            >
                              {groupStatus}
                            </Badge>
                          </div>
                        </div>
                      )}

                      {/* Appointment list */}
                      <ul className="divide-y divide-gray-100">
                        {groupAppointments.map((appointment) => {
                          const status = getAppointmentStatus(appointment);
                          const isJoinable = status === "Meeting in 5 min";

                          return (
                            <li
                              key={appointment.id}
                              className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 p-3 hover:bg-gray-50"
                            >
                              {!isRecurring && (
                                <Avatar className="w-8 h-8">
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
                              <div className="flex-grow space-y-1">
                                {!isRecurring && (
                                  <>
                                    <h3 className="text-sm font-semibold">
                                      {getConsumeeName(appointment)}
                                    </h3>
                                    <p className="text-xs text-gray-500">
                                      {getAppointmentTypeAndPlan(appointment)}
                                    </p>
                                  </>
                                )}
                                <div className="text-xs text-gray-500">
                                  {(() => {
                                    const startTime = getStartTime(appointment);
                                    return startTime
                                      ? formatAppointmentTime(
                                          startTime.toISOString(),
                                        )
                                      : "Time not set";
                                  })()}
                                </div>
                              </div>
                              <div className="flex items-center space-x-2">
                                <Badge
                                  variant="secondary"
                                  className={getBadgeStyleFromData(status)}
                                >
                                  {status}
                                </Badge>
                                {status !== "Completed" && isJoinable && (
                                  <Button
                                    className="bg-blue-500 text-white w-full sm:w-auto text-sm py-1"
                                    onClick={() =>
                                      handleJoinMeeting(appointment)
                                    }
                                  >
                                    Join meet
                                  </Button>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                },
              )}
              {Object.keys(groupedUpcomingAppointments).length === 0 && (
                <p className="text-gray-500">No upcoming appointments</p>
              )}
            </div>
            {/* View All Link */}
            {upcomingAppointments.length > 0 && (
              <div className="mt-4 text-center border-t pt-4">
                <Button
                  variant="link"
                  className="text-blue-600 hover:text-blue-700 font-medium"
                  onClick={() => router.push("../appointments")}
                >
                  View All Appointments →
                </Button>
              </div>
            )}
          </div>
        </Suspense>
      </div>
      <div className="space-y-4 lg:space-y-6">
        <Suspense fallback={<div>Loading client activity...</div>}>
          <div className="bg-white p-4 lg:p-6 rounded-lg shadow">
            <h2 className="text-lg lg:text-xl font-semibold mb-3 lg:mb-4">
              Clients Activity
            </h2>
            <ClientActivity
              activities={activities.map((activity) => ({
                id: activity.id,
                name: activity.name,
                action: activity.action,
                time: activity.time,
              }))}
            />
            <Button className="mt-3 lg:mt-4 w-full bg-blue-500 text-white">
              Login Report
            </Button>
          </div>
        </Suspense>
        <Suspense fallback={<div>Loading approvals...</div>}>
          <div className="bg-white p-4 lg:p-6 rounded-lg shadow">
            <h2 className="text-lg lg:text-xl font-semibold mb-3 lg:mb-4">
              Pending Approvals
            </h2>
            <div className="max-h-[300px] overflow-auto">
              <RequestSlotAllocationTabMini />
            </div>
          </div>
        </Suspense>
      </div>
    </div>
  );
}
