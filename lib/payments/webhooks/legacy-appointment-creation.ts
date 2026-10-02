/**
 * Legacy Webhook Appointment Creation
 *
 * Isolates the backwards-compatibility path where a payment capture arrives
 * with `payment.appointmentId === null` (or is driven through the admin
 * recovery endpoint) and must construct the appointment from webhook metadata.
 */

import {
  AppointmentStatus,
  AppointmentsType,
  PaymentStatus,
} from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { buildOccurrenceForWindow } from "@/lib/appointments/occurrences";
import { firstCycleWindow } from "@/lib/booking/entitlement";
import { recordParticipants } from "@/lib/booking/participants";
import { appendCreationHistory } from "@/lib/booking/transitions";
import {
  isOrgFundedPaymentMethod,
  seatPayerOrganizationId,
} from "@/lib/data/org-sponsored-seats";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import type { PaymentWithUser } from "./staged-emails";

export interface ConsultationData {
  planId: string;
  startsAt: string;
  endsAt: string;
  notes?: string;
  consulteeProfileId: string;
  userId: string;
}

export interface SubscriptionData {
  planId: string;
  startsAt?: string;
  endsAt?: string;
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  notes?: string;
  consulteeProfileId: string;
  userId: string;
}

export interface EventData {
  eventId: string;
  userId: string;
  organizationId: string | null;
}

/**
 * Thrown when a recovery's CAS link write matches zero rows because another
 * writer linked the appointment first.
 */
export class RecoveryAlreadyDoneError extends Error {
  readonly code = "ALREADY_RECOVERED" as const;
  readonly httpStatus = 409 as const;
  constructor(paymentId: string) {
    super(`Payment ${paymentId} already has an appointment linked`);
    this.name = "RecoveryAlreadyDoneError";
  }
}

export async function createAppointmentFromWebhook(
  tx: Tx,
  metadata: Record<string, string>,
  payment: PaymentWithUser,
) {
  const {
    appointmentType,
    planId,
    eventId,
    startsAt,
    endsAt,
    schedulingPeriodStartsAt,
    schedulingPeriodEndsAt,
    notes,
  } = metadata;

  if (!payment.user.consulteeProfile) {
    throw new Error("User profile not found for payment");
  }

  const consulteeProfileId = payment.user.consulteeProfile.id;
  const userId = payment.user.id;

  let appointment;
  const seatOrg = seatPayerOrganizationId(
    payment.organizationId,
    isOrgFundedPaymentMethod(payment.paymentMethod),
  );

  switch (appointmentType) {
    case AppointmentsType.CONSULTATION:
      appointment = await createConsultation(tx, {
        planId,
        startsAt,
        endsAt,
        notes,
        consulteeProfileId,
        userId,
      });
      break;
    case AppointmentsType.SUBSCRIPTION:
      console.warn(
        JSON.stringify({
          event: "legacy_subscription_creation",
          warning:
            "Creating subscription via webhook - expected only for old payments",
          paymentId: payment.id,
          planId,
          timestamp: new Date().toISOString(),
        }),
      );
      appointment = await createSubscription(tx, {
        planId,
        startsAt,
        endsAt,
        schedulingPeriodStartsAt,
        schedulingPeriodEndsAt,
        notes,
        consulteeProfileId,
        userId,
      });
      break;
    case AppointmentsType.WEBINAR:
      appointment = await createWebinar(tx, {
        eventId,
        userId,
        organizationId: seatOrg,
      });
      break;
    case AppointmentsType.CLASS:
      appointment = await createClass(tx, {
        eventId,
        userId,
        organizationId: seatOrg,
      });
      break;
    default:
      throw new Error(`Unsupported appointment type: ${appointmentType}`);
  }

  const linked = await tx.payment.updateMany({
    where: {
      id: payment.id,
      paymentStatus: PaymentStatus.SUCCEEDED,
      appointmentId: null,
    },
    data: { appointmentId: appointment.id },
  });
  if (linked.count === 0) throw new RecoveryAlreadyDoneError(payment.id);

  return appointment;
}

