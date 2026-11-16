import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { PaymentLinkEmail } from "@/emails/payments/PaymentLinkEmail";
import { deliver, EMAIL_BUDGET_MS, emailPayUrl, SENDERS } from "@/lib/email";
import { renderEmail } from "@/lib/email/render";
import { apiError, isRefusal, Refusal } from "@/lib/errors";
import { reportSentryError } from "@/lib/observability/report";
import { notifyPaymentLink } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { remindLimiter } from "@/lib/rate-limit";
import { refuseMalformedEventId } from "@/lib/booking/request-route-guards";
import { liveReminderPayment } from "@/lib/booking/payment-reminder-eligibility";

/**
 * #1775 — the consultant nudges a consultee who has an unpaid approval. The
 * live pay link is re-sent as it is (`pendingPaymentUrl`, the open order's
 * amount and expiry); nothing is minted. Once per 24 h per appointment, and
 * its outbox row carries its OWN email type so the sweep's automatic
 * half-window reminder (`PAYMENT_LINK_REMINDER`) and this manual one never
 * dedupe each other.
 */
export const PAYMENT_LINK_MANUAL_REMINDER_EMAIL_TYPE =
  "PAYMENT_LINK_MANUAL_REMINDER";

export interface RemindActor {
  userId: string;
  consultantProfileId: string | null | undefined;
  privileged: boolean;
}

const REMIND_SELECT = {
  id: true,
  status: true,
  pendingPaymentUrl: true,
  requestedBy: {
    select: { user: { select: { id: true, name: true, email: true } } },
  },
  appointment: {
    select: {
      id: true,
      deletedAt: true,
      organizationId: true,
      organization: { select: { name: true } },
      payment: {
        where: { paymentStatus: PaymentStatus.PENDING, deletedAt: null },
        orderBy: { createdAt: "desc" as const },
        take: 1,
        select: {
          id: true,
          amount: true,
          currency: true,
          expiresAt: true,
          createdAt: true,
          paymentStatus: true,
        },
      },
    },
  },
} as const;
const REMIND_PLAN_SELECT = {
  select: {
    title: true,
    consultantProfileId: true,
    consultantProfile: { select: { user: { select: { name: true } } } },
  },
} as const;

const REMIND_WINDOW_MS = 24 * 60 * 60 * 1000;

function remindRateLimited(nextAllowedAt: Date): Refusal {
  return new Refusal({
    code: "REMIND_RATE_LIMITED",
    httpStatus: 429,
    userMessage: "A reminder was already sent in the last 24 hours.",
    context: { nextAllowedAt: nextAllowedAt.toISOString() },
  });
}

function notAwaitingPayment(id: string): Refusal {
  return new Refusal({
    code: "NOT_AWAITING_PAYMENT",
    userMessage:
      "There is no open payment link to remind about. It may have expired or already been paid.",
    devMessage: `consultation ${id} has no live pay link to remind about`,
  });
}

/**
 * 404 / 403 / 409 `NOT_AWAITING_PAYMENT` / 429 `REMIND_RATE_LIMITED` as typed
 * refusals; the 429 carries `nextAllowedAt` in its context. Resolves to the
 * next allowed instant, which the response echoes.
 */
