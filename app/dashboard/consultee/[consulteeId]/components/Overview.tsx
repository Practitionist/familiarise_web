"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ClassWithPlan,
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
} from "@/hooks/useEvents";
import { EventCard } from "./EventCard";
import { getActualNextSlotTime } from "../utils/actual-schedule";

interface OverviewProps {
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
}

interface Slot {
  startTime: string;
  endTime?: string;
  timezone?: string;
}

interface AppointmentSlot {
  startTime: Date;
  endTime: Date;
}

function getNoSlotMessage(type: string, hasPreferredTime: boolean): string {
  switch (type) {
    case "Consultation":
      return hasPreferredTime
        ? "No available consultation slots found for your preferred time. Please try a different time"
        : "Please select a valid preferred date and time for your consultation";
    case "Subscription":
      return hasPreferredTime
        ? "No available slots found for your selected dates. Please try different dates"
        : "Please select valid dates for your subscription";
    case "Class":
      return hasPreferredTime
        ? "No available slots found for your selected dates. Please try different dates"
        : "Please select valid dates for your class";
    case "Webinar":
      return hasPreferredTime
        ? "No available slots found for this webinar. Please select a different session"
        : "Please select a valid date and time for the webinar";
    default:
      return "Please select a valid date and time";
  }
}

function isValidDate(date: string | Date | null | undefined): boolean {
  if (!date) return false;
  const parsedDate = typeof date === "string" ? new Date(date) : date;
  return parsedDate.getFullYear() > 2000;
}

function hasValidTentativeSchedule(
  schedule: string | null | undefined,
): boolean {
  if (!schedule) return false;
  try {
    const parsed = JSON.parse(schedule);
    return parsed.some((slot: Slot) => isValidDate(slot.startTime));
  } catch {
    return false;
  }
}

