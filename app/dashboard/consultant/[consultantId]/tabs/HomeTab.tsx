import React, { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AppointmentCard } from "../components/AppointmentCard";
import { ClientActivity } from "../components/ClientActivity";
import { RequestsTab } from "./RequestsTab";
import { HomeTabProps } from "../types";

export function HomeTab({
  todayAppointments,
  upcomingAppointments,
  activities,
  approvals,
  getBadgeStyle,
}: HomeTabProps) {
  if (!getBadgeStyle) {
    throw new Error("getBadgeStyle is required for HomeTab");
  }

  return (
    <div className="grid grid-cols-3 gap-6">
      <div className="col-span-2 space-y-6">
        <Suspense fallback={<div>Loading appointments...</div>}>
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">Today's Appointments</h2>
            <div className="grid grid-cols-2 gap-4">
              {todayAppointments.map((appointment) => (
                <AppointmentCard
                  key={appointment.id}
                  {...appointment}
                  getBadgeStyle={getBadgeStyle}
                />
              ))}
              {todayAppointments.length === 0 && (
                <p className="text-gray-500 col-span-2">
                  No appointments for today
                </p>
              )}
            </div>
          </div>
        </Suspense>
        <Suspense fallback={<div>Loading upcoming appointments...</div>}>
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">
              Upcoming Appointments
            </h2>
            <ul className="space-y-4">
              {upcomingAppointments.slice(0, 2).map((appointment) => (
                <li
                  key={appointment.id}
                  className="flex items-center space-x-4"
                >
                  <Avatar>
                    <AvatarImage
                      alt={appointment.name}
                      src="/placeholder.svg"
                    />
                    <AvatarFallback>
                      {appointment.name
                        .split(" ")
                        .map((n: string) => n[0])
                        .join("")}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-grow">
                    <h3 className="text-lg font-semibold">
                      {appointment.name}
                    </h3>
                    <p className="text-sm text-gray-500">
                      {appointment.description}
                    </p>
                    <p className="text-sm">{appointment.time}</p>
                    <Badge
                      variant="secondary"
                      className={getBadgeStyle(appointment.badge)}
                    >
                      {appointment.badge}
                    </Badge>
                  </div>
                  <Button className="bg-blue-500 text-white">Chat</Button>
                </li>
              ))}
              {upcomingAppointments.length === 0 && (
                <p className="text-gray-500">No upcoming appointments</p>
              )}
            </ul>
          </div>
        </Suspense>
      </div>
      <div className="space-y-6">
        <Suspense fallback={<div>Loading client activity...</div>}>
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">Clients Activity</h2>
            <ClientActivity activities={activities} />
            <Button className="mt-4 w-full bg-blue-500 text-white">
              Login Report
            </Button>
          </div>
        </Suspense>
        <Suspense fallback={<div>Loading approvals...</div>}>
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">
              Approvals for Consultations and Subscriptions
            </h2>
            <div className="max-h-[300px] overflow-auto">
              <RequestsTab approvals={approvals.slice(0, 3)} />
            </div>
          </div>
        </Suspense>
      </div>
    </div>
  );
}
