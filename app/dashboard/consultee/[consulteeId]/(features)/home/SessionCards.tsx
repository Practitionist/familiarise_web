"use client";

import { Avatar, AvatarFallback, AvatarImage } from "components/ui/avatar";
import { Badge } from "components/ui/badge";
import { Button } from "components/ui/button";
import { Card } from "components/ui/card";
import { EventWithType, getConsultantImage, getConsultantInitial, getConsultantName, getEventStatus, getEventTitle, getStatusColor } from "../../utils";
import { formatTimeUntil } from "../../utils/actual-schedule";
import { formatDateTime, formatTimeString } from "./utils";
import type { SlotWithStatus } from "../../utils/actual-schedule";

interface SlotCardProps {
  event: EventWithType;
  slotTime: Date;
  endTime?: Date;
  isTentative: boolean;
  isFirst?: boolean;
}

export function SlotCard({
  event,
  slotTime,
  endTime,
  isTentative,
  isFirst = false,
}: SlotCardProps) {
  const now = new Date();
  const diffInMinutes = Math.floor(
    (slotTime.getTime() - now.getTime()) / 60000,
  );
  const isJoinable = !isTentative && diffInMinutes <= 10 && diffInMinutes >= 0;
  const status = getEventStatus(event);

  const handleJoinMeeting = (e: React.MouseEvent) => {
    e.stopPropagation();
    console.log("Joining meeting:", {
      id: event.id,
      title: getEventTitle(event),
      type: event.type,
    });
  };

  const handleClick = () => {
    if (!isJoinable) {
      console.log("SlotCard clicked:", {
        id: event.id,
        title: getEventTitle(event),
        type: event.type,
        status,
        consultant: getConsultantName(event),
        time: slotTime,
        isTentative,
      });
    }
  };

  return (
    <Card className={`h-full border ${
      isFirst ? 'border-blue-100 bg-blue-50/50' : 'border-gray-200 bg-white'
    } hover:border-gray-300 transition-colors`}>
      <div className="p-4">
        <div className="flex items-start gap-4">
          <Avatar className="h-10 w-10">
            <AvatarImage
              src={getConsultantImage(event) ?? "/placeholder.svg"}
              alt="Consultant"
            />
            <AvatarFallback>
              {getConsultantInitial(event)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <h3 className="font-medium text-gray-900 truncate">
              {getEventTitle(event)}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-gray-600">
                {getConsultantName(event)}
              </span>
              <span className="text-gray-600">
                {formatDateTime(slotTime, endTime)}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {event.type}
              </Badge>
              <Badge
                className={`${getStatusColor(status)} text-xs`}
              >
                {status}
              </Badge>
              {isTentative && (
                <span className="text-red-500 text-xs">
                  *Subject to change
                </span>
              )}
              {isJoinable && (
                <Button
                  onClick={handleJoinMeeting}
                  className="ml-auto bg-green-600 hover:bg-green-700 text-white text-xs h-7"
                >
                  Join Now
                </Button>
              )}
            </div>
          </div>
          <div className="flex-shrink-0">
            <Badge
              className={`${
                isJoinable
                  ? "bg-green-100 text-green-800 animate-pulse"
                  : "bg-blue-100 text-blue-800"
              } text-xs px-2 py-0.5`}
            >
              {isJoinable ? "Starting Soon!" : formatTimeUntil(diffInMinutes)}
            </Badge>
          </div>
        </div>
      </div>
    </Card>
  );
}

interface MonthlyEventCardProps {
  event: EventWithType;
  slots: SlotWithStatus[];
}

export function MonthlyEventCard({ event, slots }: MonthlyEventCardProps) {
  const status = getEventStatus(event);

  const handleClick = () => {
    console.log("MonthlyEventCard clicked:", {
      id: event.id,
      title: getEventTitle(event),
      type: event.type,
      status,
      consultant: getConsultantName(event),
      slots,
    });
  };

  return (
    <Button
      onClick={handleClick}
      variant="ghost"
      className="w-full text-left px-6 py-4 h-auto hover:bg-gray-50 block"
    >
      <div className="flex items-center gap-4">
        <Avatar className="h-8 w-8">
          <AvatarImage
            src={getConsultantImage(event) ?? "/placeholder.svg"}
            alt="Consultant"
          />
          <AvatarFallback>{getConsultantInitial(event)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-medium text-sm text-gray-900 truncate">
                {getEventTitle(event)}
              </h3>
              <span className="text-sm text-gray-600" data-testid="consultant-name">
                {getConsultantName(event)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                className={`${
                  event.type === "Subscription"
                    ? "bg-purple-100 text-purple-800"
                    : "bg-indigo-100 text-indigo-800"
                } text-xs px-2 py-0.5`}
              >
                {event.type}
              </Badge>
              <Badge
                className={`${getStatusColor(status)} text-xs px-2 py-0.5`}
                data-testid="event-status"
              >
                {status}
              </Badge>
            </div>
          </div>
          <div className="mt-2 space-y-1">
            {slots.map((slot) => (
              <div
                key={slot.date.getTime()}
                className="text-sm text-gray-600 flex items-center gap-4"
                data-testid="monthly-slot"
              >
                <span className="min-w-[100px]">
                  {slot.date.toLocaleString(undefined, {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                  })}
                </span>
                <span>
                  {slot.endTime
                    ? `${formatTimeString(slot.date)} - ${formatTimeString(
                        slot.endTime
                      )}`
                    : formatTimeString(slot.date)}
                  {slot.isTentative && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </span>
              </div>
            ))}
            {slots.some((slot) => slot.isTentative) && (
              <div className="text-xs text-red-500" data-testid="tentative-notice">
                * Subject to change
              </div>
            )}
          </div>
        </div>
      </div>
    </Button>
  );
}
