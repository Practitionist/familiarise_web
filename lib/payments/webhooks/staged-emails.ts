/**
 * Webhook Email Staging & Appointment Notification Context Helpers
 *
 * Isolates Phase 1 transactional email outbox staging (`PAYMENT_SUCCESS`,
 * `APPOINTMENT_BOOKED`, `PAYMENT_FAILED`) and shared appointment notification
 * context resolution so `handlers.ts` stays focused on state-machine transitions.
 */

import { AppointmentsType, type Prisma } from "@prisma/client";
import { z } from "zod";
import prisma, { type Tx } from "@/lib/prisma";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";
import { goHref } from "@/lib/dashboard/go";
import {
  renderPaymentFailedEmail,
  renderPaymentSuccessEmail,
  stage as stageEmail,
  stageAppointmentBookedEmail,
  type RenderedEmail,
  type StagedEmail,
  type StagedRecipientEmail,
} from "@/lib/email";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import { notificationHref } from "@/lib/novu/resolve-href";
import { reportSentryError } from "@/lib/observability/report";
import { getAppUrl } from "@/lib/url";

export type MoneyAsNumber<T> = T extends bigint
  ? number
  : T extends Prisma.Decimal
    ? number
    : T extends Date | Uint8Array
      ? T
      : T extends Array<infer U>
        ? Array<MoneyAsNumber<U>>
        : T extends object
          ? { [K in keyof T]: MoneyAsNumber<T[K]> }
          : T;

export type PaymentWithUser = MoneyAsNumber<
  Prisma.PaymentGetPayload<{
    include: {
      user: {
        include: { consulteeProfile: true };
      };
    };
  }>
>;

export type StagedOutboxEmail = {
  staged: StagedEmail;
  message: RenderedEmail;
};

/**
 * Loads the appointment with plan, consultant user, organization name, and
 * earliest live occurrence inside Phase 1 so both staged emails and Phase 2
 * Novu notifications share a single query.
 */
export async function loadAppointmentForEmails(tx: Tx, appointmentId: string) {
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      organization: { select: { name: true } },
      occurrences: {
        where: liveOccurrenceWhere,
        orderBy: { startsAt: "asc" },
        take: 1,
        select: { startsAt: true },
      },
      consultation: {
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      },
      subscription: {
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      },
      webinar: {
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true, name: true } } },
              },
              collaborators: {
                where: {
                  status: "ACCEPTED",
                  tier: "PRESENTER",
                  consultantProfile: { deletedAt: null },
                },
                select: {
                  consultantProfile: {
                    select: { user: { select: { id: true } } },
                  },
                },
              },
            },
          },
        },
      },
      class: {
        include: {
          classPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true, name: true } } },
              },
              collaborators: {
                where: {
                  status: "ACCEPTED",
                  tier: "PRESENTER",
                  consultantProfile: { deletedAt: null },
                },
                select: {
                  consultantProfile: {
                    select: { user: { select: { id: true } } },
                  },
                },
              },
            },
          },
        },
      },
      trial: {
        select: {
          id: true,
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true, name: true } } },
              },
            },
          },
        },
      },
    },
  });

  if (!appointment) {
    reportSentryError(
      new Error(
        `Cannot send payment success email: appointment ${appointmentId} not found`,
      ),
      { subsystem: "payments", level: "warning" },
    );
    console.error(
      `Cannot send payment success email: appointment ${appointmentId} not found`,
    );
  }
  return appointment;
}

export type AppointmentForEmails = NonNullable<
  Awaited<ReturnType<typeof loadAppointmentForEmails>>
>;

export function planForEmails(appointment: AppointmentForEmails) {
  return (
    appointment.consultation?.consultationPlan ??
    appointment.subscription?.subscriptionPlan ??
    appointment.webinar?.webinarPlan ??
    appointment.class?.classPlan ??
    appointment.trial?.subscriptionPlan ??
    null
  );
}

const PLAN_NOTIF_SELECT = {
  select: {
    id: true,
    title: true,
    consultantProfile: {
      select: { user: { select: { id: true, name: true } } },
    },
  },
} as const;

/**
 * Reuses the appointment context already loaded in Phase 1 when its nested plan
 * relation is populated, falling back to a narrow Phase 2 read only when absent.
 */
export async function resolveAppointmentNotificationContext(
  appointmentId: string,
  appointmentFromPhase1: AppointmentForEmails | null | undefined,
) {
  if (appointmentFromPhase1 && planForEmails(appointmentFromPhase1)) {
    return appointmentFromPhase1;
  }
  return prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      organizationId: true,
      organization: { select: { name: true } },
      consultation: { select: { consultationPlan: PLAN_NOTIF_SELECT } },
      subscription: { select: { subscriptionPlan: PLAN_NOTIF_SELECT } },
      webinar: { select: { webinarPlan: PLAN_NOTIF_SELECT } },
      class: { select: { classPlan: PLAN_NOTIF_SELECT } },
      trial: { select: { subscriptionPlan: PLAN_NOTIF_SELECT } },
    },
  });
}

const emailAppointmentTypeSchema = z
  .enum(["consultation", "subscription", "webinar", "class"])
  .catch("consultation");

