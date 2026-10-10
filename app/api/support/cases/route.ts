import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { isPrivileged, requireApiSession } from "@/lib/auth-helpers";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { supportError } from "@/lib/api/support-http";
import {
  CreateSupportCaseObjectSchema,
  SupportCaseStatusSchema,
  createOrReuseSupportCase,
  refineCreateSupportCaseInput,
} from "@/lib/support/case-service";
import {
  notifyRequesterOfTicket,
  notifySupportStaff,
} from "@/lib/support/create-ticket";

const ALLOWED_ORG_SUBMITTER_ROLES = new Set<string>([
  "OWNER",
  "ADMIN",
  "MAINTAINER",
]);

const ClientCreateCaseBodySchema = CreateSupportCaseObjectSchema.omit({
  submitterUserId: true,
})
  .extend({
    requesterUserId: z.string().min(1).max(64).optional(),
  })
  .superRefine(refineCreateSupportCaseInput);

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiSession();
    if (auth.error) return auth.error;
    const { user } = auth.session;
    const staff = isPrivileged(user.role);

    const parsedStatus = SupportCaseStatusSchema.safeParse(
      req.nextUrl.searchParams.get("status"),
    );
    const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? "50");
    const take = Number.isFinite(limitParam)
      ? Math.min(Math.max(1, limitParam), 100)
      : 50;

    const where = staff
      ? {
          deletedAt: null,
          ...(parsedStatus.success ? { status: parsedStatus.data } : {}),
        }
      : {
          deletedAt: null,
          OR: [{ submitterUserId: user.id }, { requesterUserId: user.id }],
        };

    const cases = await prisma.supportCase.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      take,
      select: {
        id: true,
        referenceNumber: true,
        title: true,
        category: true,
        priority: true,
        status: true,
        caseKind: true,
        requesterUserId: true,
        submitterUserId: true,
        organizationId: true,
        appointmentId: true,
        appointmentOccurrenceId: true,
        callbackPhone: true,
        callbackWindow: true,
        ackDueAt: true,
        acknowledgedAt: true,
        resolutionDueAt: true,
        resolvedAt: true,
        lastMessageAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const data = staff
      ? cases
      : cases.map((row) => {
          if (
            row.requesterUserId !== row.submitterUserId &&
            user.id !== row.submitterUserId
          ) {
            return {
              ...row,
              title: "Organization support request",
              callbackPhone: null,
              callbackWindow: null,
              filedByOrganizationNotice: true as const,
            };
          }
          return row;
        });

    return NextResponse.json({ data });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.cases", action: "list" },
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiSession();
    if (auth.error) return auth.error;
    const { user } = auth.session;
    const staff = isPrivileged(user.role);

    const rl = await applyRateLimit(spamLimiter, `support-cases:${user.id}`);
    if (rl) return rl;

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const parsed = ClientCreateCaseBodySchema.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: "support.cases", action: "create" },
      });
    }

    const requesterUserId = parsed.data.requesterUserId ?? user.id;
    const targetOrgId = parsed.data.organizationId ?? null;

    if (!staff) {
      if (requesterUserId !== user.id) {
        if (!targetOrgId) {
          return supportError({
            status: 403,
            code: "FORBIDDEN",
            context: { route: "support.cases", action: "create" },
          });
        }
        const [submitterMembership, requesterMembership] = await Promise.all([
          prisma.membership.findFirst({
            where: {
              userId: user.id,
              organizationId: targetOrgId,
              status: "ACTIVE",
            },
            select: { role: true },
          }),
          prisma.membership.findFirst({
            where: {
              userId: requesterUserId,
              organizationId: targetOrgId,
              status: "ACTIVE",
            },
            select: { id: true },
          }),
        ]);
        if (
          !submitterMembership ||
          !ALLOWED_ORG_SUBMITTER_ROLES.has(submitterMembership.role) ||
          !requesterMembership
        ) {
          return supportError({
            status: 403,
            code: "FORBIDDEN",
            context: { route: "support.cases", action: "create" },
          });
        }
      } else if (targetOrgId) {
        const submitterMembership = await prisma.membership.findFirst({
          where: {
            userId: user.id,
            organizationId: targetOrgId,
            status: "ACTIVE",
          },
          select: { id: true },
        });
        if (!submitterMembership) {
          return supportError({
            status: 403,
            code: "FORBIDDEN",
            context: { route: "support.cases", action: "create" },
          });
        }
      }

      if (parsed.data.appointmentId) {
        const appt = await prisma.appointment.findUnique({
          where: { id: parsed.data.appointmentId },
          select: {
            id: true,
            organizationId: true,
            participants: { select: { userId: true, organizationId: true } },
            payment: { select: { userId: true } },
          },
        });
        const requesterOnAppointment =
          appt !== null &&
          (appt.participants.some((p) => p.userId === requesterUserId) ||
            appt.payment.some((p) => p.userId === requesterUserId));
        const orgMatchesAppointment =
          appt !== null &&
          targetOrgId !== null &&
          (appt.organizationId === targetOrgId ||
            appt.participants.some((p) => p.organizationId === targetOrgId));
        if (!requesterOnAppointment && !orgMatchesAppointment) {
          return supportError({
            status: 403,
            code: "FORBIDDEN",
            context: { route: "support.cases", action: "create" },
          });
        }
      }
    }

    const result = await createOrReuseSupportCase({
      ...parsed.data,
      requesterUserId,
      submitterUserId: user.id,
    });

    if (!result.reused) {
      const c = result.supportCase;
      await Promise.all([
        notifySupportStaff({
          id: c.id,
          title: c.title,
          organizationId: c.organizationId,
          referenceNumber: c.referenceNumber,
          userId: c.submitterUserId,
        }).catch(() => undefined),
        notifyRequesterOfTicket({
          id: c.id,
          title: c.title,
          referenceNumber: c.referenceNumber,
          userId: c.submitterUserId,
          ackDueAt: c.ackDueAt,
          createdAt: c.createdAt,
          organizationId: c.organizationId,
        }).catch(() => undefined),
      ]);
    }

    return NextResponse.json(
      {
        data: result.supportCase,
        reused: result.reused,
        dedupeReason: result.dedupeReason,
      },
      { status: result.reused ? 200 : 201 },
    );
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.cases", action: "create" },
    });
  }
}
