import prisma from "../../../lib/prisma";
import {
  AppointmentsType,
  PaymentStatus,
  Prisma,
  RequestStatus,
} from "@prisma/client";
import crypto from "crypto";
import { stripeClient } from "../../../lib/payment";
import Stripe from "stripe";

// Generic webhook verification
export async function verifyWebhookSignature(
  req: Request,
  secret: string,
  gateway: "stripe" | "razorpay",
): Promise<{ isValid: boolean; body: string }> {
  const signature =
    req.headers.get("stripe-signature") ||
    req.headers.get("x-razorpay-signature");

  if (!signature) {
    return { isValid: false, body: "" };
  }

  const body = await req.text();

  try {
    if (gateway === "stripe") {
      stripeClient.webhooks.constructEvent(body, signature, secret);
      return { isValid: true, body };
    } else {
      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");
      return { isValid: signature === expectedSignature, body };
    }
  } catch (error) {
    console.error(`Webhook signature verification failed for ${gateway}:`, error);
    return { isValid: false, body };
  }
}

// Shared payment success handler
export async function handlePaymentSuccess(
  paymentIntentId: string,
  metadata: Record<string, string>,
) {
  return await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: { user: { include: { consulteeProfile: true } } },
    });

    if (!payment) {
      throw new Error(`Payment record not found for intent: ${paymentIntentId}`);
    }

    if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
      console.log(
        `Payment ${paymentIntentId} has already been processed.`,
      );
      return;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.SUCCEEDED },
    });

    let appointment;
    if (payment.appointmentId) {
      appointment = await tx.appointment.findUnique({
        where: { id: payment.appointmentId },
      });
    } else {
      appointment = await createAppointmentFromWebhook(tx, metadata, payment);
    }

    if (!appointment) {
      throw new Error("Failed to create or find appointment");
    }

    await confirmExistingAppointment(tx, appointment.id);

    console.log(
      `✅ Payment ${paymentIntentId} processed successfully. Appointment ID: ${appointment.id}`,
    );
  });
}

// Shared payment failure handler
export async function handlePaymentFailure(paymentIntentId: string) {
  return await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: { appointment: true },
    });

    if (!payment) {
      console.warn(`Payment record not found for failed intent: ${paymentIntentId}`);
      return;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.FAILED },
    });

    if (payment.appointment) {
      await cleanupFailedPaymentAppointment(tx, payment.appointment.id);
    }
  });
}

// Appointment creation logic
async function createAppointmentFromWebhook(
  tx: Prisma.TransactionClient,
  metadata: Record<string, string>,
  payment: any,
) {
  const {
    appointmentType,
    planId,
    eventId,
    slotStartTimeInUTC,
    slotEndTimeInUTC,
    notes,
  } = metadata;

  if (!payment.user.consulteeProfile) {
    throw new Error("User profile not found for payment");
  }

  const consulteeProfileId = payment.user.consulteeProfile.id;
  const userId = payment.user.id;

  let appointment;

  switch (appointmentType) {
    case AppointmentsType.CONSULTATION:
      appointment = await createConsultation(tx, {
        planId,
        slotStartTimeInUTC,
        slotEndTimeInUTC,
        notes,
        consulteeProfileId,
      });
      break;
    case AppointmentsType.SUBSCRIPTION:
      appointment = await createSubscription(tx, {
        planId,
        slotStartTimeInUTC,
        slotEndTimeInUTC,
        notes,
        consulteeProfileId,
      });
      break;
    case AppointmentsType.WEBINAR:
      appointment = await createWebinar(tx, { eventId, userId });
      break;
    case AppointmentsType.CLASS:
      appointment = await createClass(tx, { eventId, userId });
      break;
    default:
      throw new Error(`Unsupported appointment type: ${appointmentType}`);
  }

  await tx.payment.update({
    where: { id: payment.id },
    data: { appointmentId: appointment.id },
  });

  return appointment;
}

// Specific appointment creation functions
async function createConsultation(tx: Prisma.TransactionClient, data: any) {
  const consultation = await tx.consultation.create({
    data: {
      consultationPlanId: data.planId,
      requestStatus: RequestStatus.PENDING,
      requestedById: data.consulteeProfileId,
      requestNotes: data.notes,
      directlyBooked: true,
    },
  });

  return await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: new Date(data.slotStartTimeInUTC),
          slotEndTimeInUTC: new Date(data.slotEndTimeInUTC),
          isTentative: false,
        },
      },
    },
    include: {
      slotsOfAppointment: true,
    },
  });
}

