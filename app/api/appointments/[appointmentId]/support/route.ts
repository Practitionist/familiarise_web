/**
 * #appt-support — per-appointment support thread. GET loads this user's thread +
 * messages; POST advances it one turn through the active resolver. Authz is the
 * same participation check the appointment-detail route uses (capability, not
 * UserRole), plus platform ADMIN/STAFF, plus (#support-hub) the org-party
 * branch: an org OPERATOR may open their OWN conversation on their org's
 * appointment, restricted to the org-party intents — never anyone else's
 * transcript (ADR 20).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { runSupportTurn, ORG_PARTY_CATEGORIES } from "@/lib/support/service";
import { buildSupportContext } from "@/lib/support/context";
import { flowsForContext } from "@/lib/support/flows";
import { MESSAGE_ORDER } from "@/lib/support/message-seq";
import { AppointmentIdParams } from "@/schemas/support";
import { SupportThreadCategoryEnum } from "@/schemas/enums";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import {
  spamLimiter,
  supportTurnLimiter,
  applyRateLimit,
} from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { stripCallbackTags } from "@/lib/validation/phone";
import {
  authorizeAppointment,
  appointmentAuthzError,
} from "@/lib/api/appointment-access";

const SUPPORT_ROUTE = "appointments.support";

const CATEGORY = SupportThreadCategoryEnum;

const turnSchema = z
  .object({
    category: CATEGORY.optional(),
    chosenOptionId: z.string().max(200).optional(),
    userMessage: z
      .string()
      .transform((s) => stripCallbackTags(s).trim())
      .pipe(z.string().max(2000))
      .optional(),
    urgent: z.boolean().optional(),
  })
  .refine((v) => v.category || v.chosenOptionId || v.userMessage, {
    message: "A turn needs a category, a chosen option, or a message",
  });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const id = await parseRouteParams(AppointmentIdParams, params, {
    route: SUPPORT_ROUTE,
  });
  if (!id.ok) return id.response;
  const { appointmentId } = id.data;
  try {
    const auth = await authorizeAppointment(appointmentId, true);
    if ("code" in auth)
      return appointmentAuthzError(auth, {
        route: SUPPORT_ROUTE,
        appointmentId,
      });

    const thread = await prisma.appointmentSupportThread.findUnique({
      where: { appointmentId_userId: { appointmentId, userId: auth.userId } },
      include: {
        messages: { orderBy: MESSAGE_ORDER },
        supportTicket: { select: { referenceNumber: true, ackDueAt: true } },
      },
    });

    let intents: { category: string; title: string; escalates?: boolean }[] =
      [];
    let booking: {
      title: string | null;
      kind: string;
      startsAt: Date | null;
      organizationId: string | null;
    } | null = null;
    try {
      const ctx = await buildSupportContext(
        thread?.id ?? "unstarted",
        appointmentId,
        auth.userId,
      );
      if (ctx) {
        booking = {
          title: ctx.planTitle,
          kind: ctx.appointmentType,
          startsAt: ctx.startsAt,
          organizationId: ctx.organizationId,
        };
        intents = flowsForContext(ctx)
          .filter(
            (f) => !auth.isOrgParty || ORG_PARTY_CATEGORIES.has(f.category),
          )
          .map((f) => ({ category: f.category, title: f.title }));
        if (!auth.isOrgParty) {
          intents.push({
            category: "OTHER",
            title: "Talk to a person",
            escalates: true,
          });
        }
      }
    } catch (cause) {
      Sentry.captureException(cause, {
        tags: { subsystem: "support", code: "INTENTS_DEGRADED" },
        extra: { route: SUPPORT_ROUTE, appointmentId },
        level: "warning",
      });
    }

    return NextResponse.json({ data: thread, intents, booking });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "appointments.support", action: "get", appointmentId },
    });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const id = await parseRouteParams(AppointmentIdParams, params, {
    route: SUPPORT_ROUTE,
  });
  if (!id.ok) return id.response;
  const { appointmentId } = id.data;
  try {
    const auth = await authorizeAppointment(appointmentId, true);
    if ("code" in auth)
      return appointmentAuthzError(auth, {
        route: SUPPORT_ROUTE,
        appointmentId,
      });

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const parsed = turnSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: {
          route: "appointments.support",
          action: "turn",
          appointmentId,
        },
      });
    }

    const existingThread = await prisma.appointmentSupportThread.findUnique({
      where: { appointmentId_userId: { appointmentId, userId: auth.userId } },
      select: { activeChannel: true },
    });
    const onHumanChannel = existingThread?.activeChannel === "HUMAN";
    const mayEscalate =
      !onHumanChannel &&
      (Boolean(parsed.data.userMessage) ||
        parsed.data.chosenOptionId === "human" ||
        parsed.data.category === "OTHER");
    const rl = await applyRateLimit(
      mayEscalate ? spamLimiter : supportTurnLimiter,
      `appt-support:${auth.userId}`,
    );
    if (rl) return rl;

    if (
      auth.isOrgParty &&
      parsed.data.category &&
      !ORG_PARTY_CATEGORIES.has(parsed.data.category)
    ) {
      return supportError({
        status: 403,
        code: "FORBIDDEN",
        context: {
          route: "appointments.support",
          action: "turn",
          appointmentId,
          attemptedCategory: parsed.data.category,
        },
      });
    }

    const result = await runSupportTurn(appointmentId, auth.userId, {
      ...parsed.data,
      isOrgParty: auth.isOrgParty,
    });
    if (!result) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        context: {
          route: "appointments.support",
          action: "turn",
          appointmentId,
        },
      });
    }

    const linkedTicket = result.supportTicketId
      ? await prisma.supportTicket.findUnique({
          where: { id: result.supportTicketId },
          select: { ackDueAt: true },
        })
      : null;

    const replyByAt = linkedTicket?.ackDueAt
      ? linkedTicket.ackDueAt.toISOString()
      : null;
    const outcomeId = result.outcomeId ?? null;

    return NextResponse.json({
      data: {
        ...result,
        outcomeId,
        replyByAt,
      },
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "appointments.support", action: "turn", appointmentId },
    });
  }
}
