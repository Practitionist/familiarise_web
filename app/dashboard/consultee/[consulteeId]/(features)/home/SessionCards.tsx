"use client";

import { memo } from "react";
import { useToast } from "@/hooks/use-toast";
import { isDevelopmentEnvironment } from "@/utils/env";
import type { SlotOfAppointment } from "@prisma/client";
import type { TAppointment, TSlotOfAppointment } from "@/types/appointment";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import { Avatar, AvatarFallback, AvatarImage } from "components/ui/avatar";
import { Badge } from "components/ui/badge";
import { Button } from "components/ui/button";
import { Card } from "components/ui/card";
import { useRouter } from "next/navigation";
import { getOrCreateAppointmentMeeting } from "@/lib/meeting";
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
  appointment: TAppointment;
  slot: TSlotOfAppointment;
  isTentative: boolean;
  isFirst?: boolean;
}

export const SlotCard = memo(function SlotCard({
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

      const meetingId = await getOrCreateAppointmentMeeting(
        client,
        appointment,
        slot,
      );

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
      status = appointment.consultation?.status ?? "Unknown";
      break;
    case "SUBSCRIPTION":
      status = appointment.subscription?.status ?? "Unknown";
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
      className={`h-full border rounded-lg ${
        isFirst ? "border-blue-200 bg-blue-50/30" : "border-gray-200 bg-white"
      } hover:border-gray-300 hover:shadow-sm transition-all duration-200`}
    >
      <div className="p-3 flex flex-col h-full">
        <div className="flex items-start gap-3">
          <Avatar className="h-9 w-9">
            <AvatarImage
              src={consultantImage ?? "/placeholder.svg"}
              alt="Consultant"
            />
            <AvatarFallback>{consultantInitial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex justify-between items-center mb-1">
              <h3
                className="font-semibold text-sm text-gray-800 truncate"
                title={eventTitle}
              >
                {eventTitle}
              </h3>
              <Badge
                className={`flex-shrink-0 ${
                  isJoinable
                    ? "bg-green-100 text-green-800 animate-pulse"
                    : "bg-blue-100 text-blue-800"
                } text-xs px-2 py-0.5 rounded-full`}
              >
                {isJoinable ? "Now!" : formatTimeUntil(diffInMinutes)}
              </Badge>
            </div>
            <div className="space-y-0.5 text-xs text-gray-500">
              <p className="truncate" title={consultantName}>
                {consultantName}
              </p>
              <p>
                {formatDateTime(
                  new Date(slot.startsAt),
                  slot.endsAt ? new Date(slot.endsAt) : undefined,
                )}
              </p>
            </div>
          </div>
        </div>
        <div className="mt-auto pt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge
              variant="outline"
              className="text-xs rounded-full px-2 py-0.5"
            >
              {appointmentType}
            </Badge>
            <Badge
              className={`${getStatusColor(status)} text-xs rounded-full px-2 py-0.5`}
            >
              {status}
            </Badge>
            {isTentative && (
              <span className="text-red-500 text-xs italic">*Tentative</span>
            )}
          </div>
          {(isDevelopmentEnvironment() || isJoinable) && (
            <Button
              onClick={handleJoinMeeting}
              className="ml-auto bg-gradient-to-b from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white text-xs h-6 px-2.5 rounded-md shadow-sm hover:shadow-md transition-all duration-200"
            >
              {isDevelopmentEnvironment() ? "Join (Dev)" : "Join"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
});

interface MonthlyEventCardProps {
  event: EventWithType;
  slots: (SlotOfAppointment & { isPast?: boolean; isCancelled?: boolean })[];
}

export const MonthlyEventCard = memo(function MonthlyEventCard({
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
    <div>
      <Button
        onClick={handleClick}
        variant="ghost"
        className="w-full text-left px-6 py-4 h-auto hover:bg-gray-50 block"
      >
        <div className="flex items-center gap-4">
          <Avatar className="h-8 w-8">
            <AvatarImage src={image ?? "/placeholder.svg"} alt="Consultant" />
            <AvatarFallback>{initial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-medium text-sm text-gray-900 truncate">
                  {title}
                </h3>
                <span
                  className="text-sm text-gray-600"
                  data-testid="consultant-name"
                >
                  {name}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  className={`${
                    eventType === "Subscription"
                      ? "bg-purple-100 text-purple-800"
                      : "bg-indigo-100 text-indigo-800"
                  } text-xs px-2 py-0.5`}
                >
                  {eventType}
                </Badge>
                <Badge
                  className={`${getStatusColor(status)} text-xs px-2 py-0.5`}
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
        <div className="mt-2 space-y-1">
          {slots.map((slot) => (
            <div
              key={slot.id}
              className="text-sm text-gray-600 flex items-center gap-4"
              data-testid="monthly-slot"
            >
              <span className="min-w-[100px]">
                {new Date(slot.startsAt).toLocaleString(undefined, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}
              </span>
              <span>
                {slot.endsAt
                  ? `${formatTimeString(new Date(slot.startsAt))} - ${formatTimeString(new Date(slot.endsAt))}`
                  : formatTimeString(new Date(slot.startsAt))}
                {slot.isTentative && (
                  <span className="text-red-500 ml-1">*</span>
                )}
              </span>
            </div>
          ))}
          {slots.some((slot) => slot.isTentative) && (
            <div
              className="text-xs text-red-500"
              data-testid="tentative-notice"
            >
              * Subject to change
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