async function createSubscription(tx: Prisma.TransactionClient, data: any) {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
  });
  if (!plan) throw new Error("Subscription plan not found");

  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + plan.durationInMonths);

  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId: data.planId,
      requestStatus: RequestStatus.PENDING,
      requestedById: data.consulteeProfileId,
      requestNotes: data.notes,
      startDate,
      endDate,
    },
  });

  return await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscriptionId: subscription.id,
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: new Date(data.slotStartTimeInUTC),
          slotEndTimeInUTC: new Date(data.slotEndTimeInUTC),
          isTentative: false,
        },
      },
    },
    include: {
      slotsOfAppointment: true,
    },
  });
}

async function createWebinar(tx: Prisma.TransactionClient, data: any) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: { appointment: { include: { slotsOfAppointment: true } } },
  });
  if (!webinar) throw new Error("Webinar not found");

  let appointment = webinar.appointment;
  if (!appointment) {
    appointment = await tx.appointment.create({
      data: {
        appointmentType: AppointmentsType.WEBINAR,
        webinarId: webinar.id,
      },
      include: {
        slotsOfAppointment: true,
      },
    });
  }

  await tx.slotOfAppointment.create({
    data: {
      appointmentId: appointment.id,
      slotStartTimeInUTC:
        webinar.appointment?.slotsOfAppointment[0]?.slotStartTimeInUTC ||
        new Date(),
      slotEndTimeInUTC:
        webinar.appointment?.slotsOfAppointment[0]?.slotEndTimeInUTC ||
        new Date(),
      isTentative: false,
      user: { connect: { id: data.userId } },
    },
  });

  const createdAppointment = await tx.appointment.findUnique({
    where: { id: appointment.id },
    include: { slotsOfAppointment: true },
  });
  if (!createdAppointment) {
    throw new Error("Failed to fetch created appointment");
  }
  return createdAppointment;
}

async function createClass(tx: Prisma.TransactionClient, data: any) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: { classPlan: true },
  });
  if (!classInstance) throw new Error("Class not found");

  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CLASS,
      classId: classInstance.id,
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: classInstance.startDate || new Date(),
          slotEndTimeInUTC: classInstance.endDate || new Date(),
          isTentative: false,
          user: { connect: { id: data.userId } },
        },
      },
    },
  });

  const createdAppointment = await tx.appointment.findUnique({
    where: { id: appointment.id },
    include: { slotsOfAppointment: true },
  });
  if (!createdAppointment) {
    throw new Error("Failed to fetch created appointment");
  }
  return createdAppointment;
}

// Appointment confirmation
async function confirmExistingAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
) {
  await tx.slotOfAppointment.updateMany({
    where: { appointmentId },
    data: { isTentative: false },
  });

  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
    },
  });

  if (appointment?.consultation) {
    await tx.consultation.update({
      where: { id: appointment.consultation.id },
      data: { requestStatus: RequestStatus.APPROVED },
    });
  }
  if (appointment?.subscription) {
    await tx.subscription.update({
      where: { id: appointment.subscription.id },
      data: { requestStatus: RequestStatus.APPROVED },
    });
  }
  if (appointment?.webinar) {
    await tx.webinar.update({
      where: { id: appointment.webinar.id },
      data: { status: "SCHEDULED" },
    });
  }
  if (appointment?.class) {
    await tx.class.update({
      where: { id: appointment.class.id },
      data: { status: "SCHEDULED" },
    });
  }
}

// Cleanup for failed payments
async function cleanupFailedPaymentAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
) {
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      slotsOfAppointment: true,
      consultation: true,
      subscription: true,
    },
  });

  if (!appointment) return;

  const tentativeSlots = appointment.slotsOfAppointment.filter(
    (slot) => slot.isTentative,
  );

  if (tentativeSlots.length > 0) {
    await tx.slotOfAppointment.deleteMany({
      where: { appointmentId, isTentative: true },
    });

    if (appointment.consultation || appointment.subscription) {
      const remainingSlots = await tx.slotOfAppointment.count({
        where: { appointmentId },
      });
      if (remainingSlots === 0) {
        if (appointment.consultation) {
          await tx.consultation.delete({
            where: { id: appointment.consultation.id },
          });
        }
        if (appointment.subscription) {
          await tx.subscription.delete({
            where: { id: appointment.subscription.id },
          });
        }
        await tx.appointment.delete({ where: { id: appointmentId } });
      }
    }
  }
}
