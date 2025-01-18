import React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { IAppointment } from "../types";
import {
  getConsumeeName,
  getConsumeeImage,
  getStartTime,
  formatAppointmentTime,
  getAppointmentStatus,
  getAppointmentTypeAndPlan,
} from "../utils/appointmentHelpers";

interface AppointmentCardProps extends IAppointment {
  getBadgeStyle: (badge: string) => string;
}

export function AppointmentCard(props: Readonly<AppointmentCardProps>) {
  const appointment: IAppointment = {
    id: props.id,
    appointmentType: props.appointmentType,
    slotsOfAppointment: props.slotsOfAppointment,
    consultation: props.consultation,
    subscription: props.subscription,
    webinar: props.webinar,
    class: props.class
  };

  const userName = getConsumeeName(appointment);
  const status = getAppointmentStatus(appointment);
  const isJoinable = status === "Meeting in 5 min";
  const joinButtonStyle = isJoinable
    ? "bg-black text-white hover:bg-gray-800"
    : "bg-gray-400 text-white cursor-not-allowed";

  // Get initials for avatar fallback
  const initials = userName
    .split(" ")
    .map((n: string) => n[0])
    .join("")
    .toUpperCase();

  const startTime = getStartTime(appointment);

  return (
    <Card className="bg-white hover:bg-gray-50 transition-colors border">
      <CardHeader className="p-3 sm:p-4">
        <div className="flex items-center gap-2 sm:gap-4">
          <Avatar className="w-8 h-8 sm:w-10 sm:h-10">
            <AvatarImage 
              alt={userName} 
              src={getConsumeeImage(appointment)} 
            />
            <AvatarFallback className="text-sm sm:text-base">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm sm:text-base font-medium truncate">
              {userName}
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm text-gray-600 line-clamp-2">
              {getAppointmentTypeAndPlan(appointment)}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-3 sm:px-4 py-2">
        <p className="text-xs sm:text-sm font-medium text-gray-700">
          {startTime ? formatAppointmentTime(startTime) : 'Time not set'}
        </p>
      </CardContent>
      <CardFooter className="p-3 sm:p-4 flex flex-col sm:flex-row gap-2 sm:gap-4 sm:items-center sm:justify-between">
        <div className="w-full sm:w-auto">
          <Badge
            variant="secondary"
            className={`${props.getBadgeStyle(status)} text-xs sm:text-sm w-full sm:w-auto justify-center sm:justify-start`}
          >
            {status}
          </Badge>
        </div>
        <Button
          variant="default"
          className={`${joinButtonStyle} text-xs sm:text-sm w-full sm:w-auto`}
          disabled={!isJoinable}
        >
          Join meet
        </Button>
      </CardFooter>
    </Card>
  );
}
