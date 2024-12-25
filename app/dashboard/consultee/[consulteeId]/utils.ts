import {
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
  ClassWithPlan,
} from "@/hooks/useEvents";

export type EventWithType =
  | (ConsultationWithPlan & { type: "Consultation" })
  | (SubscriptionWithPlan & { type: "Subscription" })
  | (WebinarWithPlan & { type: "Webinar" })
  | (ClassWithPlan & { type: "Class" });

export function getNextSlotTime(event: EventWithType): Date {
  const now = Date.now();
  switch (event.type) {
    case "Consultation":
      return new Date(event.preferredDateTime || now);
    case "Subscription":
      return new Date(event.startDate || now);
    case "Webinar":
      return new Date(event.scheduledAt || now);
    case "Class":
      return new Date(event.startDate || now);
    default:
      return new Date(now);
  }
}

export function formatTimeUntil(minutes: number): string {
  if (minutes < 60) {
    return `In ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `In ${hours} hr${hours > 1 ? "s" : ""}`;
  }
  return "Upcoming";
}

export function getEventTitle(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return event.consultationPlan.title;
    case "Subscription":
      return event.subscriptionPlan.title;
    case "Webinar":
      return event.webinarPlan.title;
    case "Class":
      return event.classPlan.title;
    default:
      return "Unknown Event";
  }
}

export function getConsultantName(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return (
        event.consultationPlan.consultantProfile?.user?.name ||
        "Unknown Consultant"
      );
    case "Subscription":
      return (
        event.subscriptionPlan.consultantProfile?.user?.name ||
        "Unknown Consultant"
      );
    case "Webinar":
      return (
        event.webinarPlan.consultantProfile?.user?.name || "Unknown Consultant"
      );
    case "Class":
      return (
        event.classPlan.consultantProfile?.user?.name || "Unknown Consultant"
      );
    default:
      return "Unknown Consultant";
  }
}

export function getConsultantImage(event: EventWithType): string | null {
  switch (event.type) {
    case "Consultation":
      return event.consultationPlan.consultantProfile?.user?.image || null;
    case "Subscription":
      return event.subscriptionPlan.consultantProfile?.user?.image || null;
    case "Webinar":
      return event.webinarPlan.consultantProfile?.user?.image || null;
    case "Class":
      return event.classPlan.consultantProfile?.user?.image || null;
    default:
      return null;
  }
}

export function getConsultantInitial(event: EventWithType): string {
  const name = getConsultantName(event);
  return name.charAt(0) || "?";
}

export function formatDate(date: Date | null | undefined): string {
  if (!date) return "Date not set";
  return new Date(date).toLocaleDateString();
}

export function isEventJoinable(event: EventWithType): boolean {
  const slotTime = getNextSlotTime(event);
  const now = new Date();
  const diffInMinutes = Math.floor(
    (slotTime.getTime() - now.getTime()) / 60000,
  );
  return diffInMinutes <= 10 && diffInMinutes > -30;
}

export function getEventEndDate(event: EventWithType): Date | null {
  switch (event.type) {
    case "Subscription":
      return event.endDate;
    case "Class":
      return event.endDate;
    default:
      return null;
  }
}

export function isRecurringEvent(event: EventWithType): boolean {
  return event.type === "Subscription" || event.type === "Class";
}

export function getUpcomingSlots(events: EventWithType[]): EventWithType[] {
  const now = new Date();
  const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  return events.filter((event) => {
    const slotTime = getNextSlotTime(event);
    return slotTime > now && slotTime <= in24Hours;
  });
}

export function getRecurringEvents(events: EventWithType[]): EventWithType[] {
  return events.filter(isRecurringEvent);
}

export function sortEventsByNextSlot(events: EventWithType[]): EventWithType[] {
  return [...events].sort((a, b) => {
    const timeA = getNextSlotTime(a);
    const timeB = getNextSlotTime(b);
    return timeA.getTime() - timeB.getTime();
  });
}
