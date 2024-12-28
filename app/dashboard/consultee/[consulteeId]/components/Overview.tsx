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
    return parsed.some((slot: { startTime: string }) =>
      isValidDate(slot.startTime),
    );
  } catch {
    return false;
  }
}

function formatDate(date: Date | null): string {
  if (!date) return "Please select a valid date and time";
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Overview({
  consultations,
  subscriptions,
  webinars,
  classes,
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
            isTentative: slotInfo.isTentative,
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
            isTentative: slotInfo.isTentative,
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
  }[];
}

function DashboardCard({ title, items }: Readonly<DashboardCardProps>) {
  return (
    <Card className="bg-white">
      <CardHeader className="bg-white">
        <CardTitle className="text-lg font-semibold bg-white">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="bg-white">
        <div className="space-y-4 bg-white">
          {items.map((item) => (
            <EventCard key={item.id} {...item} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
