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
  sortAppointmentsByStartTime
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

  // Filter appointments for today and upcoming
  const todayAppointments = getTodayAppointments(appointments || [])
    .filter(appointment => {
      const status = getAppointmentStatus(appointment);
      return status !== "Completed";
    });

  // Get all upcoming appointments that aren't today and aren't completed
  const upcomingAppointments = sortAppointmentsByStartTime(
    getUpcomingAppointments(appointments || [])
      .filter(appointment => {
        const status = getAppointmentStatus(appointment);
        return status !== "Completed" && status !== "Today";
      })
  );

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
            <ul className="space-y-3 lg:space-y-4">
              {upcomingAppointments.map((appointment) => {
                const userName = getConsumeeName(appointment);
                const status = getAppointmentStatus(appointment);
                const isSubscription = appointment.appointmentType === 'SUBSCRIPTION';

                return (
                  <li
                    key={appointment.id}
                    className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 p-2 hover:bg-gray-50 rounded-lg transition-colors"
                  >
                    <Avatar className="w-10 h-10 lg:w-12 lg:h-12">
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
                    <div className="flex-grow space-y-1">
                      <h3 className="text-base lg:text-lg font-semibold">
                        {userName}
                      </h3>
                      <p className="text-sm text-gray-500">
                        {getAppointmentTypeAndPlan(appointment)}
                      </p>
                      <p className="text-sm">
                        {getStartTime(appointment) ? formatAppointmentTime(getStartTime(appointment)!) : 'Time not set'}
                      </p>
                      {isSubscription && appointment.subscription && (
                        <p className="text-xs text-gray-500">
                          Subscription ends: {formatAppointmentTime(appointment.subscription.endDate)}
                        </p>
                      )}
                      <Badge
                        variant="secondary"
                        className={getBadgeStyle(status)}
                      >
                        {status}
                      </Badge>
                    </div>
                    <Button className="bg-blue-500 text-white w-full sm:w-auto">
                      Chat
                    </Button>
                  </li>
                );
              })}
              {upcomingAppointments.length === 0 && (
                <p className="text-gray-500">No upcoming appointments</p>
              )}
            </ul>
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
