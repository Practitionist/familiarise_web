/**
 * Builders for synthetic appointment objects used to open EventTimingsCalendar
 * for events that exist in the DB but have no Appointment records yet.
 *
 * Returns a SyntheticAppointment — a lightweight type containing only the
 * fields that EventTimingsCalendar actually reads (event id, plan metadata,
 * scheduling period bounds).
 */

import type { AppointmentsType } from "@prisma/client";
import { UnscheduledClass, UnscheduledWebinar } from "../../../types";

/**
 * Lightweight appointment-like object for events without real Appointment rows.
 * Contains only the subset of fields that EventTimingsCalendar needs.
 */
export interface SyntheticAppointment {
  id: string;
  appointmentType: AppointmentsType;
  slotsOfAppointment: [];
  consultation: null;
  consultationId: null;
  subscription: null;
  subscriptionId: null;
  payment: null;
  paymentId: null;
  createdAt: Date;
  updatedAt: Date;
  webinar: {
    id: string;
    status: string;
    webinarPlan: UnscheduledWebinar["webinarPlan"];
    webinarPlanId: string;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  webinarId: string | null;
  class: {
    id: string;
    status: string;
    schedulingPeriodStartsAt: Date | null;
    schedulingPeriodEndsAt: Date | null;
    classPlan: UnscheduledClass["classPlan"];
    classPlanId: string;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  classId: string | null;
}

export function buildSyntheticClassAppointment(
  classEvent: UnscheduledClass,
): SyntheticAppointment {
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
  };
}

export function buildSyntheticWebinarAppointment(
  webinarEvent: UnscheduledWebinar,
): SyntheticAppointment {
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
  };
}
