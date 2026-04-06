/**
 * Builders for partial appointment objects used to open EventTimingsCalendar
 * for events that exist in the DB but have no Appointment rows yet.
 *
 * Returns Partial<TAppointment> with the required id + appointmentType fields.
 * EventTimingsCalendar accesses all fields via optional chaining, so partial
 * data is safe.
 */

import type { TAppointment } from "@/types/appointment";
import { UnscheduledClass, UnscheduledWebinar } from "../../../types";

/** Minimum required fields for EventTimingsCalendar */
export type UnscheduledAppointment = Partial<TAppointment> &
  Pick<TAppointment, "id" | "appointmentType">;

export function buildUnscheduledClassAppointment(
  classEvent: UnscheduledClass,
): UnscheduledAppointment {
  return {
    id: `unscheduled-class-${classEvent.id}`,
    appointmentType: "CLASS",
    class: {
      id: classEvent.id,
      status: classEvent.status,
      schedulingPeriodStartsAt: classEvent.schedulingPeriodStartsAt
        ? new Date(classEvent.schedulingPeriodStartsAt)
        : null,
      schedulingPeriodEndsAt: classEvent.schedulingPeriodEndsAt
        ? new Date(classEvent.schedulingPeriodEndsAt)
        : null,
      classPlan: classEvent.classPlan,
    } as TAppointment["class"],
    slotsOfAppointment: [],
  };
}

export function buildUnscheduledWebinarAppointment(
  webinarEvent: UnscheduledWebinar,
): UnscheduledAppointment {
  return {
    id: `unscheduled-webinar-${webinarEvent.id}`,
    appointmentType: "WEBINAR",
    webinar: {
      id: webinarEvent.id,
      status: webinarEvent.status,
      webinarPlan: webinarEvent.webinarPlan,
    } as TAppointment["webinar"],
    slotsOfAppointment: [],
  };
}
