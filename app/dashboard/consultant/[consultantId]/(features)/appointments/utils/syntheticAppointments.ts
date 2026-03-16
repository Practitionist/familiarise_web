/**
 * Builders for synthetic TAppointment objects used to open EventTimingsCalendar
 * for events that exist in the DB but have no Appointment records yet.
 *
 * Uses `as unknown as TAppointment` because EventTimingsCalendar only accesses
 * a subset of fields — the event id, plan metadata, and scheduling period bounds.
 */

import { TAppointment } from "@/types/appointment";
import { UnscheduledClass, UnscheduledWebinar } from "../../../types";

export function buildSyntheticClassAppointment(
  classEvent: UnscheduledClass,
): TAppointment {
  return {
    id: `synthetic-class-${classEvent.id}`,
    appointmentType: "CLASS",
    classId: classEvent.id,
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
      classPlanId: classEvent.classPlan.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    slotsOfAppointment: [],
    consultation: null,
    consultationId: null,
    subscription: null,
    subscriptionId: null,
    webinar: null,
    webinarId: null,
    payment: null,
    paymentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as TAppointment;
}

export function buildSyntheticWebinarAppointment(
  webinarEvent: UnscheduledWebinar,
): TAppointment {
  return {
    id: `synthetic-webinar-${webinarEvent.id}`,
    appointmentType: "WEBINAR",
    webinarId: webinarEvent.id,
    webinar: {
      id: webinarEvent.id,
      status: webinarEvent.status,
      webinarPlan: webinarEvent.webinarPlan,
      webinarPlanId: webinarEvent.webinarPlan.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    slotsOfAppointment: [],
    consultation: null,
    consultationId: null,
    subscription: null,
    subscriptionId: null,
    class: null,
    classId: null,
    payment: null,
    paymentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as TAppointment;
}
