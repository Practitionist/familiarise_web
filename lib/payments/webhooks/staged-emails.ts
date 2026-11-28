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
import { nextSessionAhead } from "@/lib/appointments/calendar-links";
import { goHref } from "@/lib/dashboard/go";
import {
  prepareAppointmentBookedEmail,
  renderPaymentFailedEmail,
  renderPaymentSuccessEmail,
  stage as stageEmail,
  stageAppointmentBookedEmail,
  stageRenderFailure,
  type AppointmentBookedEmailArgs,
  type RenderedEmail,
  type StagedEmail,
  type StagedRecipientEmail,
} from "@/lib/email";
import { SENDERS } from "@/lib/email/config";
import type { PreparedSpecEmails } from "@/lib/email/senders/shared";
import {
  notifyAppointmentBooked,
  notifyPaymentSuccess,
  type StagedTrigger,
} from "@/lib/novu";
import {
  failureReasonLabel,
  planTitleOrSessionLabel,
} from "@/lib/novu/humanize";
import { notificationHref } from "@/lib/novu/resolve-href";
import { notificationScope } from "@/lib/novu/workflows";
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
 * live occurrences (earliest first) inside Phase 1 so both staged emails and
 * Phase 2 Novu notifications share a single query.
 */
export async function loadAppointmentForEmails(
  tx: Pick<Tx, "appointment">,
  appointmentId: string,
) {
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      organization: { select: { name: true } },
      occurrences: {
        where: liveOccurrenceWhere,
        orderBy: { startsAt: "asc" },
        select: { startsAt: true, endsAt: true },
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

export async function preparePaymentSuccessEmail(
  payment: PaymentWithUser,
  appointment: AppointmentForEmails,
  appointmentType: string,
): Promise<RenderedEmail | null> {
  const consultantName =
    planForEmails(appointment)?.consultantProfile?.user?.name || "Consultant";

  try {
    return await renderPaymentSuccessEmail({
      email: payment.user.email || "",
      name: payment.user.name || "User",
      consultantName,
      appointmentType: emailAppointmentTypeSchema.parse(
        appointmentType.toLowerCase(),
      ),
      amount: payment.amount,
      currency: payment.currency,
      dashboardUrl: `${getAppUrl()}${goHref("client", "appointments")}`,
      paymentReference: payment.id,
    });
  } catch (error) {
    reportSentryError(error, { subsystem: "payments", level: "warning" });
    console.error("Failed to render payment success email:", error);
    return null;
  }
}

export async function stagePaymentSuccessEmail(
  tx: Tx,
  payment: PaymentWithUser,
  appointment: AppointmentForEmails,
  appointmentType: string,
  preRendered?: RenderedEmail | null,
): Promise<StagedOutboxEmail | null> {
  const message =
    preRendered !== undefined
      ? preRendered
      : await preparePaymentSuccessEmail(payment, appointment, appointmentType);
  const entityRef = `payment:${payment.id}`;
  if (!message) {
    // The receipt is required: its render failure leaves a trace row, never a rollback.
    if (payment.user.email) {
      await stageRenderFailure(
        tx,
        { from: SENDERS.payments, to: payment.user.email },
        "PAYMENT_SUCCESS",
        entityRef,
      );
    }
    return null;
  }

  const staged = await stageEmail(message, "PAYMENT_SUCCESS", {
    tx,
    entityRef,
  });
  return staged ? { staged, message } : null;
}

/** Who booked: the paying user, or a free seat's holder. */
export type Booker = Pick<PaymentWithUser, "userId"> & {
  user: Pick<PaymentWithUser["user"], "name">;
};

function bookedEmailArgs(
  payment: Booker,
  appointment: AppointmentForEmails,
  appointmentType: string,
): AppointmentBookedEmailArgs | null {
  const startsAt = appointment.occurrences?.[0]?.startsAt;
  if (!startsAt) return null;
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
  return {
    appointmentId: appointment.id,
    consulteeUserId: payment.userId,
    consultantUserId: plan?.consultantProfile?.user?.id ?? null,
    collaboratorUserIds,
    consulteeName: payment.user.name || "User",
    consultantName: plan?.consultantProfile?.user?.name || "Consultant",
    planTitle,
    appointmentType,
    startsAt,
    calendarSession: nextSessionAhead(appointment.occurrences),
    dashboardUrl: notificationHref(appointment.organizationId, "appointments"),
  };
}

/** Renders the booked notices before the capture or free-seat commit opens. */
export async function prepareBookedEmails(
  payment: Booker,
  appointment: AppointmentForEmails,
  appointmentType: string,
): Promise<PreparedSpecEmails | null> {
  const args = bookedEmailArgs(payment, appointment, appointmentType);
  return args ? prepareAppointmentBookedEmail(args) : null;
}

/** Stages `pre` when the in-transaction booking still matches it, else renders here. */
export async function stageBookedEmails(
  tx: Tx,
  payment: Booker,
  appointment: AppointmentForEmails,
  appointmentType: string,
  pre?: PreparedSpecEmails | null,
): Promise<StagedRecipientEmail[]> {
  const args = bookedEmailArgs(payment, appointment, appointmentType);
  return args ? stageAppointmentBookedEmail(tx, args, pre) : [];
}

export interface PaymentFailedInput {
  id: string;
  appointmentId: string | null;
  amount: number;
  currency: string;
  user: { email: string | null; name: string | null };
  /** The gateway's reason (a code or its prose), never the plan description. */
  failureReason?: string | null;
}

export async function preparePaymentFailedEmail(
  payment: PaymentFailedInput,
  db: Pick<Tx, "appointment"> = prisma,
): Promise<RenderedEmail | null> {
  const consultantUserSelect = {
    select: {
      consultantProfile: {
        select: { user: { select: { name: true } } },
      },
    },
  } as const;
  const appointment = await db.appointment.findUnique({
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

  try {
    return await renderPaymentFailedEmail({
      email: payment.user.email || "",
      name: payment.user.name || "User",
      consultantName,
      appointmentType,
      amount: payment.amount,
      currency: payment.currency,
      retryUrl,
      failureReason: sentence(failureReasonLabel(payment.failureReason)),
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
  } catch (error) {
    reportSentryError(error, { subsystem: "payments", level: "warning" });
    console.error("Failed to render payment failure email:", error);
    return null;
  }
}

function sentence(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

export async function stagePaymentFailedEmail(
  tx: Tx,
  payment: PaymentFailedInput,
  preRendered?: RenderedEmail | null,
): Promise<StagedOutboxEmail | null> {
  const message =
    preRendered !== undefined
      ? preRendered
      : await preparePaymentFailedEmail(payment, tx);
  if (!message) return null;

  const staged = await stageEmail(message, "PAYMENT_FAILED", {
    tx,
    entityRef: `payment:${payment.id}`,
  });
  return staged ? { staged, message } : null;
}

export async function stagePaymentSuccessBells(
  tx: Tx,
  payment: PaymentWithUser,
  appointment: AppointmentForEmails,
  appointmentType: string,
): Promise<StagedTrigger[]> {
  const plan = planForEmails(appointment);
  const consultantName = plan?.consultantProfile?.user?.name || "Consultant";
  const resolvedPlanTitle =
    appointmentType === AppointmentsType.TRIAL
      ? "Trial session"
      : planTitleOrSessionLabel(plan?.title ?? null, appointmentType);

  const orgId = appointment.organizationId ?? null;
  const scope = notificationScope(orgId, appointment.organization?.name);
  const dashboardUrl = notificationHref(orgId, "appointments");

  const staged: StagedTrigger[] = [];

  const paymentTrigger = await notifyPaymentSuccess(
    payment.userId,
    {
      ...scope,
      amount: payment.amount,
      currency: payment.currency,
      consultantName,
      appointmentType,
      planTitle: resolvedPlanTitle,
      dashboardUrl,
    },
    { tx, dedupeKey: payment.id },
  );
  if (paymentTrigger?.staged) staged.push(paymentTrigger.staged);
  staged.push(
    ...(await stageBookedBells(tx, payment, appointment, appointmentType)),
  );
  return staged;
}

/**
 * The "you're booked" bell to the booker, the host and the presenters. A free
 * seat passes its own key, so a rejoin is not taken for the first registration.
 */
export async function stageBookedBells(
  tx: Tx,
  payment: Booker,
  appointment: AppointmentForEmails,
  appointmentType: string,
  dedupeKey?: string,
): Promise<StagedTrigger[]> {
  const plan = planForEmails(appointment);
  const consultantName = plan?.consultantProfile?.user?.name || "Consultant";
  const consultantUserId = plan?.consultantProfile?.user?.id;
  const resolvedPlanTitle =
    appointmentType === AppointmentsType.TRIAL
      ? "Trial session"
      : planTitleOrSessionLabel(plan?.title ?? null, appointmentType);
  const orgId = appointment.organizationId ?? null;
  const scope = notificationScope(orgId, appointment.organization?.name);
  const dashboardUrl = notificationHref(orgId, "appointments");
  const staged: StagedTrigger[] = [];

  const notifUserIds = [payment.userId];
  if (consultantUserId && consultantUserId !== payment.userId) {
    notifUserIds.push(consultantUserId);
  }
  const collaborators =
    appointment.webinar?.webinarPlan?.collaborators ??
    appointment.class?.classPlan?.collaborators ??
    [];
  for (const collaborator of collaborators) {
    const uid = collaborator.consultantProfile.user.id;
    if (uid && !notifUserIds.includes(uid)) {
      notifUserIds.push(uid);
    }
  }

  const firstSlot = appointment.occurrences?.[0];
  if (!firstSlot?.startsAt) {
    console.log(
      JSON.stringify({
        event: "appointment_booked_notification_skipped_no_slots",
        appointmentId: appointment.id,
        bookerUserId: payment.userId,
        timestamp: new Date().toISOString(),
      }),
    );
  } else {
    const bookedTriggers = await notifyAppointmentBooked(
      notifUserIds,
      {
        ...scope,
        appointmentId: appointment.id,
        dateTime: firstSlot.startsAt.toISOString(),
        appointmentType,
        consultantName,
        consulteeName: payment.user.name || "User",
        planTitle: resolvedPlanTitle,
        dashboardUrl,
      },
      dedupeKey,
      { tx },
    );
    // One staged row comes back per recipient of a batch; return each row once.
    for (const item of bookedTriggers ?? []) {
      if (item?.staged && !staged.some((row) => row.id === item.staged?.id)) {
        staged.push(item.staged);
      }
    }
  }

  return staged;
}
