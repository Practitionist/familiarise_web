"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ClassWithPlan,
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
} from "@/hooks/useEvents";
import { EventWithType } from "../utils";
import {
  getActualNextSlotTime,
  getActualSlots,
} from "../utils/actual-schedule";
import { EventCard } from "./EventCard";

interface OverviewProps {
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
}

interface AppointmentSlot {
  startTime: Date;
  endTime: Date;
}

function getNoSlotMessage(type: string): string {
  return `No slots scheduled for this ${type.toLowerCase()}. Please wait for confirmation.`;
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

function getValidAppointmentSlots(event: EventWithType): AppointmentSlot[] {
  const slots = getActualSlots(event);
  return slots.map((slot) => ({
    startTime: slot.date,
    endTime: slot.endTime || slot.date,
  }));
}

export function Overview({
  consultations,
  subscriptions,
  classes,
  webinars,
}: Readonly<OverviewProps>) {
  return (
    <div
      className="grid gap-8 md:grid-cols-2 lg:grid-cols-4"
      data-testid="overview-grid"
    >
      <DashboardCard
        title="Consultations"
        items={consultations.map((consultation) => {
          const slotInfo = getActualNextSlotTime({
            ...consultation,
            type: "Consultation",
          });
          return {
            id: consultation.id,
            title: consultation.consultationPlan.title,
            consultant:
              consultation.consultationPlan.consultantProfile?.user?.name ??
              "Unknown Consultant",
            date: slotInfo.date
              ? formatDate(slotInfo.date)
              : getNoSlotMessage("Consultation"),
            image: consultation.consultationPlan.consultantProfile?.user?.image,
            status: consultation.requestStatus.toString(),
            type: "Consultation" as const,
            isTentative: slotInfo.isTentative,
            actualSlots: getValidAppointmentSlots({
              ...consultation,
              type: "Consultation",
            }),
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

          return {
            id: subscription.id,
            title: subscription.subscriptionPlan.title,
            consultant:
              subscription.subscriptionPlan.consultantProfile?.user?.name ??
              "Unknown Consultant",
            date: slotInfo.date
              ? formatDate(slotInfo.date)
              : getNoSlotMessage("Subscription"),
            image: subscription.subscriptionPlan.consultantProfile?.user?.image,
            status: subscription.requestStatus.toString(),
            type: "Subscription" as const,
            isTentative: slotInfo.isTentative,
            actualSlots: getValidAppointmentSlots({
              ...subscription,
              type: "Subscription",
            }),
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

          return {
            id: classItem.id,
            title: classItem.classPlan.title,
            consultant:
              classItem.classPlan.consultantProfile?.user?.name ??
              "Unknown Consultant",
            date: slotInfo.date
              ? formatDate(slotInfo.date)
              : getNoSlotMessage("Class"),
            image: classItem.classPlan.consultantProfile?.user?.image,
            status: classItem.status.toString(),
            type: "Class" as const,
            isTentative: slotInfo.isTentative,
            actualSlots: getValidAppointmentSlots({
              ...classItem,
              type: "Class",
            }),
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
          return {
            id: webinar.id,
            title: webinar.webinarPlan.title,
            consultant:
              webinar.webinarPlan.consultantProfile?.user?.name ??
              "Unknown Consultant",
            date: slotInfo.date
              ? formatDate(slotInfo.date)
              : getNoSlotMessage("Webinar"),
            image: webinar.webinarPlan.consultantProfile?.user?.image,
            status: webinar.status.toString(),
            type: "Webinar" as const,
            isTentative: slotInfo.isTentative,
            actualSlots: getValidAppointmentSlots({
              ...webinar,
              type: "Webinar",
            }),
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
  }[];
}

function DashboardCard({ title, items }: Readonly<DashboardCardProps>) {
  return (
    <Card data-testid={`${title.toLowerCase()}-card`}>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {items.map((item) => (
            <EventCard
              key={item.id}
              {...item}
              data-testid={`${item.type.toLowerCase()}-${item.id}`}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
