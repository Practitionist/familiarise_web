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
import { IAppointment, BADGE_STYLES } from "../types";

interface AppointmentCardProps extends IAppointment {
  getBadgeStyle: (badge: string) => string;
}

export function AppointmentCard({
  name,
  description,
  time,
  badge,
  getBadgeStyle,
}: Readonly<AppointmentCardProps>) {
  // Get initials for avatar fallback
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  // Determine if join button should be enabled and its style
  const isJoinable = badge.includes("5 min");
  const joinButtonStyle = isJoinable
    ? "bg-black text-white hover:bg-gray-800"
    : "bg-gray-400 text-white cursor-not-allowed";

  return (
    <Card className="bg-purple-100 hover:bg-purple-50 transition-colors">
      <CardHeader className="p-3 sm:p-4">
        <div className="flex items-center gap-2 sm:gap-4">
          <Avatar className="w-8 h-8 sm:w-10 sm:h-10">
            <AvatarImage alt={name} src="/placeholder.svg" />
            <AvatarFallback className="text-sm sm:text-base">
              {initials || "?"}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm sm:text-base font-medium truncate">
              {name}
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm text-gray-600 line-clamp-2">
              {description}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-3 sm:px-4 py-2">
        <p className="text-xs sm:text-sm font-medium text-gray-700">{time}</p>
      </CardContent>
      <CardFooter className="p-3 sm:p-4 flex flex-col sm:flex-row gap-2 sm:gap-4 sm:items-center sm:justify-between">
        <div className="w-full sm:w-auto">
          {badge === "Schedule unavailable" ? (
            <Badge
              variant="secondary"
              className={`${BADGE_STYLES.default} text-xs sm:text-sm w-full sm:w-auto justify-center sm:justify-start`}
            >
              Schedule unavailable
            </Badge>
          ) : (
            <Badge
              variant="secondary"
              className={`${getBadgeStyle(badge)} text-xs sm:text-sm w-full sm:w-auto justify-center sm:justify-start`}
            >
              {badge}
            </Badge>
          )}
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