export async function stagePaymentSuccessEmail(
  tx: Tx,
  payment: PaymentWithUser,
  appointment: AppointmentForEmails,
  appointmentType: string,
): Promise<StagedOutboxEmail | null> {
  const consultantName =
    planForEmails(appointment)?.consultantProfile?.user?.name || "Consultant";
  const amount = payment.amount;
  const currency = payment.currency;

  let message: RenderedEmail;
  try {
    message = await renderPaymentSuccessEmail({
      email: payment.user.email || "",
      name: payment.user.name || "User",
      consultantName,
      appointmentType: emailAppointmentTypeSchema.parse(
        appointmentType.toLowerCase(),
      ),
      amount,
      currency,
      dashboardUrl: `${getAppUrl()}${goHref("client", "appointments")}`,
      paymentReference: payment.id,
    });
  } catch (error) {
    reportSentryError(error, { subsystem: "payments", level: "warning" });
    console.error("Failed to render payment success email:", error);
    return null;
  }

  const staged = await stageEmail(message, "PAYMENT_SUCCESS", {
    tx,
    entityRef: `payment:${payment.id}`,
  });
  return staged ? { staged, message } : null;
}

export async function stageBookedEmails(
  tx: Tx,
  payment: PaymentWithUser,
  appointment: AppointmentForEmails,
  appointmentType: string,
): Promise<StagedRecipientEmail[]> {
  const startsAt = appointment.occurrences?.[0]?.startsAt;
  if (!startsAt) return [];
  const plan = planForEmails(appointment);
  const planTitle =
    appointmentType === AppointmentsType.TRIAL
      ? "Trial session"
      : planTitleOrSessionLabel(plan?.title ?? null, appointmentType);
  const collaborators =
    appointment.webinar?.webinarPlan?.collaborators ??
    appointment.class?.classPlan?.collaborators ??
    [];
  const collaboratorUserIds = collaborators
    .map((c) => c.consultantProfile.user.id)
    .filter((id): id is string => Boolean(id));
  return stageAppointmentBookedEmail(tx, {
    appointmentId: appointment.id,
    consulteeUserId: payment.userId,
    consultantUserId: plan?.consultantProfile?.user?.id ?? null,
    collaboratorUserIds,
    consulteeName: payment.user.name || "User",
    consultantName: plan?.consultantProfile?.user?.name || "Consultant",
    planTitle,
    appointmentType,
    startsAt,
    dashboardUrl: notificationHref(appointment.organizationId, "appointments"),
  });
}

export async function stagePaymentFailedEmail(
  tx: Tx,
  payment: {
    id: string;
    appointmentId: string | null;
    amount: number;
    currency: string;
    description: string | null;
    user: { email: string | null; name: string | null };
  },
): Promise<StagedOutboxEmail | null> {
  const consultantUserSelect = {
    select: {
      consultantProfile: {
        select: { user: { select: { name: true } } },
      },
    },
  } as const;
  const appointment = await tx.appointment.findUnique({
    where: { id: payment.appointmentId || "" },
    select: {
      consultation: {
        select: { id: true, consultationPlan: consultantUserSelect },
      },
      subscription: {
        select: { id: true, subscriptionPlan: consultantUserSelect },
      },
    },
  });

  if (!appointment) {
    reportSentryError(
      new Error(
        `Cannot send payment failure email: appointment not found for payment ${payment.id}`,
      ),
      { subsystem: "payments", level: "warning" },
    );
    console.error(
      `Cannot send payment failure email: appointment not found for payment ${payment.id}`,
    );
    return null;
  }

  let consultantName = "Consultant";
  let appointmentType: "consultation" | "subscription" = "consultation";
  let retryUrl = `${getAppUrl()}${goHref("client", "payments")}`;

  if (appointment.consultation?.consultationPlan?.consultantProfile?.user) {
    consultantName =
      appointment.consultation.consultationPlan.consultantProfile.user.name ||
      "Consultant";
    appointmentType = "consultation";
    retryUrl = `${getAppUrl()}/checkout/pay/${payment.id}`;
  } else if (
    appointment.subscription?.subscriptionPlan?.consultantProfile?.user
  ) {
    consultantName =
      appointment.subscription.subscriptionPlan.consultantProfile.user.name ||
      "Consultant";
    appointmentType = "subscription";
    retryUrl = `${getAppUrl()}/checkout/pay/${payment.id}`;
  }

  let message: RenderedEmail;
  try {
    message = await renderPaymentFailedEmail({
      email: payment.user.email || "",
      name: payment.user.name || "User",
      consultantName,
      appointmentType,
      amount: payment.amount,
      currency: payment.currency,
      retryUrl,
      failureReason: payment.description || "Payment could not be processed",
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
  } catch (error) {
    reportSentryError(error, { subsystem: "payments", level: "warning" });
    console.error("Failed to render payment failure email:", error);
    return null;
  }

  const staged = await stageEmail(message, "PAYMENT_FAILED", {
    tx,
    entityRef: `payment:${payment.id}`,
  });
  return staged ? { staged, message } : null;
}
