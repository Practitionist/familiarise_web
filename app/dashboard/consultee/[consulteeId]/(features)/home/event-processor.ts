/**
 * Event Processing Utilities for Consultee Home Dashboard
 *
 * Provides type-safe processing of consultee events (consultations, subscriptions,
 * webinars, classes) into a unified ProcessedEvent format for display.
 */

import type {
  TConsulteeConsultation,
  TConsulteeSubscription,
  TConsulteeWebinar,
  TConsulteeClass,
  TConsulteeEventsResponse,
} from "@/types/consultee-events";
import type { MeetingAppointment, MeetingSlot } from "@/lib/meeting";

/**
 * Unified event type for display in the dashboard
 */
export interface ProcessedEvent {
  id: string;
  type: "consultation" | "subscription" | "class" | "webinar";
  title: string;
  consultantName: string;
  consultantImage?: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
  slots: Array<{ startsAt: Date; endsAt: Date }>;
  appointmentId?: string;
  // Data needed for joining meetings
  joinableAppointment?: MeetingAppointment;
  joinableSlot?: MeetingSlot;
}

/**
 * Internal type for tracking slots with their raw data
 */
interface SlotWithContext {
  startsAt: Date;
  endsAt: Date;
  rawSlot: MeetingSlot;
  appointmentId: string;
}

/**
 * Find the next upcoming slot from a list of slots
 */
function findNextSlot(slots: SlotWithContext[]): SlotWithContext | null {
  if (slots.length === 0) return null;

  const now = new Date();
  const sortedSlots = [...slots].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime()
  );

  // Find first upcoming slot, or fall back to most recent
  return sortedSlots.find((s) => s.startsAt > now) ?? sortedSlots[0];
}

/**
 * Process a consultation into a ProcessedEvent
 */
export function processConsultation(
  consultation: TConsulteeConsultation
): ProcessedEvent | null {
  const slots = consultation.appointment?.slotsOfAppointment;
  if (!slots || slots.length === 0) return null;

  const firstSlot = slots[0];
  const appointmentId = consultation.appointment?.id ?? "";

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: appointmentId,
    appointmentType: "CONSULTATION",
    slotsOfAppointment: slots.map((s) => ({
      id: s.id,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      isTentative: s.isTentative,
      appointmentId: s.appointmentId,
    })),
    consultation: {
      consultationPlan: {
        title: consultation.consultationPlan?.title,
      },
      requestedBy: {
        user: {
          name: consultation.consultationPlan?.consultantProfile?.user?.name,
        },
      },
    },
  };

  // Build meeting slot
  const joinableSlot: MeetingSlot = {
    id: firstSlot.id,
    startsAt: firstSlot.startsAt,
    endsAt: firstSlot.endsAt,
    isTentative: firstSlot.isTentative,
    appointmentId: firstSlot.appointmentId,
  };

  return {
    id: consultation.id,
    type: "consultation",
    title: consultation.consultationPlan?.title ?? "Consultation",
    consultantName:
      consultation.consultationPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage:
      consultation.consultationPlan?.consultantProfile?.user?.image,
    startsAt: new Date(firstSlot.startsAt),
    endsAt: new Date(firstSlot.endsAt),
    status: consultation.requestStatus ?? "PENDING",
    slots: slots.map((s) => ({
      startsAt: new Date(s.startsAt),
      endsAt: new Date(s.endsAt),
    })),
    appointmentId,
    joinableAppointment,
    joinableSlot,
  };
}

/**
 * Process a subscription into a ProcessedEvent
 */
export function processSubscription(
  subscription: TConsulteeSubscription
): ProcessedEvent | null {
  const allSlots: SlotWithContext[] = [];

  subscription.appointments?.forEach((appointment) => {
    appointment.slotsOfAppointment?.forEach((slot) => {
      allSlots.push({
        startsAt: new Date(slot.startsAt),
        endsAt: new Date(slot.endsAt),
        rawSlot: {
          id: slot.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          isTentative: slot.isTentative,
          appointmentId: slot.appointmentId,
        },
        appointmentId: appointment.id,
      });
    });
  });

  if (allSlots.length === 0) return null;

  const nextSlot = findNextSlot(allSlots);
  if (!nextSlot) return null;

  // Find the appointment that contains the next slot
  const nextAppointment = subscription.appointments?.find(
    (a) => a.id === nextSlot.appointmentId
  );

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: nextSlot.appointmentId,
    appointmentType: "SUBSCRIPTION",
    slotsOfAppointment:
      nextAppointment?.slotsOfAppointment?.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        isTentative: s.isTentative,
        appointmentId: s.appointmentId,
      })) ?? [],
    subscription: {
      subscriptionPlan: {
        title: subscription.subscriptionPlan?.title,
      },
      requestedBy: {
        user: {
          name: subscription.subscriptionPlan?.consultantProfile?.user?.name,
        },
      },
    },
  };

  return {
    id: subscription.id,
    type: "subscription",
    title: subscription.subscriptionPlan?.title ?? "Subscription",
    consultantName:
      subscription.subscriptionPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage:
      subscription.subscriptionPlan?.consultantProfile?.user?.image,
    startsAt: nextSlot.startsAt,
    endsAt: nextSlot.endsAt,
    status: subscription.requestStatus ?? "PENDING",
    slots: allSlots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
    appointmentId: nextSlot.appointmentId,
    joinableAppointment,
    joinableSlot: nextSlot.rawSlot,
  };
}