function formatDate(date: Date | null): string {
  if (!date) return "Please select a valid date and time";
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatSlotTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function parseTentativeSchedule(schedule: string | null | undefined): Slot[] {
  if (!schedule) return [];
  try {
    const slots = JSON.parse(schedule);
    return slots
      .filter((slot: Slot) => isValidDate(slot.startTime))
      .map((slot: Slot) => ({
        startTime: slot.startTime,
        endTime:
          slot.endTime ||
          new Date(
            new Date(slot.startTime).getTime() + 60 * 60 * 1000,
          ).toISOString(),
        timezone: slot.timezone || "UTC",
      }))
      .sort(
        (a: Slot, b: Slot) =>
          new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
      );
  } catch {
    return [];
  }
}

function getValidAppointmentSlots(
  appointments: any[] | null | undefined,
): AppointmentSlot[] {
  if (!appointments?.length) return [];
  return appointments
    .flatMap((appointment) =>
      appointment.slotsOfAppointment.map((slot: any) => ({
        startTime: new Date(slot.slotStartTimeInUTC),
        endTime: new Date(slot.slotEndTimeInUTC),
      })),
    )
    .filter((slot) => isValidDate(slot.startTime))
    .sort(
      (a: AppointmentSlot, b: AppointmentSlot) =>
        a.startTime.getTime() - b.startTime.getTime(),
    );
}

export function Overview({
  consultations,
  subscriptions,
  classes,
  webinars,
}: Readonly<OverviewProps>) {
  return (
    <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
      <DashboardCard
        title="Consultations"
        items={consultations.map((consultation) => {
          const slotInfo = getActualNextSlotTime({
            ...consultation,
            type: "Consultation",
          });
          const hasPreferredTime = isValidDate(consultation.preferredDateTime);
          return {
            id: consultation.id,
            title: consultation.consultationPlan.title,
            consultant:
              consultation.consultationPlan.consultantProfile?.user?.name ??
              "Unknown Consultant",
            date: slotInfo.date
              ? formatDate(slotInfo.date)
              : getNoSlotMessage("Consultation", hasPreferredTime),
            image: consultation.consultationPlan.consultantProfile?.user?.image,
            status: consultation.requestStatus.toString(),
            type: "Consultation" as const,
            isTentative: slotInfo.isTentative,
            actualSlots: getValidAppointmentSlots([consultation.appointment]),
          };
        })}
      />
      <DashboardCard
        title="Subscriptions"
        items={subscriptions.map((subscription) => {
          const slotInfo = getActualNextSlotTime({
            ...subscription,
            type: "Subscription",
          });
          const hasPreferredTime = hasValidTentativeSchedule(
            subscription.tentativeSchedule,
          );
          const actualSlots = getValidAppointmentSlots(
            subscription.appointments,
          );
          const tentativeSlots = parseTentativeSchedule(
            subscription.tentativeSchedule,
          );

          return {
            id: subscription.id,
            title: subscription.subscriptionPlan.title,
            consultant:
              subscription.subscriptionPlan.consultantProfile?.user?.name ??
              "Unknown Consultant",
            date: slotInfo.date
              ? formatDate(slotInfo.date)
              : getNoSlotMessage("Subscription", hasPreferredTime),
            image: subscription.subscriptionPlan.consultantProfile?.user?.image,
            status: subscription.requestStatus.toString(),
            type: "Subscription" as const,
            isTentative: slotInfo.isTentative || !actualSlots.length,
            actualSlots,
            tentativeSlots: actualSlots.length ? [] : tentativeSlots, // Only show tentative if no actual slots
          };
        })}
      />
      <DashboardCard
        title="Classes"
        items={classes.map((classItem) => {
          const slotInfo = getActualNextSlotTime({
            ...classItem,
            type: "Class",
          });
          const hasPreferredTime = hasValidTentativeSchedule(
            classItem.tentativeSchedule,
          );
          const actualSlots = getValidAppointmentSlots(classItem.appointment);
          const tentativeSlots = parseTentativeSchedule(
            classItem.tentativeSchedule,
          );

          return {
            id: classItem.id,
            title: classItem.classPlan.title,
            consultant:
              classItem.classPlan.consultantProfile?.user?.name ??
              "Unknown Consultant",
            date: slotInfo.date
              ? formatDate(slotInfo.date)
              : getNoSlotMessage("Class", hasPreferredTime),
            image: classItem.classPlan.consultantProfile?.user?.image,
            status: classItem.status.toString(),
            type: "Class" as const,
            isTentative: slotInfo.isTentative || !actualSlots.length,
            actualSlots,
            tentativeSlots: actualSlots.length ? [] : tentativeSlots, // Only show tentative if no actual slots
          };
        })}
      />
      <DashboardCard
        title="Webinars"
        items={webinars.map((webinar) => {
          const slotInfo = getActualNextSlotTime({
            ...webinar,
            type: "Webinar",
          });
          const hasPreferredTime = isValidDate(webinar.scheduledAt);
          return {
            id: webinar.id,
            title: webinar.webinarPlan.title,
            consultant:
              webinar.webinarPlan.consultantProfile?.user?.name ??
              "Unknown Consultant",
            date: slotInfo.date
              ? formatDate(slotInfo.date)
              : getNoSlotMessage("Webinar", hasPreferredTime),
            image: webinar.webinarPlan.consultantProfile?.user?.image,
            status: webinar.status.toString(),
            type: "Webinar" as const,
            isTentative: slotInfo.isTentative,
            actualSlots: getValidAppointmentSlots([webinar.appointment]),
          };
        })}
      />
    </div>
  );
}

interface DashboardCardProps {
  title: string;
  items: {
    id: string;
    title: string;
    date: string;
    consultant: string;
    status?: string;
    image?: string | null;
    type: "Subscription" | "Class" | "Consultation" | "Webinar";
    isTentative: boolean;
    actualSlots?: AppointmentSlot[];
    tentativeSlots?: Slot[];
  }[];
}

function DashboardCard({ title, items }: Readonly<DashboardCardProps>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {items.map((item) => (
            <EventCard key={item.id} {...item} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