export async function remindApprovedPayment(args: {
  id: string;
  actor: RemindActor;
}): Promise<{ nextAllowedAt: Date }> {
  // Only a 1:1 awaits payment after approval; a plan is paid at checkout.
  const row = await prisma.consultation.findUnique({
    where: { id: args.id },
    select: { ...REMIND_SELECT, consultationPlan: REMIND_PLAN_SELECT },
  });
  if (!row)
    throw new Refusal({
      code: "NOT_FOUND",
      httpStatus: 404,
      userMessage: "This request no longer exists.",
    });
  const plan = row.consultationPlan;
  const owns =
    !!args.actor.consultantProfileId &&
    plan?.consultantProfileId === args.actor.consultantProfileId;
  if (!owns && !args.actor.privileged)
    throw new Refusal({
      code: "FORBIDDEN",
      httpStatus: 403,
      userMessage: "Only the consultant who approved this request can remind.",
    });

  const now = new Date();
  // A soft-deleted booking or order is gone, as the abandoned-payment sweep reads it.
  const payment = row.appointment?.deletedAt
    ? null
    : liveReminderPayment(row, now);
  if (!payment || !row.appointment || !row.pendingPaymentUrl) {
    throw notAwaitingPayment(args.id);
  }
  const consultee = row.requestedBy?.user;
  if (!consultee?.email) throw notAwaitingPayment(args.id);

  // Once per 24 h, measured from the last manual reminder's own outbox row
  // (state-as-outbox, ADR 27): the Upstash window reports `reset` on the UTC
  // day bucket, so it read "next in 4 h" right after a first send. The
  // limiter stays underneath as the same-second burst guard, keyed by
  // appointment; it fails open like `applyRateLimit`, but reported.
  const lastManual = await prisma.failedEmail.findFirst({
    where: {
      emailType: PAYMENT_LINK_MANUAL_REMINDER_EMAIL_TYPE,
      entityRef: `payment:${payment.id}`,
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const nextAllowedAt = new Date(
    (lastManual ? lastManual.createdAt.getTime() : now.getTime()) +
      REMIND_WINDOW_MS,
  );
  if (nextAllowedAt > now && lastManual) throw remindRateLimited(nextAllowedAt);
  try {
    const { success } = await remindLimiter.limit(row.appointment.id);
    if (!success) throw remindRateLimited(nextAllowedAt);
  } catch (error) {
    if (isRefusal(error)) throw error;
    reportSentryError(error, {
      subsystem: "bookings",
      op: "remind-limiter",
      expected: true,
      level: "warning",
    });
  }

  const consultantName = plan?.consultantProfile?.user?.name ?? "Consultant";
  const paymentUrl = emailPayUrl(payment.id, row.pendingPaymentUrl);
  // The approval's own template and envelope, under the manual email type.
  const rendered = await renderEmail(
    PaymentLinkEmail({
      name: consultee.name ?? "User",
      consultantName,
      appointmentType: "consultation",
      amount: payment.amount,
      currency: payment.currency,
      // #1775 P-1 — the stored link is an order id on Razorpay.
      paymentUrl,
      expiresAt: payment.expiresAt.toISOString(),
      reminder: true,
    }),
  );
  const message = {
    from: SENDERS.payments,
    to: consultee.email,
    subject: `Reminder: payment due - Consultation with ${consultantName}`,
    ...rendered,
  };
  const [, bellResult] = await Promise.all([
    deliver(message, PAYMENT_LINK_MANUAL_REMINDER_EMAIL_TYPE, {
      entityRef: `payment:${payment.id}`,
      budgetMs: EMAIL_BUDGET_MS.REQUEST,
    }),
    Promise.resolve(
      notifyPaymentLink(
        consultee.id,
        {
          ...notificationScope(
            row.appointment.organizationId,
            row.appointment.organization?.name,
          ),
          paymentId: payment.id,
          appointmentId: row.appointment.id,
          amount: payment.amount,
          currency: payment.currency,
          consultantName,
          appointmentType: "CONSULTATION",
          planTitle: plan?.title,
          paymentUrl,
          expiresAt: payment.expiresAt,
          reminder: true,
        },
        `payment-link-remind:${payment.id}:${Math.floor(now.getTime() / REMIND_WINDOW_MS)}`,
        { deferAttempt: true },
      ),
    ).catch(() => null),
  ]);
  await flushNotificationsAfter(
    {
      bells: [bellResult?.staged],
    },
    "remind-payment.bell",
  );
  return { nextAllowedAt };
}

/**
 * The route body after auth and the mutation limiter (the routes' own, so
 * the auth server never rides into this module's importers). The contract
 * PR-A consumes: 200 `{ nextAllowedAt }` or 429
 * `{ code: "REMIND_RATE_LIMITED", nextAllowedAt }`, both `no-store`.
 */
export async function remindPaymentResponse(
  id: string,
  actor: RemindActor,
): Promise<NextResponse> {
  const noStore = { "Cache-Control": "no-store" };
  try {
    const malformedId = refuseMalformedEventId(id);
    if (malformedId) return malformedId;
    const { nextAllowedAt } = await remindApprovedPayment({ id, actor });
    return NextResponse.json(
      { nextAllowedAt: nextAllowedAt.toISOString() },
      { headers: noStore },
    );
  } catch (error) {
    if (isRefusal(error) && error.code === "REMIND_RATE_LIMITED") {
      const nextAllowedAt = String(error.context?.nextAllowedAt);
      const retryAfter = Math.max(
        1,
        Math.ceil((Date.parse(nextAllowedAt) - Date.now()) / 1000),
      );
      return NextResponse.json(
        { error: error.userMessage, code: error.code, nextAllowedAt },
        {
          status: 429,
          headers: { ...noStore, "Retry-After": String(retryAfter) },
        },
      );
    }
    return apiError({ tag: "[Bookings.consultation.Remind]", error });
  }
}
