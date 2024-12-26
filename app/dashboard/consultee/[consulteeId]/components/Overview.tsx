"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
  ClassWithPlan,
} from "@/hooks/useEvents";
import { EventCard } from "./EventCard";
import { convertUTCToZoneTime } from "@/lib/datetimetz";

interface OverviewProps {
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
}

interface SlotInfo {
  startTime: string;
  endTime: string;
  timezone: string;
}

function parseSchedule(schedule: string | null): SlotInfo[] {
  if (!schedule) return [];
  try {
    return JSON.parse(schedule);
  } catch (e) {
    console.error('Error parsing schedule:', e);
    return [];
  }
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '';
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return dateObj.toISOString();
}

export function Overview({
  consultations,
  subscriptions,
  webinars,
  classes,
}: OverviewProps) {
  return (
    <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
      <DashboardCard
        title="Consultations"
        items={consultations.map((consultation) => ({
          title: consultation.consultationPlan.title,
          consultant:
            consultation.consultationPlan.consultantProfile?.user?.name ||
            "Unknown Consultant",
          date: consultation.preferredDateTime
            ? new Date(consultation.preferredDateTime).toLocaleString()
            : "Unknown Date",
          image: consultation.consultationPlan.consultantProfile?.user?.image,
          status: consultation.requestStatus.toString(),
          type: "Consultation" as const,
          slots: consultation.preferredDateTime ? [{
            startTime: formatDate(consultation.preferredDateTime),
            endTime: formatDate(new Date(new Date(consultation.preferredDateTime).getTime() + 60 * 60 * 1000))
          }] : undefined
        }))}
      />
      <DashboardCard
        title="Subscriptions"
        items={subscriptions.map((subscription) => ({
          title: subscription.subscriptionPlan.title,
          consultant:
            subscription.subscriptionPlan.consultantProfile?.user?.name ||
            "Unknown Consultant",
          date: subscription.startDate
            ? new Date(subscription.startDate).toLocaleString()
            : "Unknown Date",
          image: subscription.subscriptionPlan.consultantProfile?.user?.image,
          status: subscription.requestStatus.toString(),
          type: "Subscription" as const,
          slots: parseSchedule(subscription.tentativeSchedule)
        }))}
      />
      <DashboardCard
        title="Classes"
        items={classes.map((classItem) => ({
          title: classItem.classPlan.title,
          consultant:
            classItem.classPlan.consultantProfile?.user?.name ||
            "Unknown Consultant",
          date: classItem.startDate
            ? new Date(classItem.startDate).toLocaleString()
            : "Unknown Date",
          image: classItem.classPlan.consultantProfile?.user?.image,
          status: classItem.status.toString(),
          type: "Class" as const,
          slots: parseSchedule(classItem.tentativeSchedule)
        }))}
      />
      <DashboardCard
        title="Webinars"
        items={webinars.map((webinar) => ({
          title: webinar.webinarPlan.title,
          consultant:
            webinar.webinarPlan.consultantProfile?.user?.name ||
            "Unknown Consultant",
          date: webinar.scheduledAt
            ? new Date(webinar.scheduledAt).toLocaleString()
            : "Unknown Date",
          image: webinar.webinarPlan.consultantProfile?.user?.image,
          status: webinar.status.toString(),
          type: "Webinar" as const,
          slots: webinar.scheduledAt ? [{
            startTime: formatDate(webinar.scheduledAt),
            endTime: formatDate(webinar.endAt)
          }] : undefined
        }))}
      />
    </div>
  );
}

interface DashboardCardProps {
  title: string;
  items: {
    title: string;
    date: string;
    consultant: string;
    status?: string;
    image?: string | null;
    type: "Subscription" | "Class" | "Consultation" | "Webinar";
    slots?: Array<{
      startTime: string;
      endTime?: string;
    }>;
  }[];
}

function DashboardCard({ title, items }: DashboardCardProps) {
  return (
    <Card className="bg-white">
      <CardHeader className="bg-white">
        <CardTitle className="text-lg font-semibold bg-white">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="bg-white">
        <div className="space-y-4 bg-white">
          {items.map((item, index) => (
            <EventCard key={index} {...item} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
