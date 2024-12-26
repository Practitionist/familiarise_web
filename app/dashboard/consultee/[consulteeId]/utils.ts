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

interface SlotInfo {
  startTime: string;
  endTime: string;
  timezone: string;
}

export function getAllSlots(event: EventWithType): Date[] {
  switch (event.type) {
    case "Consultation":
      return event.preferredDateTime ? [new Date(event.preferredDateTime)] : [];
    case "Subscription":
      try {
        const schedule: SlotInfo[] = event.tentativeSchedule
          ? JSON.parse(event.tentativeSchedule)
          : [];
        return schedule.map((slot) => new Date(slot.startTime));
      } catch (e) {
        console.error("Error parsing subscription schedule:", e);
        return [];
      }
    case "Class":
      try {
        const schedule: SlotInfo[] = event.tentativeSchedule
          ? JSON.parse(event.tentativeSchedule)
          : [];
        return schedule.map((slot) => new Date(slot.startTime));
      } catch (e) {
        console.error("Error parsing class schedule:", e);
        return [];
      }
    case "Webinar":
      return event.scheduledAt ? [new Date(event.scheduledAt)] : [];
    default:
      return [];
  }
}

export function getNextSlotTime(event: EventWithType): Date {
  const now = Date.now();
  const slots = getAllSlots(event);
  const futureSlots = slots.filter((slot) => slot.getTime() > now);
  return futureSlots.length > 0 ? futureSlots[0] : new Date(now);
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

export function getUpcomingSlots(
  events: EventWithType[],
): Array<{ event: EventWithType; slotTime: Date }> {
  const now = new Date();
  const allSlots = events.flatMap((event) =>
    getAllSlots(event).map((slotTime) => ({
      event,
      slotTime,
    })),
  );

  return allSlots
    .filter(({ slotTime }) => slotTime > now)
    .sort((a, b) => a.slotTime.getTime() - b.slotTime.getTime());
}

export function getMonthlyEvents(
  events: EventWithType[],
  month: Date,
): Array<{ event: EventWithType; slots: Date[] }> {
  const startOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const endOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0);

  return events
    .map((event) => ({
      event,
      slots: getAllSlots(event).filter(
        (slot) => slot >= startOfMonth && slot <= endOfMonth,
      ),
    }))
    .filter(({ slots }) => slots.length > 0);
}

export function getRecurringEvents(events: EventWithType[]): EventWithType[] {
  return events.filter(isRecurringEvent);
}

export function getEventStatus(event: EventWithType): string {
  switch (event.type) {
    case "Consultation":
      return event.requestStatus;
    case "Subscription":
      return event.requestStatus;
    case "Webinar":
      return event.status;
    case "Class":
      return event.status;
  }
}

export function getStatusColor(status: string): string {
  const statusLower = status.toLowerCase();
  if (statusLower === "completed") return "bg-green-50 text-green-700";
  if (statusLower === "rejected") return "bg-red-50 text-red-700";
  if (statusLower === "pending") return "bg-yellow-50 text-yellow-700";
  return "bg-gray-50 text-gray-700";
}

export function sortEventsByNextSlot(events: EventWithType[]): EventWithType[] {
  return [...events].sort((a, b) => {
    const timeA = getNextSlotTime(a);
    const timeB = getNextSlotTime(b);
    return timeA.getTime() - timeB.getTime();
  });
}