/**
 * Process a webinar into a ProcessedEvent
 */
export function processWebinar(webinar: TConsulteeWebinar): ProcessedEvent | null {
  const allSlots: SlotWithContext[] = [];
  const appointmentId = webinar.appointment?.id ?? "";

  // Get slots from the appointment
  webinar.appointment?.slotsOfAppointment?.forEach((slot) => {
    allSlots.push({
      startsAt: new Date(slot.startsAt),
      endsAt: new Date(slot.endsAt),
      rawSlot: {
        id: slot.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        isTentative: slot.isTentative,
        appointmentId: slot.appointmentId,
      },
      appointmentId,
    });
  });

  if (allSlots.length === 0) return null;

  const nextSlot = findNextSlot(allSlots);
  if (!nextSlot) return null;

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: appointmentId,
    appointmentType: "WEBINAR",
    slotsOfAppointment:
      webinar.appointment?.slotsOfAppointment?.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        isTentative: s.isTentative,
        appointmentId: s.appointmentId,
      })) ?? [],
    webinar: {
      webinarPlan: {
        title: webinar.webinarPlan?.title,
      },
    },
  };

  return {
    id: webinar.id,
    type: "webinar",
    title: webinar.webinarPlan?.title ?? "Webinar",
    consultantName:
      webinar.webinarPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage: webinar.webinarPlan?.consultantProfile?.user?.image,
    startsAt: nextSlot.startsAt,
    endsAt: nextSlot.endsAt,
    status: webinar.status ?? "APPROVED",
    slots: allSlots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
    appointmentId,
    joinableAppointment,
    joinableSlot: nextSlot.rawSlot,
  };
}

/**
 * Process a class into a ProcessedEvent
 */
export function processClass(classEvent: TConsulteeClass): ProcessedEvent | null {
  const allSlots: SlotWithContext[] = [];

  classEvent.appointments?.forEach((appointment) => {
    appointment.slotsOfAppointment?.forEach((slot) => {
      allSlots.push({
        startsAt: new Date(slot.startsAt),
        endsAt: new Date(slot.endsAt),
        rawSlot: {
          id: slot.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          isTentative: slot.isTentative,
          appointmentId: slot.appointmentId,
        },
        appointmentId: appointment.id,
      });
    });
  });

  if (allSlots.length === 0) return null;

  const nextSlot = findNextSlot(allSlots);
  if (!nextSlot) return null;

  // Find the appointment that contains the next slot
  const nextAppointment = classEvent.appointments?.find(
    (a) => a.id === nextSlot.appointmentId
  );

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: nextSlot.appointmentId,
    appointmentType: "CLASS",
    slotsOfAppointment:
      nextAppointment?.slotsOfAppointment?.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        isTentative: s.isTentative,
        appointmentId: s.appointmentId,
      })) ?? [],
    class: {
      classPlan: {
        title: classEvent.classPlan?.title,
      },
    },
  };

  return {
    id: classEvent.id,
    type: "class",
    title: classEvent.classPlan?.title ?? "Class",
    consultantName:
      classEvent.classPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage: classEvent.classPlan?.consultantProfile?.user?.image,
    startsAt: nextSlot.startsAt,
    endsAt: nextSlot.endsAt,
    status: classEvent.status ?? "APPROVED",
    slots: allSlots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
    appointmentId: nextSlot.appointmentId,
    joinableAppointment,
    joinableSlot: nextSlot.rawSlot,
  };
}

/**
 * Process all events from the API response into unified ProcessedEvent array
 */
export function processAllEvents(
  eventsData: TConsulteeEventsResponse
): ProcessedEvent[] {
  const events: ProcessedEvent[] = [];

  // Process consultations
  eventsData.consultations?.forEach((c) => {
    const processed = processConsultation(c);
    if (processed) events.push(processed);
  });

  // Process subscriptions
  eventsData.subscriptions?.forEach((s) => {
    const processed = processSubscription(s);
    if (processed) events.push(processed);
  });

  // Process webinars
  eventsData.webinars?.forEach((w) => {
    const processed = processWebinar(w);
    if (processed) events.push(processed);
  });

  // Process classes
  eventsData.classes?.forEach((c) => {
    const processed = processClass(c);
    if (processed) events.push(processed);
  });

  return events;
}

/**
 * Filter and sort events for upcoming display
 */
export function getUpcomingEvents(events: ProcessedEvent[]): ProcessedEvent[] {
  const now = new Date();
  return events
    .filter((e) => e.startsAt > now || e.slots.some((s) => s.startsAt > now))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Filter events for a specific month
 */
export function getMonthlyEvents(
  events: ProcessedEvent[],
  month: Date
): ProcessedEvent[] {
  return events.filter((e) =>
    e.slots.some(
      (s) =>
        s.startsAt.getMonth() === month.getMonth() &&
        s.startsAt.getFullYear() === month.getFullYear()
    )
  );
}
