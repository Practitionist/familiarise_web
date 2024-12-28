import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AppointmentCard } from "../components/AppointmentCard";
import { AppointmentsTabProps } from "../types";

export function AppointmentsTab({
  appointments,
  getBadgeStyle,
}: AppointmentsTabProps) {
  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <h2 className="text-xl font-semibold mb-4">All Appointments</h2>
      <div className="grid grid-cols-2 gap-4 mb-6">
        {appointments.slice(0, 2).map((appointment) => (
          <AppointmentCard
            key={appointment.id}
            {...appointment}
            getBadgeStyle={getBadgeStyle}
          />
        ))}
      </div>
      <ul className="space-y-4">
        {appointments.slice(2).map((appointment) => (
          <li
            key={appointment.id}
            className="flex items-center justify-between p-4 bg-gray-100 rounded-lg"
          >
            <div className="flex items-center space-x-4">
              <Avatar>
                <AvatarImage alt={appointment.name} src="/placeholder.svg" />
                <AvatarFallback>
                  {appointment.name
                    .split(" ")
                    .map((n: string) => n[0])
                    .join("")}
                </AvatarFallback>
              </Avatar>
              <div>
                <h3 className="font-semibold">{appointment.name}</h3>
                <p className="text-sm text-gray-600">
                  {appointment.description}
                </p>
                <p className="text-sm text-gray-500">{appointment.time}</p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <Badge
                variant="secondary"
                className={getBadgeStyle(appointment.badge)}
              >
                {appointment.badge}
              </Badge>
              <Button
                variant="default"
                className={
                  appointment.badge.includes("5 min")
                    ? "bg-black text-white hover:bg-gray-800"
                    : "bg-gray-400 text-white cursor-not-allowed"
                }
                disabled={!appointment.badge.includes("5 min")}
              >
                Join meet
              </Button>
            </div>
          </li>
        ))}
        {appointments.length === 0 && (
          <li className="text-center text-gray-500">No appointments found</li>
        )}
      </ul>
    </div>
  );
}