async function createConsultation(tx: Tx, data: ConsultationData) {
  const consultation = await tx.consultation.create({
    data: {
      consultationPlanId: data.planId,
      status: AppointmentStatus.PENDING,
      requestedById: data.consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
    },
    include: {
      consultationPlan: {
        select: {
          consultantProfileId: true,
          consultantProfile: { select: { userId: true } },
        },
      },
    },
  });

  const consultantUserId =
    consultation.consultationPlan.consultantProfile?.userId;
  if (!consultantUserId) {
    throw new Error(
      "Consultation plan has no consultant user; cannot create booking",
    );
  }

  const occurrence = buildOccurrenceForWindow({
    startsAt: new Date(data.startsAt),
    endsAt: new Date(data.endsAt),
    consultantProfileId: consultation.consultationPlan.consultantProfileId,
    isTentative: false,
  });

  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      occurrences: { create: occurrence },
      participants: {
        create: [
          { userId: consultantUserId, role: "CONSULTANT", status: "CONFIRMED" },
          { userId: data.userId, role: "CONSULTEE", status: "CONFIRMED" },
        ],
      },
    },
    include: {
      occurrences: true,
    },
  });

  await appendCreationHistory(
    tx,
    "CONSULTATION",
    consultation.id,
    consultation.status,
    {
      appointmentId: appointment.id,
    },
  );

  return appointment;
}

async function createSubscription(tx: Tx, data: SubscriptionData) {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: { select: { user: { select: { timezone: true } } } },
    },
  });
  if (!plan) throw new Error("Subscription plan not found");

  const schedulingTimezone = resolveSchedulingTimezone(
    plan.consultantProfile?.user?.timezone,
  );
  const { start: startDate, end: endDate } = firstCycleWindow(
    plan,
    data.schedulingPeriodStartsAt
      ? new Date(data.schedulingPeriodStartsAt)
      : new Date(),
    schedulingTimezone,
  );

  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId: data.planId,
      status: AppointmentStatus.PENDING,
      requestedById: data.consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
      schedulingPeriodStartsAt: startDate,
      schedulingPeriodEndsAt: endDate,
      schedulingTimezone,
      sessionsTotal: plan.totalSessions,
    },
  });

  const wrapper = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscriptionId: subscription.id,
    },
    include: {
      occurrences: true,
    },
  });

  await appendCreationHistory(
    tx,
    "SUBSCRIPTION",
    subscription.id,
    subscription.status,
    {
      appointmentId: wrapper.id,
    },
  );

  return wrapper;
}

async function createWebinar(tx: Tx, data: EventData) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: { appointment: { include: { occurrences: true } } },
  });
  if (!webinar) throw new Error("Webinar not found");

  const masterSlot = webinar.appointment?.occurrences?.[0];
  if (!webinar.appointment || !masterSlot) {
    throw new Error("Webinar has not been scheduled. Cannot create booking.");
  }

  // Birth seat HELD so confirmExistingAppointment's liveness CAS governs promotion to CONFIRMED.
  await recordParticipants(
    tx,
    webinar.appointment.id,
    [{ userId: data.userId, role: "CONSULTEE" }],
    { status: "HELD", organizationId: data.organizationId },
  );

  const createdAppointment = await tx.appointment.findUnique({
    where: { id: webinar.appointment.id },
    include: { occurrences: true },
  });
  if (!createdAppointment) {
    throw new Error("Failed to fetch created appointment");
  }
  return createdAppointment;
}

async function createClass(tx: Tx, data: EventData) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: {
      appointment: {
        include: { occurrences: { select: { id: true } } },
      },
    },
  });
  if (!classInstance) throw new Error("Class not found");

  const wrapper = classInstance.appointment;
  if (!wrapper || wrapper.occurrences.length === 0) {
    throw new Error("Class has not been scheduled. Cannot create booking.");
  }

  // Birth seat HELD so confirmExistingAppointment's liveness CAS governs promotion to CONFIRMED.
  await recordParticipants(
    tx,
    wrapper.id,
    [{ userId: data.userId, role: "CONSULTEE" }],
    { status: "HELD", organizationId: data.organizationId },
  );

  const createdAppointment = await tx.appointment.findUnique({
    where: { id: wrapper.id },
    include: { occurrences: true },
  });
  if (!createdAppointment) {
    throw new Error("Failed to fetch created appointment");
  }
  return createdAppointment;
}
