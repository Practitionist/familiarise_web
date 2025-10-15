"use client";

import { useToast } from "@/hooks/use-toast";
import { isDevelopmentEnvironment } from "@/utils/env";
import type { SlotOfAppointment } from "@prisma/client";
import type {
  IAppointment,
  ISlotOfAppointment,
} from "@/app/dashboard/consultant/[consultantId]/types";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import { Avatar, AvatarFallback, AvatarImage } from "components/ui/avatar";
import { Badge } from "components/ui/badge";
import { Button } from "components/ui/button";
import { Card } from "components/ui/card";
import { useRouter } from "next/navigation";
import {
  EventWithType,
  getConsultantImage,
  getConsultantInitial,
  getConsultantName,
  getEventStatus,
  getEventTitle,
  getStatusColor,
} from "../../utils/getMetadata";
import { formatTimeUntil } from "../../utils/scheduleHelpers";
import { formatDateTime, formatTimeString } from "./utils";

interface SlotCardProps {
  appointment: IAppointment;
  slot: ISlotOfAppointment;
  isTentative: boolean;
  isFirst?: boolean;
}

export function SlotCard({
  appointment,
  slot,
  isTentative,
  isFirst = false,
}: Readonly<SlotCardProps>) {
  const now = new Date();
  const startTime = new Date(slot.startsAt);
  const diffInMinutes = Math.floor(
    (startTime.getTime() - now.getTime()) / 60000,
  );
  const isJoinable = !isTentative && diffInMinutes <= 10 && diffInMinutes >= 0;

  const router = useRouter();
  const client = useStreamVideoClient();
  const { toast } = useToast();

  const handleJoinMeeting = async (e: React.MouseEvent) => {
    e.stopPropagation();

    try {
      if (!client) {
        toast({
          title: "Not signed in",
          description:
            "Video client not initialized. You have to sign in to join a meeting.",
          variant: "warning",
        });
        return;
      }

      const meetingId = `appointment-${appointment.id}`;

      const call = client.call("default", meetingId);

      if (!call) {
        toast({
          title: "Error",
          description: "Failed to create call",
          variant: "destructive",
        });
        return;
      }

      await call.getOrCreate({
        data: {
          starts_at: startTime.toISOString(),
          custom: {
            title:
              appointment.webinar?.webinarPlan?.title ??
              appointment.subscription?.subscriptionPlan?.title ??
              appointment.consultation?.consultationPlan?.title ??
              appointment.class?.classPlan?.title ??
              "Session",
            description: `${appointment.webinar?.webinarPlan?.title ?? appointment.subscription?.subscriptionPlan?.title ?? appointment.consultation?.consultationPlan?.title ?? appointment.class?.classPlan?.title ?? "Session"} Meeting`,
            eventId: appointment.id,
            eventType:
              appointment.webinar?.webinarPlan?.title ??
              appointment.subscription?.subscriptionPlan?.title ??
              appointment.consultation?.consultationPlan?.title ??
              appointment.class?.classPlan?.title ??
              "Session",
          },
        },
      });

      router.push(`/meetings/${meetingId}`);
      toast({
        title: "Joining meeting",
        description: "You will now be redirected to the meeting",
        variant: "success",
      });
    } catch (error) {
      console.error("Error joining meeting:", error);
      toast({
        title: "Error joining meeting",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  let status = "Unknown";
  const appointmentType = appointment.appointmentType;
  switch (appointmentType) {
    case "CONSULTATION":
      status = appointment.consultation?.requestStatus ?? "Unknown";
      break;
    case "SUBSCRIPTION":
      status = appointment.subscription?.requestStatus ?? "Unknown";
      break;
    case "WEBINAR":
      status = appointment.webinar?.status ?? "Unknown";
      break;
    case "CLASS":
      status = appointment.class?.status ?? "Unknown";
      break;
  }

  let consultantName = "Unknown Consultant";
  let consultantImage: string | null | undefined = "/placeholder.svg";
  let consultantInitial = "?";
  let eventTitle = `${appointmentType} Session`;

  switch (appointmentType) {
    case "CONSULTATION":
      consultantName =
        appointment.consultation?.consultationPlan?.consultantProfile?.user
          ?.name ?? consultantName;
      consultantImage =
        appointment.consultation?.consultationPlan?.consultantProfile?.user
          ?.image;
      consultantInitial =
        consultantName?.charAt(0).toUpperCase() ?? consultantInitial;
      eventTitle =
        appointment.consultation?.consultationPlan?.title ?? eventTitle;
      break;
    case "SUBSCRIPTION":
      consultantName =
        appointment.subscription?.subscriptionPlan?.consultantProfile?.user
          ?.name ?? consultantName;
      consultantImage =
        appointment.subscription?.subscriptionPlan?.consultantProfile?.user
          ?.image;
      consultantInitial =
        consultantName?.charAt(0).toUpperCase() ?? consultantInitial;
      eventTitle =
        appointment.subscription?.subscriptionPlan?.title ?? eventTitle;
      break;
    case "WEBINAR":
      consultantName =
        appointment.webinar?.webinarPlan?.consultantProfile?.user?.name ??
        "Webinar Host";
      consultantImage =
        appointment.webinar?.webinarPlan?.consultantProfile?.user?.image;
      consultantInitial = consultantName?.charAt(0).toUpperCase() ?? "W";
      eventTitle = appointment.webinar?.webinarPlan?.title ?? eventTitle;
      break;
    case "CLASS":
      consultantName =
        appointment.class?.classPlan?.consultantProfile?.user?.name ??
        "Class Instructor";
      consultantImage =
        appointment.class?.classPlan?.consultantProfile?.user?.image;
      consultantInitial = consultantName?.charAt(0).toUpperCase() ?? "C";
      eventTitle = appointment.class?.classPlan?.title ?? eventTitle;
      break;
  }

  return (
    <Card
      className={`h-full border-2 rounded-2xl group ${
        isFirst
          ? "border-blue-300 bg-gradient-to-br from-blue-50 via-indigo-50/50 to-blue-50 shadow-lg shadow-blue-100/50"
          : "border-gray-200 bg-white shadow-md"
      } hover:border-blue-400 hover:shadow-xl hover:-translate-y-1 transition-all duration-300 ease-out`}
    >
      <div className="p-4 flex flex-col h-full">
        <div className="flex items-start gap-3">
          <Avatar className="h-11 w-11 ring-2 ring-offset-2 ring-gray-100 group-hover:ring-blue-400 transition-all duration-300 shadow-sm">
            <AvatarImage
              src={consultantImage ?? "/placeholder.svg"}
              alt="Consultant"
            />
            <AvatarFallback className="bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-semibold">
              {consultantInitial}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex justify-between items-center mb-1.5">
              <h3
                className="font-bold text-base text-gray-900 truncate group-hover:text-blue-600 transition-colors"
                title={eventTitle}
              >
                {eventTitle}
              </h3>
              <Badge
                className={`flex-shrink-0 ${
                  isJoinable
                    ? "bg-gradient-to-r from-green-500 to-emerald-600 text-white animate-pulse shadow-md shadow-green-200"
                    : "bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-sm"
                } text-xs px-2.5 py-1 rounded-full font-semibold`}
              >
                {isJoinable ? "Now!" : formatTimeUntil(diffInMinutes)}
              </Badge>
            </div>
            <div className="space-y-1 text-sm text-gray-600">
              <p className="truncate font-medium" title={consultantName}>
                {consultantName}
              </p>
              <p className="text-xs text-gray-500">
                {formatDateTime(
                  new Date(slot.startsAt),
                  slot.endsAt ? new Date(slot.endsAt) : undefined,
                )}
              </p>
            </div>
          </div>
        </div>
        <div className="mt-auto pt-3 flex items-center justify-between gap-2 border-t border-gray-100 pt-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge
              variant="outline"
              className="text-xs rounded-full px-2.5 py-1 border-2 font-medium"
            >
              {appointmentType}
            </Badge>
            <Badge
              className={`${getStatusColor(status)} text-xs rounded-full px-2.5 py-1 font-medium shadow-sm`}
            >
              {status}
            </Badge>
            {isTentative && (
              <span className="text-red-600 text-xs font-semibold italic">
                *Tentative
              </span>
            )}
          </div>
          {(isDevelopmentEnvironment() || isJoinable) && (
            <Button
              onClick={handleJoinMeeting}
              className="ml-auto bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white text-xs h-8 px-4 rounded-lg shadow-md hover:shadow-lg hover:scale-105 transition-all duration-200 font-semibold"
            >
              {isDevelopmentEnvironment() ? "Join (Dev)" : "Join"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

interface MonthlyEventCardProps {
  event: EventWithType;
  slots: (SlotOfAppointment & { isPast?: boolean; isCancelled?: boolean })[];
}

export function MonthlyEventCard({
  event,
  slots,
}: Readonly<MonthlyEventCardProps>) {
  const status = getEventStatus(event);
  const title = getEventTitle(event);
  const name = getConsultantName(event);
  const image = getConsultantImage(event);
  const initial = getConsultantInitial(event);
  const eventType = event.type;

  const handleClick = () => {
    console.log("MonthlyEventCard clicked:", {
      id: event.id,
      title,
      type: eventType,
      status,
      consultant: name,
      slots,
    });
  };

  return (
    <div className="group">
      <Button
        onClick={handleClick}
        variant="ghost"
        className="w-full text-left px-6 py-4 h-auto hover:bg-gradient-to-r hover:from-blue-50/50 hover:to-indigo-50/30 rounded-xl transition-all duration-200 block"
      >
        <div className="flex items-center gap-4">
          <Avatar className="h-10 w-10 ring-2 ring-gray-100 group-hover:ring-blue-300 transition-all duration-200 shadow-sm">
            <AvatarImage src={image ?? "/placeholder.svg"} alt="Consultant" />
            <AvatarFallback className="bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-semibold">
              {initial}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-bold text-base text-gray-900 truncate group-hover:text-blue-600 transition-colors">
                  {title}
                </h3>
                <span
                  className="text-sm text-gray-600 font-medium"
                  data-testid="consultant-name"
                >
                  {name}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  className={`${
                    eventType === "Subscription"
                      ? "bg-gradient-to-r from-purple-500 to-pink-600 text-white"
                      : "bg-gradient-to-r from-indigo-500 to-blue-600 text-white"
                  } text-xs px-3 py-1 shadow-sm font-semibold rounded-full`}
                >
                  {eventType}
                </Badge>
                <Badge
                  className={`${getStatusColor(status)} text-xs px-3 py-1 shadow-sm font-semibold rounded-full`}
                  data-testid="event-status"
                >
                  {status}
                </Badge>
              </div>
            </div>
          </div>
        </div>
      </Button>
      <div className="px-6 pb-4">
        <div className="mt-2 space-y-2 bg-gray-50/50 rounded-lg p-3">
          {slots.map((slot) => (
            <div
              key={slot.id}
              className="text-sm text-gray-700 flex items-center gap-4 hover:text-gray-900 transition-colors"
              data-testid="monthly-slot"
            >
              <span className="min-w-[110px] font-semibold text-gray-800">
                {new Date(slot.startsAt).toLocaleString(undefined, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}
              </span>
              <span className="font-medium">
                {slot.endsAt
                  ? `${formatTimeString(new Date(slot.startsAt))} - ${formatTimeString(new Date(slot.endsAt))}`
                  : formatTimeString(new Date(slot.startsAt))}
                {slot.isTentative && (
                  <span className="text-red-600 ml-1 font-bold">*</span>
                )}
              </span>
            </div>
          ))}
          {slots.some((slot) => slot.isTentative) && (
            <div
              className="text-xs text-red-600 font-semibold italic pt-1"
              data-testid="tentative-notice"
            >
              * Subject to change
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
