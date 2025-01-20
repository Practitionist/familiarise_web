import React, { Suspense } from "react";
import { Button } from "components/ui/button";
import { Badge } from "components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "components/ui/avatar";
import { RequestsTab } from "../requests/RequestsTab";
import { HomeTabProps } from "../../types";
import { ClientActivity } from "../../components/ClientActivity";
import {
  getConsumeeName,
  getConsumeeImage,
  getStartTime,
  formatAppointmentTime,
  getAppointmentStatus,
  getAppointmentTypeAndPlan,
  getTodayAppointments,
  getUpcomingAppointments,
  sortAppointmentsByStartTime,
  groupRecurringAppointments,
  getGroupTitle,
  getGroupStatus,
  getSlotTimes,
} from "../../utils/appointmentHelpers";

export function HomeTab({
  appointments,
  activities,
  approvals,
  getBadgeStyle,
  onUpdate,
}: Readonly<HomeTabProps>) {
  if (!getBadgeStyle) {
    throw new Error("getBadgeStyle is required for HomeTab");
  }

  // Expand appointments into individual slots
  const expandedAppointments = (appointments || []).flatMap(appointment => {
    if (!appointment.slotsOfAppointment || appointment.slotsOfAppointment.length === 0) {
      return [appointment];
    }
    return appointment.slotsOfAppointment.map(slot => ({
      ...appointment,
      id: `${appointment.id}-${slot.id}`,
      slotsOfAppointment: [slot]
    }));
  });

  // Filter appointments for today
  const todayAppointments = getTodayAppointments(expandedAppointments)
    .filter(appointment => {
      const status = getAppointmentStatus(appointment);
      return status !== "Completed";
    });

  // Get all upcoming appointments
  const upcomingAppointments = sortAppointmentsByStartTime(
    getUpcomingAppointments(expandedAppointments)
  );

  // Group upcoming appointments
  const groupedUpcomingAppointments = groupRecurringAppointments(upcomingAppointments);

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
                  <div key={appointment.id} className="bg-gray-100 p-4 rounded-lg">
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
                      <p className="text-sm text-gray-500">
                        {getStartTime(appointment) ? formatAppointmentTime(getStartTime(appointment)!) : 'Time not set'}
                      </p>
                      <div className="mt-2 flex items-center justify-between">
                        <Badge
                          variant="secondary"
                          className={getBadgeStyle(status)}
                        >
                          {status}
                        </Badge>
                        <Button
                          variant="default"
                          size="sm"
                          className={joinButtonStyle}
                          disabled={!isJoinable}
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
              {Object.entries(groupedUpcomingAppointments).map(([groupKey, groupAppointments]) => {
                const isRecurring = groupKey.startsWith('subscription-') || groupKey.startsWith('class-');
                const groupTitle = getGroupTitle(groupAppointments);
                const groupStatus = getGroupStatus(groupAppointments);
                const firstAppointment = groupAppointments[0];
                const userName = getConsumeeName(firstAppointment);

                return (
                  <div key={groupKey} className="border rounded-lg overflow-hidden">
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
                              <h3 className="font-semibold text-sm">{userName}</h3>
                              <p className="text-xs text-gray-600">{groupTitle}</p>
                            </div>
                          </div>
                          <Badge
                            variant="secondary"
                            className={getBadgeStyle(groupStatus)}
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
                              <p className="text-xs">
                                {getStartTime(appointment) ? formatAppointmentTime(getStartTime(appointment)!) : 'Time not set'}
                              </p>
                            </div>
                            <div className="flex items-center space-x-2">
                              <Badge
                                variant="secondary"
                                className={getBadgeStyle(status)}
                              >
                                {status}
                              </Badge>
                              {status !== "Completed" && (
                                <Button 
                                  className="bg-blue-500 text-white w-full sm:w-auto text-sm py-1"
                                  disabled={!isJoinable}
                                >
                                  {isJoinable ? "Join meet" : "Chat"}
                                </Button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
              {Object.keys(groupedUpcomingAppointments).length === 0 && (
                <p className="text-gray-500">No upcoming appointments</p>
              )}
            </div>
          </div>
        </Suspense>
      </div>
      <div className="space-y-4 lg:space-y-6">
        <Suspense fallback={<div>Loading client activity...</div>}>
          <div className="bg-white p-4 lg:p-6 rounded-lg shadow">
            <h2 className="text-lg lg:text-xl font-semibold mb-3 lg:mb-4">
              Clients Activity
            </h2>
            <ClientActivity activities={activities} />
            <Button className="mt-3 lg:mt-4 w-full bg-blue-500 text-white">
              Login Report
            </Button>
          </div>
        </Suspense>
        <Suspense fallback={<div>Loading approvals...</div>}>
          <div className="bg-white p-4 lg:p-6 rounded-lg shadow">
            <h2 className="text-lg lg:text-xl font-semibold mb-3 lg:mb-4">
              Approvals for Consultations and Subscriptions
            </h2>
            <div className="max-h-[300px] overflow-auto">
              <RequestsTab approvals={approvals.slice(0, 3)} onUpdate={onUpdate} />
            </div>
          </div>
        </Suspense>
      </div>
    </div>
  );
}
