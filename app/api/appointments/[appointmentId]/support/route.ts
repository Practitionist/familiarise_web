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
import { CaseConflictError } from "@/lib/support/case-transitions";
import { buildSupportContext } from "@/lib/support/context";
import { flowsForContext } from "@/lib/support/flows";
import { AppointmentIdParams, SupportTurnSchema } from "@/schemas/support";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import { assertBodySize } from "@/lib/validation/limits";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, supportTurnLimiter } from "@/lib/rate-limit";
import {
  authorizeAppointment,
  appointmentAuthzError,
} from "@/lib/api/appointment-access";
import { isPresenterAuthoredMessage } from "@/lib/support/case-message-actor";

const SUPPORT_ROUTE = "appointments.support";

const FlowMessageMetadataSchema = z.object({
  nodeId: z.string().optional(),
  options: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        escalates: z.boolean().optional(),
      }),
    )
    .optional(),
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
    // Operators without a second factor get the 2FA 428 like every other support route.
    const session = await requireApiAuth();
    if (session.error) return session.error;
    const auth = await authorizeAppointment(appointmentId, true);
    if ("code" in auth)
      return appointmentAuthzError(auth, {
        route: SUPPORT_ROUTE,
        appointmentId,
      });

    const thread = await prisma.supportCase.findFirst({
      where: {
        appointmentId,
        requesterUserId: auth.userId,
        submitterUserId: auth.userId,
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        referenceNumber: true,
        status: true,
        activeChannel: true,
        category: true,
        flowKey: true,
        currentNodeId: true,
        appointmentOccurrenceId: true,
        requesterUserId: true,
        ackDueAt: true,
        acknowledgedAt: true,
        resolvedAt: true,
        csatRating: true,
        csatAt: true,
        lastMessageAt: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          where: { isInternal: false },
          orderBy: { seq: "asc" },
          take: -201,
          select: {
            id: true,
            seq: true,
            sender: true,
            body: true,
            metadata: true,
            createdAt: true,
          },
        },
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

    const page = thread?.messages.slice(-200) ?? [];
    return NextResponse.json({
      data: thread
        ? {
            ...thread,
            messages: page.map(({ metadata, ...message }) => {
              const flow = FlowMessageMetadataSchema.safeParse(metadata);
              return {
                ...message,
                metadata: flow.success ? flow.data : undefined,
                actorKind: isPresenterAuthoredMessage(metadata)
                  ? ("PRESENTER" as const)
                  : undefined,
              };
            }),
            hasMore: thread.messages.length > 200,
            nextBeforeSeq: page[0]?.seq ?? null,
            userId: thread.requesterUserId,
            supportTicketId:
              thread.activeChannel === "HUMAN" ? thread.id : null,
            supportTicket:
              thread.activeChannel === "HUMAN"
                ? {
                    referenceNumber: thread.referenceNumber,
                    ackDueAt: thread.ackDueAt,
                    acknowledgedAt: thread.acknowledgedAt,
                  }
                : null,
          }
        : null,
      intents,
      booking,
    });
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
    // Operators without a second factor get the 2FA 428 like every other support route.
    const session = await requireApiAuth();
    if (session.error) return session.error;
    const auth = await authorizeAppointment(appointmentId, true);
    if ("code" in auth)
      return appointmentAuthzError(auth, {
        route: SUPPORT_ROUTE,
        appointmentId,
      });

    const limited = await applyRateLimit(
      supportTurnLimiter,
      `appt-turn:${auth.userId}`,
    );
    if (limited) return limited;

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const parsed = SupportTurnSchema.safeParse(
      await req.json().catch(() => ({})),
    );
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

    // A report is about a session of this booking that has already ended.
    const occurrenceId = parsed.data.appointmentOccurrenceId;
    if (
      occurrenceId &&
      !(await prisma.appointmentOccurrence.findFirst({
        where: {
          id: occurrenceId,
          appointmentId,
          deletedAt: null,
          completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
          endsAt: { lte: new Date() },
        },
        select: { id: true },
      }))
    ) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        message: "That session isn't one of this booking's finished sessions.",
        context: {
          route: "appointments.support",
          action: "turn",
          appointmentId,
          occurrenceId,
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
      ? await prisma.supportCase.findUnique({
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
    if (cause instanceof CaseConflictError)
      return NextResponse.json(cause.body, { status: cause.status });
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "appointments.support", action: "turn", appointmentId },
    });
  }
}
